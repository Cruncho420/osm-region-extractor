/**
 * underBridgeCrossings.ts — DEFINITIVE over/under-bridge detection for the OSM extractor.
 *
 * PURPOSE: Compute, from real OSM geometry, every point where a driven road passes
 *   UNDERNEATH a grade-separated bridge, and emit it as an `under_bridge` POINT feature
 *   for the bundled traffic-calming data. This is the data the app reads instead of
 *   guessing over-vs-under on-device. (BUG-278)
 *
 * WHY THIS IS DEFINITIVE (not a proximity guess): OSM's structural convention is that two
 *   ways which physically cross share a NODE only when they connect at grade (a junction).
 *   A grade-separated crossing (bridge over road) is drawn crossing in 2D with NO shared
 *   node. So: our road geometrically crosses a `bridge=yes` way AND they share no node at
 *   the crossing ⇒ the road passes UNDER the bridge. The `layer` tag corroborates/overrides
 *   when present. (Same invariant BUG-117's walker used on-device via coincident vertices.)
 *
 * PURE + no I/O. The extractor (extract-single.ts) streams geometry in and feeds it here;
 *   the unit tests drive it directly. Runs ONLY at extraction time (server-side), never on
 *   the device.
 *
 * MIRROR — CRITICAL DELIVERY DEPENDENCY (do not skip):
 *   Production devices download a PREBUILT `{region}.sqlite.gz`, NOT the `{region}.json.gz` core
 *   this stage appends to (osmDataUpdateService.ts downloadRegionSqlite). So mirroring only this
 *   file + extract-single.ts is NOT enough — the canonical extractor repo
 *   (Cruncho420/osm-region-extractor) ALSO builds the prebuilt `.sqlite`, and that builder MUST:
 *     1. read the POST-APPEND core (with the under_bridge rows), and
 *     2. insert each traffic_calming row's `type` AND `way_id` VERBATIM.
 *   If under_bridge rows never reach the sqlite → the whole fix is silently INERT (no under-bridge
 *   callouts). If they reach it WITHOUT way_id → WORSE than the original bug: "under bridge" fires
 *   AND the stale "over bridge" also fires, because the on-device double-fire dedup keys entirely
 *   on way_id (osmLocalQuery.ts). Prove a built .sqlite for a known underpass region contains
 *   under_bridge rows WITH populated way_id before shipping the MIN_COMPATIBLE-bumping build.
 */

/** [lon, lat] at full OSM node density. */
export type LonLat = [number, number];

export interface BridgeWayGeom {
  /** OSM way id of the bridge (the "over" way). Stamped onto the emitted point. */
  wayId?: number;
  coords: LonLat[];
  /** OSM `layer` tag as a number, when present. */
  layer?: number;
}

export interface HighwayWayGeom {
  wayId?: number;
  /** OSM highway class (motorway, primary, residential, …). */
  highway: string;
  coords: LonLat[];
  layer?: number;
  /** tunnel=yes OR covered=yes on this way — the driver is enclosed here, so "into tunnel"
   *  owns the spot and no under_bridge is emitted. */
  isTunnel?: boolean;
}

export interface UnderBridgeCrossing {
  lat: number;
  lon: number;
  type: 'under_bridge';
  /** The bridge (over) way id — lets the app drop the stale linear "over bridge" for the
   *  same wayId when the route also passes under it (the double-fire kill). */
  wayId?: number;
}

/** Only real motor-vehicle roads get an under_bridge callout (mirror osmLocalQuery.ts). */
const MOTOR_VEHICLE_HIGHWAY_TYPES = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'track',
  'road',
]);

/** A crossing counts as a shared OSM node (at-grade junction) only if the intersection point
 *  coincides with a VERTEX of BOTH ways within this tolerance. Reasoned from OSM coordinate
 *  rounding (~1-2 m), same value BUG-117 used for junction connectivity. */
const SHARED_NODE_TOL_M = 2.5;

/** Culvert / tiny drainage bridges (bridge=yes on a few-metre span) are not real overpasses.
 *  A bridge shorter than this is not considered a crossing-over structure. Tunable. */
const MIN_OVERPASS_LENGTH_M = 10;

/** Spatial-index cell size in degrees (~1.1 km) — bounds the bridge×highway pair tests so the
 *  region-scale join is O(bridges · localSegments), never O(ways²). */
const GRID_CELL_DEG = 0.01;

// ---------------------------------------------------------------------------
// Geometry helpers (equirectangular metres — inputs span a few hundred metres,
// so the flat approximation is well within a marker's tolerance).
// ---------------------------------------------------------------------------

function metersBetween(a: LonLat, b: LonLat): number {
  const latM = (a[1] - b[1]) * 111_320;
  const lonM = (a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.sqrt(latM * latM + lonM * lonM);
}

function wayLengthM(coords: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += metersBetween(coords[i - 1], coords[i]);
  return total;
}

/** Is `p` within tol metres of any vertex of `coords`? (i.e. does `coords` have a NODE at p?) */
function hasVertexNear(coords: LonLat[], p: LonLat, tolM: number): boolean {
  for (const v of coords) {
    if (metersBetween(v, p) <= tolM) return true;
  }
  return false;
}

/**
 * Intersection point of segments p1→p2 and p3→p4 (planar lon/lat), or null if they do not
 * properly cross. Endpoints touching count as an intersection (a shared vertex there is then
 * resolved by the shared-node test).
 */
function segmentIntersection(p1: LonLat, p2: LonLat, p3: LonLat, p4: LonLat): LonLat | null {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null; // parallel or collinear
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

interface Bbox { minLon: number; minLat: number; maxLon: number; maxLat: number; }

function bboxOf(coords: LonLat[]): Bbox {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

function bboxesOverlap(a: Bbox, b: Bbox): boolean {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function cellsForBbox(bb: Bbox): string[] {
  const keys: string[] = [];
  const x0 = Math.floor(bb.minLon / GRID_CELL_DEG);
  const x1 = Math.floor(bb.maxLon / GRID_CELL_DEG);
  const y0 = Math.floor(bb.minLat / GRID_CELL_DEG);
  const y1 = Math.floor(bb.maxLat / GRID_CELL_DEG);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) keys.push(cellKey(cx, cy));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// The detection
// ---------------------------------------------------------------------------

/**
 * Emit one `under_bridge` POINT per (bridge, road) pair where the road passes underneath a
 * grade-separated bridge. Definitive by the no-shared-node convention, corroborated by `layer`.
 *
 * @param bridges  every `bridge=yes` way (full node-density geometry + optional layer)
 * @param highways motor-vehicle ways near the bridges (full geometry + optional layer + tunnel flag)
 */
export function computeUnderBridgeCrossings(
  bridges: BridgeWayGeom[],
  highways: HighwayWayGeom[],
): UnderBridgeCrossing[] {
  // Index candidate highways into a coarse grid so each bridge only tests nearby roads.
  const grid = new Map<string, number[]>();
  const hwBboxes: Bbox[] = [];
  for (let i = 0; i < highways.length; i++) {
    const hw = highways[i];
    if (hw.coords.length < 2 || !MOTOR_VEHICLE_HIGHWAY_TYPES.has(hw.highway)) {
      hwBboxes.push({ minLon: NaN, minLat: NaN, maxLon: NaN, maxLat: NaN });
      continue;
    }
    const bb = bboxOf(hw.coords);
    hwBboxes.push(bb);
    for (const key of cellsForBbox(bb)) {
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
  }

  const out: UnderBridgeCrossing[] = [];

  for (const bridge of bridges) {
    if (bridge.coords.length < 2) continue;
    if (wayLengthM(bridge.coords) < MIN_OVERPASS_LENGTH_M) continue; // skip culverts/tiny spans

    const bBox = bboxOf(bridge.coords);
    // Candidate highway indices from the grid cells the bridge bbox covers (deduped).
    const candidates = new Set<number>();
    for (const key of cellsForBbox(bBox)) {
      const bucket = grid.get(key);
      if (bucket) for (const idx of bucket) candidates.add(idx);
    }

    // One emit per (bridge, highway) pair — dedup multiple segment hits.
    const emittedForPair = new Set<number>();

    for (const idx of candidates) {
      const hw = highways[idx];
      if (emittedForPair.has(idx)) continue;
      if (hw.isTunnel) continue; // driver is in a tunnel here — "into tunnel" owns it
      if (bridge.wayId !== undefined && hw.wayId !== undefined && bridge.wayId === hw.wayId) {
        continue; // the way that IS the bridge → the existing "over bridge" case, untouched
      }
      if (!bboxesOverlap(bBox, hwBboxes[idx])) continue;

      // Find the first genuine crossing between the two polylines.
      let crossing: LonLat | null = null;
      for (let bi = 1; bi < bridge.coords.length && !crossing; bi++) {
        const b1 = bridge.coords[bi - 1];
        const b2 = bridge.coords[bi];
        for (let hi = 1; hi < hw.coords.length; hi++) {
          const p = segmentIntersection(b1, b2, hw.coords[hi - 1], hw.coords[hi]);
          if (p) { crossing = p; break; }
        }
      }
      if (!crossing) continue;

      // Grade-separation decision.
      const sharedNode =
        hasVertexNear(bridge.coords, crossing, SHARED_NODE_TOL_M) &&
        hasVertexNear(hw.coords, crossing, SHARED_NODE_TOL_M);
      const layerSeparated =
        bridge.layer !== undefined && hw.layer !== undefined && bridge.layer !== hw.layer;

      // At-grade junction (shared node at the crossing) → NOT an under-bridge, UNLESS the
      // layer tag explicitly says the two are on different levels (rare, but layer wins).
      if (sharedNode && !layerSeparated) continue;

      out.push({
        lat: crossing[1],
        lon: crossing[0],
        type: 'under_bridge',
        wayId: bridge.wayId,
      });
      emittedForPair.add(idx);
    }
  }

  return out;
}

export const __testables = {
  metersBetween,
  wayLengthM,
  hasVertexNear,
  segmentIntersection,
  MIN_OVERPASS_LENGTH_M,
  SHARED_NODE_TOL_M,
};
