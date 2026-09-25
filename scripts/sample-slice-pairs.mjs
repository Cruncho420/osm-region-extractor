/**
 * PURPOSE: Draw reproducible cross-piece route pairs for a split country, so the parity check
 *   (compare-slice-routes.mjs) covers every border by sample rather than by a hand-picked few.
 * RESPONSIBILITY: Seeded random start points inside the pieces' outlines, an end point 15-150 km
 *   away in a DIFFERENT piece, both snapped to a drivable road of the whole graph (Valhalla
 *   `locate`, the same pinned engine), then spread round-robin over the piece borders. Each pair
 *   says `pieces: "auto"`: the comparison decides which pieces the route needs from its own shape.
 * DEPENDENCIES: Node built-ins; docker with the digest-pinned Valhalla image; the slicer's outline
 *   helpers.
 * CONSUMERS: routing-pieces-release.yml.
 *
 * Usage: node sample-slice-pairs.mjs --slices region-slices.json --country <id> --polys <dir>
 *   --tiles <whole graph> --config <valhalla.json> --image <ref> --work <dir> --count 45 --seed 1
 *   --out <pairs.json>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { insideOutline, prepareOutline } from './slice-valhalla-graph.mjs';

const SNAP_CUTOFF_M = 25_000; // start points are random; snap them to the nearest drivable road
const LOCATE_BATCH = 20; // Valhalla's default per-request location limit

/** mulberry32: a tiny seeded PRNG, so the same seed draws the same pairs. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first piece whose outline holds [lon, lat], or null. */
export function pieceAt(point, pieces) {
  for (const p of pieces) {
    const inBox = p.outline.some((r) => !r.exclude && point[0] >= r.box[0] && point[0] <= r.box[2]
      && point[1] >= r.box[1] && point[1] <= r.box[3]);
    if (inBox && insideOutline(point, p.outline)) return p.id;
  }
  return null;
}

function offset([lon, lat], bearing, km) {
  const dLat = (km * Math.cos(bearing)) / 111.32;
  const dLon = (km * Math.sin(bearing)) / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lon + dLon, lat + dLat];
}

export function km([lon1, lat1], [lon2, lat2]) {
  const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lat2 - lat1) * 111.32, (lon2 - lon1) * 111.32 * k);
}

/** Raw [A, B] candidates: A in piece P, B 15-150 km away in piece Q != P. */
export function drawCandidates(pieces, rand, want, maxTries = 2_000_000) {
  const boxes = pieces.flatMap((p) => p.outline.filter((r) => !r.exclude).map((r) => r.box));
  const [minX, minY, maxX, maxY] = boxes.reduce(([a, b, c, d], [e, f, g, h]) =>
    [Math.min(a, e), Math.min(b, f), Math.max(c, g), Math.max(d, h)], [Infinity, Infinity, -Infinity, -Infinity]);
  const out = [];
  for (let i = 0; i < maxTries && out.length < want; i++) {
    const a = [minX + rand() * (maxX - minX), minY + rand() * (maxY - minY)];
    const pa = pieceAt(a, pieces);
    if (!pa) continue;
    const b = offset(a, rand() * 2 * Math.PI, 15 + rand() * 135);
    const pb = pieceAt(b, pieces);
    if (pb && pb !== pa) out.push([a, b]);
  }
  return out;
}

/** Keep snapped pairs that still cross a border, then take them round-robin per border. */
export function selectPairs(snapped, pieces, count) {
  const byBorder = new Map();
  for (const [a, b] of snapped) {
    if (!a || !b) continue;
    const pa = pieceAt(a, pieces); const pb = pieceAt(b, pieces);
    if (!pa || !pb || pa === pb || km(a, b) < 10) continue;
    const key = [pa, pb].sort().join(' | ');
    if (!byBorder.has(key)) byBorder.set(key, []);
    byBorder.get(key).push([a, b, pa, pb]);
  }
  const lists = [...byBorder.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, l]) => l);
  const out = [];
  for (let round = 0; out.length < count && lists.some((l) => l.length > round); round++) {
    for (const l of lists) if (l[round] && out.length < count) out.push(l[round]);
  }
  return out.map(([a, b, pa, pb], i) => ({
    name: `sample ${i + 1}: ${pa} -> ${pb} (${Math.round(km(a, b))} km)`,
    from: [a[1], a[0]], to: [b[1], b[0]], pieces: 'auto',
  }));
}

function locate(image, config, tiles, work, points) {
  const cfg = JSON.parse(readFileSync(config, 'utf8'));
  cfg.mjolnir.tile_dir = '/tiles';
  delete cfg.mjolnir.tile_extract;
  writeFileSync(join(work, 'locate-config.json'), JSON.stringify(cfg));
  const out = [];
  for (let i = 0; i < points.length; i += LOCATE_BATCH) {
    const request = JSON.stringify({ costing: 'auto', locations: points.slice(i, i + LOCATE_BATCH)
      .map(([lon, lat]) => ({ lat, lon, search_cutoff: SNAP_CUTOFF_M })) });
    let stdout = '';
    try {
      stdout = execFileSync('docker', ['run', '--rm', '-v', `${tiles}:/tiles:ro`, '-v', `${work}:/work:ro`, image,
        'valhalla_service', '/work/locate-config.json', 'locate', request],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
    } catch (error) { stdout = String(error.stdout ?? ''); }
    const line = stdout.split('\n').filter((l) => l.startsWith('[')).pop();
    const rows = line ? JSON.parse(line) : [];
    for (let j = 0; j < Math.min(LOCATE_BATCH, points.length - i); j++) {
      const e = rows[j]?.edges?.[0];
      out.push(e ? [e.correlated_lon, e.correlated_lat] : null);
    }
  }
  return out;
}

function main() {
  const { values: a } = parseArgs({ options: Object.fromEntries(
    ['slices', 'country', 'polys', 'tiles', 'config', 'image', 'work', 'count', 'seed', 'out'].map((k) => [k, { type: 'string' }])) });
  const country = JSON.parse(readFileSync(a.slices, 'utf8')).countries.find((c) => c.country === a.country);
  if (!country) throw new Error(`Country ${a.country} not in ${a.slices}`);
  const pieces = country.pieces.map(({ id }) => ({ id, outline: prepareOutline(readFileSync(join(a.polys, `${id}.poly`), 'utf8')) }));
  const count = Number(a.count ?? 45);
  mkdirSync(a.work, { recursive: true });
  // 6x candidates: in forest, desert and tundra most random points find no road within 25 km.
  const raw = drawCandidates(pieces, prng(Number(a.seed ?? 1)), count * 6);
  const snapped = locate(a.image, a.config, a.tiles, a.work, raw.flat());
  const pairs = selectPairs(raw.map((_, i) => [snapped[2 * i], snapped[2 * i + 1]]), pieces, count);
  writeFileSync(a.out, `${JSON.stringify(pairs, null, 1)}\n`);
  console.log(`${pairs.length} pairs from ${raw.length} candidates`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
