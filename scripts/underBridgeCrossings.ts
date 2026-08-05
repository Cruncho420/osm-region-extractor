/**
 * underBridgeCrossings.ts — DEFINITIVE over/under-bridge detection for the OSM extractor.
 *
 * PURPOSE: Compute, from real OSM geometry, every point where a driven road passes
 *   UNDERNEATH a grade-separated bridge, and emit it as an `under_bridge` POINT feature
 *   for the bundled traffic-calming data. This is the data the app reads instead of
 *   guessing over-vs-under on-device. (BUG-278)
 *
 * WHY THIS IS DEFINITIVE (not a proximity guess): a point is emitted only when THREE
 *   independent questions all answer yes, and any one of them abstaining kills it.
 *
 *   1. IS THE DECK A STRUCTURE WORTH ANNOUNCING?  `bridge=yes` is taken unfiltered upstream,
 *      so the set also holds footbridges, boardwalks, sign gantries and half-built flyovers.
 *      Roads and railways only — see isAnnounceableDeck. (BUG-422)
 *   2. TOPOLOGY — OSM's structural convention is that two ways which physically cross share a
 *      NODE only when they connect at grade (a junction). A grade-separated crossing is drawn
 *      crossing in 2D with NO shared node. (Same invariant BUG-117's walker used on-device
 *      via coincident vertices.)
 *   3. TAGGING — the deck must be STRICTLY above per OSM Key:layer, using effective layers
 *      (explicit tag, else 1 for a bridge, else -1 for a tunnel, else 0). Equal levels are a
 *      self-contradiction in the source data, so nothing is asserted. (BUG-422)
 *
 *   Question 3 replaced a comparison that only asked whether the two layers DIFFERED, never
 *   which was higher — which is why the shipped data contained mirrored pairs asserting both
 *   "A passes under B" and "B passes under A" for one crossing. See ARCH-41.
 *
 * PURE apart from the optional `stats` accumulator, which the CALLER allocates and owns. The
 *   extractor (extract-single.ts) streams geometry in and feeds it here; the unit tests drive
 *   it directly. Runs ONLY at extraction time (server-side), never on the device.
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
  /** OSM `highway` class of the DECK, when it carries one. Drives the deck-class filter —
   *  see isAnnounceableDeck. (BUG-422) */
  highway?: string;
  /** OSM `railway` class of the DECK, when it carries one. (BUG-422) */
  railway?: string;
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
  /** This way is ITSELF a bridge deck (any `bridge` value except `no`). Feeds effectiveLayer
   *  so a stacked interchange resolves: the wayId self-exclusion at the pair loop only skips
   *  the SAME way, so without this a DIFFERENT deck is eligible to be called "the road
   *  below". It never vetoes on its own — a layer=2 deck genuinely does pass over a layer=1
   *  deck, and that IS an under-bridge. (BUG-422) */
  isBridge?: boolean;
}

export interface UnderBridgeCrossing {
  lat: number;
  lon: number;
  type: 'under_bridge';
  /** The bridge (over) way id — lets the app drop the stale linear "over bridge" for the
   *  same wayId when the route also passes under it (the double-fire kill). */
  wayId?: number;
  /** The way id of the road that passes UNDERNEATH. Known by construction (it is the `hw` of
   *  the emitting pair) and previously thrown away, which is why the app had to INFER
   *  over-vs-under from bearing (BUG-400) instead of comparing identities. Undefined only
   *  when the producer could not parse the way id. (BUG-422 / ARCH-41) */
  underWayId?: number;
}

/** Counters the caller allocates and owns, so this module stays pure and no existing call
 *  site or test has to change. The extractor knows the exact (deck, road) pair at decision
 *  time; the shipped data does not — so a suppression that happens here is invisible
 *  downstream forever unless it is counted here. (BUG-422) */
export interface UnderBridgeStats {
  /** Pairs that geometrically cross and cleared the deck-class, self-way and tunnel filters. */
  crossings: number;
  emitted: number;
  /** The "bridge" is BELOW the road it supposedly spans — the provably-wrong class. */
  suppressedBridgeBelow: number;
  /** Same effective level: an OSM self-contradiction, so we assert nothing. */
  abstainedEqualLevel: number;
  /** Decks rejected before any geometry work: footbridges, paths, proposed/under construction. */
  rejectedDeckClass: number;
  /** Of the suppressed/abstained pairs, how many had a bridge deck as "the road below". */
  roadBelowIsDeck: number;
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

/** Railways whose deck carries traffic today. A train bridge over the road is a real overhead
 *  structure and announces, exactly like a road bridge. */
const IN_SERVICE_RAILWAY_TYPES = new Set([
  'rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'funicular', 'monorail', 'preserved',
]);

/** Railways whose rails are gone but whose DECK normally still spans the road — an old stone
 *  or steel viaduct is as much a structure overhead as a live one. Deliberately NOT lumped in
 *  with `construction`/`proposed`/`razed` below, which describe something that is not there. */
const STANDING_DISUSED_RAILWAY_TYPES = new Set(['abandoned', 'disused']);

/** Not built, being built, or demolished — announcing "under bridge" where no bridge spans the
 *  road is wrong in both directions. `highway=construction` carries the eventual class in a
 *  separate `construction=*` tag, so the class alone is the signal. */
const NOT_A_STRUCTURE_HIGHWAY_TYPES = new Set(['construction', 'proposed']);
const NOT_A_STRUCTURE_RAILWAY_TYPES = new Set([
  'construction', 'proposed', 'razed', 'dismantled', 'demolished',
]);

/**
 * Is this deck a structure worth announcing?
 *
 * The extractor takes `bridge=yes` UNFILTERED, so the bridge set also carries footbridges,
 * boardwalks, sign gantries, pipelines and half-built flyovers. Measured on the shipped
 * `europe-lithuania` pack (2026-08-02): of 1,086 under_bridge points, **304 came from a
 * footway/path/cycleway/steps deck and 21 from a proposed or under-construction structure** —
 * an order of magnitude more than the layer-ordering defect this file was opened for.
 *
 * Same rule shape the map-pin gate already applies to LINEAR bridge features
 * (`services/osm/roadFeatureGate.ts`), extended with railways: a rail deck is a substantial
 * structure overhead even though it is not drivable.
 *
 * Absence of BOTH tags is a reject: a way a vehicle or train can use always carries one of
 * them, so "neither" positively means gantry / pipeline / fence / wildlife crossing.
 */
function isAnnounceableDeck(bridge: BridgeWayGeom): boolean {
  const { highway, railway } = bridge;
  // The deck's OWN highway class decides first, in both directions. A drivable road deck is a
  // structure no matter what used to run over it: rail-trail conversions routinely leave a bare
  // `railway=razed`/`dismantled` on the road way instead of lifecycle-prefixing it
  // (`razed:railway=*`), and consulting the railway lifecycle first would delete a live road
  // bridge over a live road. Order matters here — this is the ONLY reason these two checks are
  // not adjacent.
  if (highway !== undefined) {
    if (NOT_A_STRUCTURE_HIGHWAY_TYPES.has(highway)) return false;
    if (MOTOR_VEHICLE_HIGHWAY_TYPES.has(highway)) return true;
  }
  if (railway !== undefined) {
    if (NOT_A_STRUCTURE_RAILWAY_TYPES.has(railway)) return false;
    return IN_SERVICE_RAILWAY_TYPES.has(railway) || STANDING_DISUSED_RAILWAY_TYPES.has(railway);
  }
  return false;
}

/**
 * The vertical position of a way at a crossing, per OSM Key:layer.
 *
 * > "Ways passing above other ways on a bridge will have a higher layer value… All ways
 * > without an explicit value are assumed to have layer 0." — and layer=2 is reserved for a
 * > bridge passing over something already at 1.
 *
 * So an explicit tag always wins; otherwise a deck sits at 1 and a tunnel/covered way at -1.
 *
 * NOTE the `-1` branch is currently unreachable for the road-below: `isTunnel` is vetoed
 * earlier and owns that spot as "into tunnel" (a product rule, not a grade question), and the
 * deck side is never a tunnel. It is kept because it is the wiki's rule and the next caller
 * will expect it — do not "simplify" it away.
 */
function effectiveLayer(
  layer: number | undefined,
  isBridge: boolean,
  isTunnel: boolean,
): number {
  if (layer !== undefined && Number.isFinite(layer)) return layer;
  if (isBridge) return 1;
  if (isTunnel) return -1;
  return 0;
}

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
  stats?: UnderBridgeStats,
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
    // BUG-422: a footbridge, a boardwalk, a sign gantry and a flyover still being built are
    // not things you announce driving under. Cheapest possible veto — before any geometry.
    if (!isAnnounceableDeck(bridge)) {
      if (stats) stats.rejectedDeckClass++;
      continue;
    }

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

      // ---------------------------------------------------------------------
      // Grade-separation decision. TWO INDEPENDENT SIGNALS THAT MUST AGREE:
      // topology (the ways do not share a node) AND tagging (the deck is strictly higher).
      // Either one abstaining kills the emission. Neither overrides the other.
      // ---------------------------------------------------------------------

      // BUG-422 — vertical ordering. Emit ONLY when the deck is STRICTLY above. Equal levels
      // are an OSM self-contradiction (the wiki reserves the higher value for the way passing
      // above), so assert nothing rather than pick a direction — guessing a direction is what
      // produced the mirrored "A under B" + "B under A" pairs in the shipped data.
      const deckLevel = effectiveLayer(bridge.layer, true, false);
      // isTunnel is hard-coded FALSE, not read from `hw`: the tunnel veto above already
      // `continue`d, so at this line hw.isTunnel is provably falsy and passing it would be a
      // dead argument that reads as if tunnels were still in play. (`--strict` rejects
      // `hw.isTunnel === true` here for exactly that reason.) The -1 branch of effectiveLayer
      // stays reachable only through direct unit tests, which is deliberate — see its doc.
      const roadLevel = effectiveLayer(hw.layer, hw.isBridge === true, false);
      if (deckLevel <= roadLevel) {
        if (stats) {
          stats.crossings++;
          if (deckLevel === roadLevel) stats.abstainedEqualLevel++;
          else stats.suppressedBridgeBelow++;
          if (hw.isBridge) stats.roadBelowIsDeck++;
        }
        continue;
      }

      const sharedNode =
        hasVertexNear(bridge.coords, crossing, SHARED_NODE_TOL_M) &&
        hasVertexNear(hw.coords, crossing, SHARED_NODE_TOL_M);
      // UNCHANGED SEMANTICS, NARROWED DIRECTION (BUG-422): an at-grade shared node is
      // overridden only when BOTH ways carry an EXPLICIT layer and the deck's is higher.
      //
      // EXPLICIT-ONLY IS LOAD-BEARING — do not "simplify" this to reuse deckLevel/roadLevel.
      // A deck is its own way (approach — bridge — exit) sharing END NODES with its
      // neighbours, and segmentIntersection counts endpoint touching as a crossing. Under
      // EFFECTIVE layers the approach becomes a concrete 0 and the deck a concrete 1, so an
      // effective-layer override would emit a false under_bridge at EVERY BRIDGE ABUTMENT.
      // Requiring explicit tags on both sides is exactly the pre-BUG-422 condition, so this
      // narrowing can only remove emissions, never add one.
      const explicitlyAbove =
        bridge.layer !== undefined && hw.layer !== undefined && bridge.layer > hw.layer;
      if (sharedNode && !explicitlyAbove) continue;

      out.push({
        lat: crossing[1],
        lon: crossing[0],
        type: 'under_bridge',
        wayId: bridge.wayId,
        underWayId: hw.wayId,
      });
      emittedForPair.add(idx);
      if (stats) {
        stats.crossings++;
        stats.emitted++;
      }
    }
  }

  return out;
}

export const __testables = {
  metersBetween,
  wayLengthM,
  hasVertexNear,
  segmentIntersection,
  effectiveLayer,
  isAnnounceableDeck,
  MIN_OVERPASS_LENGTH_M,
  SHARED_NODE_TOL_M,
};
