/**
 * roundaboutRings.ts — stitch `junction=roundabout` WAYS back into RINGS at extraction.
 *
 * THE DEFECT THIS REMOVES (BUG-368 / ARCH-38 in the Rods repo):
 *   OSM models a roundabout as a closed ring, and that ring is routinely SPLIT into several
 *   ways — one per exit arm, lane-count change or surface change. The extractor used to emit
 *   one roundabout row PER WAY, reducing each to `centroid(coords)` + `calculateMaxRadius(...)`.
 *   A way of a split ring is an ARC, so that reduction is wrong three ways at once:
 *     1. N roundabouts are reported where there is ONE
 *     2. an arc's centroid sits on the ring EDGE, roughly R metres off the true centre
 *     3. an arc's max-radius is its HALF-CHORD, roughly half the true ring radius
 *
 *   Measured on the 2026-07 Lithuania extract: 1157 rows for 540 physical roundabouts (53%
 *   duplicates). The reported ring at 54.7791/25.3413 has a true radius of 11.5 m and is split
 *   into 6 ways; it was stored as 6 rows of radius 5-7 m sitting 8-13 m off centre.
 *
 *   Downstream, every consumer had to re-derive ring identity from its own distance guess —
 *   seven such thresholds exist in the app, each born from a shipped bug. Emitting one row per
 *   RING, with a stable `ringId`, removes the need for all of them.
 *
 * THE PRECEDENT: bridges and tunnels already carry `wayId` at extraction, explicitly "for
 *   deduplication of multi-segment features". Roundabouts simply never got the same treatment.
 *
 * CONSERVATIVE BY DESIGN: a piece set that cannot be stitched into a closed ring falls back to
 *   today's per-way emit. Data is never dropped — an un-stitchable gyratory keeps the old
 *   (imperfect) representation rather than disappearing from the map.
 *
 * The stitching rule is ported from the Rods app's `services/osm/roundaboutRing.ts`
 * (`stitchRing`, 2.5 m endpoint tolerance, closure required) so both sides agree on what
 * "one ring" means.
 */

export interface RoundaboutPiece {
  /** [lon, lat] pairs, in OSM node order. */
  coords: [number, number][];
  /** OSM way id, when the export carried one. Used for the stable ringId. */
  wayId?: number;
}

export interface StitchedRoundabout {
  lat: number;
  lon: number;
  radius: number;
  type: 'roundabout';
  /** Smallest member way id — stable across re-extracts, unlike the SQLite rowid. */
  ringId?: number;
  /** How many ways this ring was split across. 1 = the ring was a single way. */
  wayCount: number;
  /** False when the pieces could not be closed and this is a per-way fallback row. */
  stitched: boolean;
}

/** Endpoint match tolerance. Mirrors STITCH_TOLERANCE_M in the app's roundaboutRing.ts. */
const STITCH_TOLERANCE_M = 2.5;

/** Equirectangular metres — every distance here is tens of metres at most. */
function distM(a: [number, number], b: [number, number]): number {
  const latM = (a[1] - b[1]) * 111_320;
  const lonM = (a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.sqrt(latM * latM + lonM * lonM);
}

const near = (a: [number, number], b: [number, number]): boolean =>
  distM(a, b) <= STITCH_TOLERANCE_M;

function centroidOf(coords: [number, number][]): [number, number] {
  let lon = 0;
  let lat = 0;
  for (const c of coords) {
    lon += c[0];
    lat += c[1];
  }
  return [lon / coords.length, lat / coords.length];
}

/**
 * The ring's DISTINCT nodes — the closing node dropped.
 *
 * `stitchRing` returns a polyline whose last node repeats the first (that repeat is the closure
 * proof). Averaging over it double-counts whichever node the chain happened to start on, so the
 * centroid would move by tens of centimetres depending on the order OSM listed the ways in —
 * and that order is NOT stable across monthly extracts. Dropping the repeat makes the node
 * multiset, and therefore the centre and radius, identical for any start piece or direction.
 */
function ringNodes(ring: [number, number][]): [number, number][] {
  return ring.length > 1 && near(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
}

function maxRadiusM(coords: [number, number][], centre: [number, number]): number {
  let max = 0;
  for (const c of coords) max = Math.max(max, distM(centre, c));
  return max;
}

/**
 * Group pieces that share an endpoint into candidate rings.
 *
 * Union-find over endpoints only: two ways belong to the same ring structure when an endpoint
 * of one coincides with an endpoint of the other, which is exactly how OSM splits a ring.
 * Deliberately NOT a proximity cluster — two roundabouts 30 m apart share no node, so this
 * cannot merge them however close they sit. That is the whole reason to do this at extraction
 * rather than guess from points on the device.
 */
function groupBySharedEndpoints(pieces: RoundaboutPiece[]): RoundaboutPiece[][] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const n = parent[i];
      parent[i] = r;
      i = n;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const endpoints = pieces.map((p) => [p.coords[0], p.coords[p.coords.length - 1]] as const);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const [ai, bi] = endpoints[i];
      const [aj, bj] = endpoints[j];
      if (near(ai, aj) || near(ai, bj) || near(bi, aj) || near(bi, bj)) union(i, j);
    }
  }

  const groups = new Map<number, RoundaboutPiece[]>();
  pieces.forEach((p, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(p);
    else groups.set(root, [p]);
  });
  return [...groups.values()];
}

/**
 * Chain pieces head-to-tail into one closed polyline.
 *
 * Returns undefined unless EVERY piece is consumed and the result closes on itself — a partial
 * ring would under-state the radius and mis-place the centre, which is the very defect being
 * fixed. `junction=roundabout` implies one-way along coord order, so pieces chain tail→head;
 * a reversed piece is still accepted because some extracts carry a ring drawn the other way.
 */
function stitchRing(pieces: RoundaboutPiece[]): [number, number][] | undefined {
  if (pieces.length === 0) return undefined;
  if (pieces.length === 1) {
    const only = pieces[0].coords;
    return near(only[0], only[only.length - 1]) ? only : undefined;
  }

  const remaining = pieces.slice(1);
  const ring: [number, number][] = [...pieces[0].coords];

  while (remaining.length > 0) {
    const tail = ring[ring.length - 1];
    let idx = remaining.findIndex((p) => near(p.coords[0], tail));
    let reversed = false;
    if (idx < 0) {
      idx = remaining.findIndex((p) => near(p.coords[p.coords.length - 1], tail));
      reversed = true;
    }
    if (idx < 0) return undefined; // gap: a piece is missing, or a foreign way slipped in
    const next = reversed ? [...remaining[idx].coords].reverse() : remaining[idx].coords;
    ring.push(...next.slice(1));
    remaining.splice(idx, 1);
  }

  return near(ring[ring.length - 1], ring[0]) ? ring : undefined;
}

function fallbackRow(piece: RoundaboutPiece): StitchedRoundabout {
  const nodes = ringNodes(piece.coords);
  const centre = centroidOf(nodes);
  return {
    lat: centre[1],
    lon: centre[0],
    radius: Math.round(maxRadiusM(nodes, centre)),
    type: 'roundabout',
    ringId: piece.wayId,
    wayCount: 1,
    stitched: false,
  };
}

/**
 * One row per PHYSICAL roundabout, with the true centre and the true radius.
 *
 * `stats` lets the extraction log report how much splitting the region actually had, which is
 * the number to check on a single-region dry run before promoting a release.
 */
export function stitchRoundaboutRings(pieces: RoundaboutPiece[]): {
  rings: StitchedRoundabout[];
  stats: { pieces: number; rings: number; stitched: number; unstitchable: number };
} {
  const rings: StitchedRoundabout[] = [];
  let stitched = 0;
  let unstitchable = 0;

  for (const group of groupBySharedEndpoints(pieces)) {
    const ring = stitchRing(group);
    if (!ring) {
      // Could not close it — keep the old per-way rows rather than lose the roundabout.
      unstitchable += group.length;
      for (const piece of group) rings.push(fallbackRow(piece));
      continue;
    }

    const nodes = ringNodes(ring);
    const centre = centroidOf(nodes);
    const ids = group.map((p) => p.wayId).filter((id): id is number => typeof id === 'number');
    rings.push({
      lat: centre[1],
      lon: centre[0],
      radius: Math.round(maxRadiusM(nodes, centre)),
      type: 'roundabout',
      ringId: ids.length ? Math.min(...ids) : undefined,
      wayCount: group.length,
      stitched: true,
    });
    stitched++;
  }

  return {
    rings,
    stats: { pieces: pieces.length, rings: rings.length, stitched, unstitchable },
  };
}
