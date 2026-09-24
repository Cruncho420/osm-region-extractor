/**
 * PURPOSE: Cut ONE country's Valhalla graph build into region-slice routing packs.
 * RESPONSIBILITY: Put each graph tile into every piece whose outline touches it (so border
 *   tiles are shared, byte-identical, by both neighbours), give a tile that touches no outline
 *   to the nearest piece (so the union of all pieces is exactly the whole graph), hard-link
 *   the tiles into one directory per piece and write a per-piece tile inventory.
 * DEPENDENCIES: Node built-ins; parseGeofabrikPoly from generate-valhalla-coverage.mjs.
 * CONSUMERS: region-slices-pilot.yml; slice-valhalla-graph.test.mjs.
 *
 * Why whole tiles and shared borders: the phone installs pieces into ONE tile directory and
 * refuses a duplicate path with different bytes (Rods ValhallaGenerationStage). Pieces cut
 * from one build are identical where they overlap, so two neighbours route across their
 * border exactly as the whole graph does, as long as the route stays inside their union.
 */
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseGeofabrikPoly } from './generate-valhalla-coverage.mjs';

// Valhalla tile hierarchy (baldr/tilehierarchy.cc): level -> tile size in degrees.
const TILE_DEGREES = { 0: 4, 1: 1, 2: 0.25 };

/** "2/000/745/123.gph" -> [minLon, minLat, maxLon, maxLat] */
export function tileBounds(relative) {
  const match = /^([012])\/((?:\d{3}\/)*\d{3})\.gph$/.exec(relative);
  if (!match) throw new Error(`Unexpected tile path ${relative}`);
  const level = Number(match[1]);
  const size = TILE_DEGREES[level];
  const id = Number(match[2].replaceAll('/', ''));
  const columns = 360 / size;
  const minLon = -180 + (id % columns) * size;
  const minLat = -90 + Math.floor(id / columns) * size;
  return [minLon, minLat, minLon + size, minLat + size];
}

function segmentHitsBox([x1, y1], [x2, y2], [minX, minY, maxX, maxY]) {
  // Liang-Barsky clip: does the segment enter the box at all?
  let t0 = 0; let t1 = 1;
  const dx = x2 - x1; const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - minX], [dx, maxX - x1], [-dy, y1 - minY], [dy, maxY - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Geofabrik semantics: inside any include ring and no exclude ring. */
export function insideOutline(point, outline) {
  return outline.some((r) => !r.exclude && insideRing(point, r.coordinates)) &&
    !outline.some((r) => r.exclude && insideRing(point, r.coordinates));
}

export function prepareOutline(text) {
  return parseGeofabrikPoly(text).map((ring) => {
    // reduce, not Math.min(...xs): a big province ring overflows the argument stack.
    const box = ring.coordinates.reduce(([a, b, c, d], [x, y]) =>
      [Math.min(a, x), Math.min(b, y), Math.max(c, x), Math.max(d, y)], [Infinity, Infinity, -Infinity, -Infinity]);
    return { ...ring, box };
  });
}

/**
 * Does the outline's area touch the box? Conservative on purpose: any ring edge crossing
 * the box counts (a hole edge too), so a tile is never wrongly left out of a piece; the
 * cost of a false "yes" is one extra shared tile.
 */
export function outlineTouchesBox(outline, box) {
  const [minX, minY, maxX, maxY] = box;
  for (const ring of outline) {
    const [a, b, c, d] = ring.box;
    if (a > maxX || c < minX || b > maxY || d < minY) continue;
    const pts = ring.coordinates;
    for (let i = 1; i < pts.length; i++) if (segmentHitsBox(pts[i - 1], pts[i], box)) return true;
    if (!ring.exclude && pts[0][0] >= minX && pts[0][0] <= maxX && pts[0][1] >= minY && pts[0][1] <= maxY) return true;
  }
  return insideOutline([(minX + maxX) / 2, (minY + maxY) / 2], outline);
}

function distanceToOutline([x, y], outline) {
  let best = Infinity;
  for (const ring of outline) {
    const pts = ring.coordinates;
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1]; const [x2, y2] = pts[i];
      const dx = x2 - x1; const dy = y2 - y1;
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy))) : 0;
      best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
  }
  return best;
}

/** pieces: [{id, outline}] -> { assignments: Map(tile -> [pieceIds]), orphans: [tiles given to nearest] } */
export function assignTiles(tiles, pieces) {
  const assignments = new Map(); const orphans = [];
  for (const tile of tiles) {
    const box = tileBounds(tile);
    let owners = pieces.filter((p) => outlineTouchesBox(p.outline, box)).map((p) => p.id);
    if (!owners.length) {
      const centre = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const nearest = pieces.map((p) => [distanceToOutline(centre, p.outline), p.id]).sort((a, b) => a[0] - b[0])[0];
      owners = [nearest[1]];
      orphans.push(tile);
    }
    assignments.set(tile, owners);
  }
  return { assignments, orphans };
}

function listTiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTiles(root, rel));
    else if (rel.endsWith('.gph')) out.push(rel);
  }
  return out.sort();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function slice({ tilesDir, pieces, outDir }) {
  const tiles = listTiles(tilesDir);
  if (!tiles.length) throw new Error('No graph tiles found');
  const { assignments, orphans } = assignTiles(tiles, pieces);
  const report = { tileCount: tiles.length, orphanTiles: orphans, pieces: {} };
  const inventories = Object.fromEntries(pieces.map((p) => [p.id, {}]));
  for (const tile of tiles) {
    const source = join(tilesDir, tile);
    const pin = { bytes: statSync(source).size, sha256: sha256File(source) };
    for (const id of assignments.get(tile)) {
      const target = join(outDir, id, tile);
      mkdirSync(dirname(target), { recursive: true });
      linkSync(source, target);
      inventories[id][tile] = pin;
    }
  }
  for (const { id } of pieces) {
    const own = Object.entries(inventories[id]);
    const shared = own.filter(([tile]) => assignments.get(tile).length > 1).length;
    const perLevel = { 0: 0, 1: 0, 2: 0 };
    for (const [tile] of own) perLevel[tile[0]]++;
    report.pieces[id] = { tiles: own.length, sharedTiles: shared, perLevel,
      tileBytes: own.reduce((sum, [, pin]) => sum + pin.bytes, 0) };
    writeFileSync(join(outDir, `${id}.tiles.json`), `${JSON.stringify(inventories[id])}\n`);
  }
  return report;
}

function main() {
  const { values: args } = parseArgs({ options: Object.fromEntries(
    ['slices', 'country', 'polys', 'tiles', 'out'].map((k) => [k, { type: 'string' }])) });
  const config = JSON.parse(readFileSync(args.slices, 'utf8'));
  const country = config.countries.find((c) => c.country === args.country);
  if (!country) throw new Error(`Country ${args.country} not in ${args.slices}`);
  const pieces = country.pieces.map((p) => ({
    id: p.id, outline: prepareOutline(readFileSync(join(args.polys, `${p.id}.poly`), 'utf8')) }));
  const report = slice({ tilesDir: args.tiles, pieces, outDir: args.out });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
