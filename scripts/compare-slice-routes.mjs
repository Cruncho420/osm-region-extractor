/**
 * PURPOSE: Prove that neighbouring region-slice routing packs route across their border
 *   exactly like the whole-country graph they were cut from.
 * RESPONSIBILITY: Combine pieces into ONE tile directory the way the phone installs them
 *   (shared path => identical bytes or refuse; index.bin is per-pack, not part of the union),
 *   route each pair on that union and on the whole graph with the same pinned engine, and
 *   list every difference: success, road shape (Hausdorff, metres), maneuvers, roundabout exits.
 * DEPENDENCIES: Node built-ins; docker with the digest-pinned Valhalla image.
 * CONSUMERS: region-slices-pilot.yml (runner), the Mac proof in Rods REGION-SLICE-pilot.md.
 *
 * Usage: node compare-slice-routes.mjs --whole <tiles> --pieces-root <dir with <id>/ tiles>
 *   --pairs <pairs.json> --config <valhalla.json> --image <ref> --work <dir> --out <report.json>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SEARCH_CUTOFF_M = 450; // Rods valhallaRoutingProvider SNAP_RADIUS_MAX_M, sent on every location

export function decodePolyline6(text) {
  const points = []; let index = 0; let lat = 0; let lon = 0;
  while (index < text.length) {
    for (const axis of [0, 1]) {
      let shift = 0; let result = 0; let byte;
      do { byte = text.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lon += delta;
    }
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}

function metres([lat1, lon1], [lat2, lon2]) {
  const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lat2 - lat1) * 111_320, (lon2 - lon1) * 111_320 * k);
}

function pointToSegment(p, a, b) {
  const k = Math.cos(p[0] * Math.PI / 180);
  const [ax, ay, bx, by, px, py] = [a[1] * k, a[0], b[1] * k, b[0], p[1] * k, p[0]];
  const dx = bx - ax; const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111_320;
}

/** Directed max distance from each point of a to the polyline b (windowed: the two lines follow each other). */
function directedHausdorff(a, b) {
  let worst = 0; let j = 0;
  for (let i = 0; i < a.length; i++) {
    const guess = Math.round((i / Math.max(1, a.length - 1)) * (b.length - 1));
    let best = Infinity;
    for (let k = Math.max(1, Math.min(j, guess) - 400); k < Math.min(b.length, Math.max(j, guess) + 400); k++) {
      const d = pointToSegment(a[i], b[k - 1], b[k]);
      if (d < best) { best = d; j = k; }
    }
    if (b.length === 1) best = metres(a[i], b[0]);
    worst = Math.max(worst, best);
  }
  return worst;
}

export function compareTrips(whole, union) {
  const shapeA = whole.trip.legs.flatMap((l) => decodePolyline6(l.shape));
  const shapeB = union.trip.legs.flatMap((l) => decodePolyline6(l.shape));
  const identicalShape = JSON.stringify(shapeA) === JSON.stringify(shapeB);
  const hausdorffM = identicalShape ? 0 : Math.max(directedHausdorff(shapeA, shapeB), directedHausdorff(shapeB, shapeA));
  const key = (m) => ({ type: m.type, exit: m.roundabout_exit_count ?? null, streets: m.street_names ?? [] });
  const ma = whole.trip.legs.flatMap((l) => l.maneuvers.map(key));
  const mb = union.trip.legs.flatMap((l) => l.maneuvers.map(key));
  const maneuverDiffs = [];
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    if (JSON.stringify(ma[i]) !== JSON.stringify(mb[i])) maneuverDiffs.push({ index: i, whole: ma[i] ?? null, union: mb[i] ?? null });
  }
  return { identicalShape, hausdorffM: Number(hausdorffM.toFixed(3)), maneuvers: ma.length,
    roundabouts: ma.filter((m) => m.exit !== null).length, maneuverDiffs,
    lengthKm: [whole.trip.summary.length, union.trip.summary.length],
    timeS: [whole.trip.summary.time, union.trip.summary.time] };
}

const digests = new Map();
function sha(path) {
  if (!digests.has(path)) digests.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'));
  return digests.get(path);
}

function walk(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(root, rel) : rel.endsWith('.gph') ? [rel] : [];
  });
}

/** Phone rule (Rods ValhallaGenerationStage union): a path shared by two packs must be byte-identical. */
export function buildUnion(pieceDirs, target) {
  rmSync(target, { recursive: true, force: true });
  const seen = new Map();
  for (const dir of pieceDirs) {
    for (const rel of walk(dir)) {
      const digest = sha(join(dir, rel));
      if (seen.has(rel)) {
        if (seen.get(rel) !== digest) throw new Error(`Refused: ${rel} differs between packs`);
        continue;
      }
      seen.set(rel, digest);
      mkdirSync(dirname(join(target, rel)), { recursive: true });
      linkSync(join(dir, rel), join(target, rel));
    }
  }
  return seen.size;
}

function route(image, config, tilesDir, work, pair) {
  const cfg = JSON.parse(readFileSync(config, 'utf8'));
  cfg.mjolnir.tile_dir = '/tiles';
  delete cfg.mjolnir.tile_extract; // tile_dir mode, as the phone's connected generation runs
  writeFileSync(join(work, 'route-config.json'), JSON.stringify(cfg));
  const request = JSON.stringify({
    locations: [pair.from, pair.to].map(([lat, lon]) => ({ lat, lon, type: 'break', search_cutoff: SEARCH_CUTOFF_M })),
    costing: 'auto', costing_options: { auto: { use_ferry: 0 } }, units: 'kilometers' });
  let stdout = '';
  try {
    stdout = execFileSync('docker', ['run', '--rm', '-v', `${tilesDir}:/tiles:ro`, '-v', `${work}:/work:ro`, image,
      'valhalla_service', '/work/route-config.json', 'route', request], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } catch (error) { stdout = String(error.stdout ?? ''); }
  const line = stdout.split('\n').filter((l) => l.startsWith('{')).pop();
  const body = line ? JSON.parse(line) : null;
  return body?.trip?.legs?.length ? body : { error: body?.error ?? 'no route', error_code: body?.error_code ?? null };
}

function main() {
  const { values: a } = parseArgs({ options: Object.fromEntries(
    ['whole', 'pieces-root', 'pairs', 'config', 'image', 'work', 'out'].map((k) => [k, { type: 'string' }])) });
  mkdirSync(a.work, { recursive: true });
  const results = []; const unions = new Map();
  for (const pair of JSON.parse(readFileSync(a.pairs, 'utf8'))) {
    // One union directory per piece combination, built once (hashing a country is minutes).
    const combo = [...pair.pieces].sort().join('+');
    const unionDir = join(a.work, 'unions', combo);
    if (!unions.has(combo)) unions.set(combo, buildUnion(pair.pieces.map((id) => join(a['pieces-root'], id)), unionDir));
    const tiles = unions.get(combo);
    const whole = route(a.image, a.config, a.whole, a.work, pair);
    const union = route(a.image, a.config, unionDir, a.work, pair);
    const row = { name: pair.name, pieces: pair.pieces, expect: pair.expect ?? 'same', unionTiles: tiles,
      wholeOk: !whole.error, unionOk: !union.error, unionError: union.error ?? null };
    if (!whole.error && !union.error) Object.assign(row, compareTrips(whole, union));
    row.pass = row.expect === 'fail'
      ? row.wholeOk && !row.unionOk
      : row.wholeOk && row.unionOk && row.hausdorffM <= 1 && row.maneuverDiffs.length === 0;
    results.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${pair.name}: ${JSON.stringify({ ...row, maneuverDiffs: row.maneuverDiffs?.length })}`);
  }
  rmSync(join(a.work, 'unions'), { recursive: true, force: true });
  writeFileSync(a.out, `${JSON.stringify(results, null, 1)}\n`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
