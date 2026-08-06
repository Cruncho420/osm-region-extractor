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
/**
 * Sample densities, tried in order until two distinct road points are found.
 *
 * WHY ESCALATING AND NOT ONE FIXED NUMBER: a single fixed grid assumes roads are
 * spread roughly evenly through the bounding box. That holds for a compact
 * country and collapses for anything ocean-dominated or mostly uninhabited —
 * north-america-us-hawaii's bbox spans ~23° of longitude and is over 99% open
 * Pacific, so at 7×7 essentially no sample lands within Valhalla's ~35 km search
 * cutoff of a road. The same applies to asia-indonesia (778 deg²), asia-japan
 * (661), north-america-us-alaska (991), north-america-canada (3,662) and
 * asia-russia (6,522) — archipelagos and mostly-empty landmasses, several of
 * them regions we actually care about.
 *
 * Raising the fixed grid instead would be the wrong fix twice over: it would
 * still fail the next sparse region, and it would charge all 234 regions the
 * dense probe to rescue the handful that need it. Escalating means the common
 * case pays exactly what it paid before (49 points, 4 `locate` calls) and only a
 * region that comes up short pays for more.
 *
 * ⚠️ WHAT THIS DOES NOT FIX, MEASURED NOT ASSUMED. Escalation rescues regions
 * whose roads are merely THIN (large interiors: Canada, Russia, Alaska). It does
 * NOT rescue an extreme archipelago. Simulated against a Hawaii-shaped bbox with
 * an Oahu-sized landmass, 21×21 still yields ONE distinct point: the spacing at
 * that density is ~1.07° of longitude, still wider than the island. Chasing it
 * with more density is the wrong instrument — grid sampling asks "where is the
 * box?" when the question is "where are the roads?". Those regions need either a
 * curated SANITY_ROUTES entry (what the error below now tells the operator) or a
 * sampler seeded from the region's own road data rather than its bounds.
 *
 * Bounded deliberately: three steps, worst case 441 points ≈ 30 docker calls, on
 * the failure path only. An unbounded search would turn one bad region into a
 * job that burns the 6-hour cap.
 */
const GRID_STEPS = [7, 13, 21];

function gridCandidates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({
        lat: minLat + ((maxLat - minLat) * (i + 1)) / (n + 1),
        lon: minLon + ((maxLon - minLon) * (j + 1)) / (n + 1),
      });
    }
  }
  return out;
}

/** Snap a batch of candidates onto real edges. Batched because `locate` is
 *  subject to service_limits.max_locations, and one oversized request would fail
 *  the whole derivation rather than degrade. */
function snapAll(candidates) {
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
  return snapped;
}

let points = [];
let probed = 0;
let anySnapped = false;
for (const n of GRID_STEPS) {
  const candidates = gridCandidates(n);
  probed = candidates.length;
  const snapped = snapAll(candidates);
  if (snapped.length > 0) anySnapped = true;
  // Dedupe — neighbouring grid points often snap to the same edge, and on a
  // small region a whole grid can collapse onto one road.
  const seen = new Set();
  points = snapped.filter((p) => {
    const k = `${p.lat},${p.lon}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (points.length >= 2) {
    if (n !== GRID_STEPS[0]) {
      console.error(`derive-sanity-route: ${region} needed a ${n}×${n} grid (${points.length} distinct points)`);
    }
    break;
  }
  if (n !== GRID_STEPS[GRID_STEPS.length - 1]) {
    console.error(`derive-sanity-route: ${region} yielded ${points.length} point(s) at ${n}×${n} — densifying`);
  }
}

if (points.length < 2) {
  // Two genuinely different faults, and conflating them sent the last operator
  // to debug tile generation for a region whose tiles were fine. Say which.
  if (!anySnapped) {
    console.error(
      `::error::derive-sanity-route: NOT ONE of ${probed} probes snapped to a road in ${region}. ` +
      `The tiles are the suspect — check that the build produced routable edges, not just .gph files.`,
    );
  } else {
    console.error(
      `::error::derive-sanity-route: only ${points.length} distinct road point(s) from ${probed} probes ` +
      `in ${region}. The TILES ARE FINE — the region's roads are too sparse relative to its bounding ` +
      `box for grid sampling to find a pair. Add a curated entry to SANITY_ROUTES in ` +
      `.github/workflows/valhalla-tiles.yml for this region.`,
    );
  }
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
  // `probed`, not `candidates.length`: the grid array is scoped to the
  // escalation loop that builds it, so it does not exist out here. `probed`
  // carries the size of the grid that actually ran, which is the number this
  // field was always reporting.
  gridTried: probed,
  splitAxis: splitOnLat ? 'lat' : 'lon',
}));
