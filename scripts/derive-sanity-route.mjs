#!/usr/bin/env node
/**
 * derive-sanity-route.mjs — generate a region's sanity-route endpoints from the
 * tiles that were JUST built, instead of hardcoding city pairs.
 *
 * PURPOSE: Give every one of the 234 regions a sanity route, so the
 *   valhalla-tiles gate can verify any pack rather than only the 4 that happen
 *   to have a hand-written entry.
 * RESPONSIBILITY: Endpoint DERIVATION only. It never decides pass/fail — the
 *   workflow still routes the pair and judges the result.
 * DEPENDENCIES: docker + the region's own valhalla config/tiles; scripts/regions.json.
 * CONSUMERS: .github/workflows/valhalla-tiles.yml (meta step).
 *
 * ── Why derive from the TILES and not from {region}.sqlite ──────────────────
 * The obvious source is the region's OSM SQLite `road_ways` table. Three
 * problems: the valhalla-tiles job never downloads it (it builds from the PBF),
 * so it would have to fetch a ~200 MB asset per region purely to pick two
 * points; that asset is produced by a DIFFERENT workflow, so the two could be
 * built from different OSM vintages and the "sanity" pair might name a road the
 * tiles do not contain; and it couples two jobs whose success must stay
 * independent.
 *
 * Valhalla's own `locate` action solves it with no new inputs. Candidate points
 * are generated from the region bbox and snapped onto the graph that is about to
 * ship. The result is on-road BY CONSTRUCTION and of exactly the right vintage,
 * because it came out of the artifact under test.
 *
 * ── What this deliberately does NOT guarantee ──────────────────────────────
 * Connectivity. Two points can both be on real roads with no route between them
 * (an island, a ferry-only link, a graph the tiler truncated). That is precisely
 * what the gate exists to catch, so the derivation must not quietly pre-verify
 * it — otherwise the gate can only ever pass.
 *
 * Emits JSON: {"long":"lat,lon|lat,lon","urban":"lat,lon|lat,lon","candidates":N}
 * `urban` may be null for a region with no dense cluster; the caller treats the
 * long-haul pair as the required one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) throw new Error(`Missing --${name}`);
    return null;
  }
  return process.argv[i + 1];
}

const region = arg('region');
const image = arg('image');
const mount = arg('mount');   // host:container
const config = arg('config'); // path INSIDE the container

const regions = JSON.parse(readFileSync(join(__dirname, 'regions.json'), 'utf-8')).regions;
const entry = regions.find((r) => r.id === region);
if (!entry) throw new Error(`Region ${region} not in regions.json`);
const [minLon, minLat, maxLon, maxLat] = entry.bbox;

/** Great-circle metres. */
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function valhalla(action, payload) {
  return execFileSync('docker', [
    'run', '--rm', '-v', mount, image,
    'valhalla_service', config, action, JSON.stringify(payload),
  ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
}

/**
 * Grid of candidates, inset from the bbox edges. The inset matters: a country
 * bbox's corners are usually sea, desert or a neighbouring country, and a corner
 * point that snaps to a road across the border would produce a "sanity route"
 * the tiles cannot serve.
 */
const GRID = 7;
const candidates = [];
for (let i = 0; i < GRID; i++) {
  for (let j = 0; j < GRID; j++) {
    candidates.push({
      lat: minLat + ((maxLat - minLat) * (i + 1)) / (GRID + 1),
      lon: minLon + ((maxLon - minLon) * (j + 1)) / (GRID + 1),
    });
  }
}

// Batched because `locate` is subject to service_limits.max_locations, and a
// single oversized request would fail the whole derivation rather than degrade.
const snapped = [];
for (let i = 0; i < candidates.length; i += 15) {
  const batch = candidates.slice(i, i + 15);
  let out;
  try {
    out = valhalla('locate', { locations: batch, costing: 'auto' });
  } catch {
    continue; // a batch with no routable point at all returns non-zero — expected
  }
  const start = out.indexOf('[');
  if (start === -1) continue;
  let parsed;
  try {
    parsed = JSON.parse(out.slice(start));
  } catch {
    continue;
  }
  for (const loc of parsed) {
    const edge = loc?.edges?.[0];
    if (!edge || edge.correlated_lat === undefined) continue;
    snapped.push({
      lat: Number(edge.correlated_lat.toFixed(6)),
      lon: Number(edge.correlated_lon.toFixed(6)),
    });
  }
}

// Dedupe — neighbouring grid points often snap to the same edge.
const seen = new Set();
const points = snapped.filter((p) => {
  const k = `${p.lat},${p.lon}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (points.length < 2) {
  console.error(
    `::error::derive-sanity-route: only ${points.length} of ${candidates.length} grid points ` +
    `snapped to a road in ${region}. Cannot derive a pair — the tiles are probably empty.`,
  );
  process.exit(1);
}

// ---- long-haul pair: opposite halves of the region's LONGER axis ------------
// Splitting on the longer axis (rather than always on latitude) keeps the pair
// meaningfully far apart for wide regions as well as tall ones, and forces the
// route to traverse the graph instead of staying inside one dense city.
const spanLat = maxLat - minLat;
const spanLon = (maxLon - minLon) * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
const splitOnLat = spanLat >= spanLon;
const mid = splitOnLat ? (minLat + maxLat) / 2 : (minLon + maxLon) / 2;
const lowHalf = points.filter((p) => (splitOnLat ? p.lat : p.lon) < mid);
const highHalf = points.filter((p) => (splitOnLat ? p.lat : p.lon) >= mid);

let long = null, longDist = -1;
// Falls back to the overall farthest pair when one half snapped nothing — a
// region can be legitimately one-sided (a long coastal strip, an archipelago).
const [setA, setB] = lowHalf.length && highHalf.length ? [lowHalf, highHalf] : [points, points];
for (const a of setA) {
  for (const b of setB) {
    if (a === b) continue;
    const d = haversine(a, b);
    if (d > longDist) { longDist = d; long = [a, b]; }
  }
}

// ---- intra-urban pair: the plan's second, more Rods-relevant case -----------
// The long-haul pair only proves the motorway hierarchy connects. Rods' actual
// use case is twisty secondary roads, so a short pair inside the densest cluster
// exercises a different part of the graph. Density of snapped grid points is a
// crude urban proxy, but it is free and needs no extra data source.
let urban = null;
const DENSE_RADIUS_M = 25000;
let bestDensity = -1, hub = null;
for (const p of points) {
  const n = points.filter((q) => q !== p && haversine(p, q) < DENSE_RADIUS_M).length;
  if (n > bestDensity) { bestDensity = n; hub = p; }
}
if (hub && bestDensity > 0) {
  const near = points
    .filter((q) => q !== hub)
    .map((q) => ({ q, d: haversine(hub, q) }))
    .filter((x) => x.d > 2000 && x.d < 30000)
    .sort((a, b) => a.d - b.d);
  if (near.length) urban = [hub, near[0].q];
}

const fmt = (pair) => `${pair[0].lat},${pair[0].lon}|${pair[1].lat},${pair[1].lon}`;
console.log(JSON.stringify({
  long: fmt(long),
  longKm: Math.round(longDist / 1000),
  urban: urban ? fmt(urban) : null,
  urbanKm: urban ? Math.round(haversine(urban[0], urban[1]) / 1000) : null,
  candidates: points.length,
  gridTried: candidates.length,
  splitAxis: splitOnLat ? 'lat' : 'lon',
}));
