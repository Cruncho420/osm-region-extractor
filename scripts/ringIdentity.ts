/**
 * ringIdentity.ts — physical-roundabout identity, decided where the topology still exists.
 *
 * PURPOSE: Assign every `junction=roundabout` way and every `highway=mini_roundabout` node a
 *          `ringId` naming the PHYSICAL roundabout it belongs to, so the app never has to infer
 *          ring membership from coordinates.
 * RESPONSIBILITY: OPL decoding + union-find over true OSM node ids. No geometry, no clustering,
 *                 no output-format concerns.
 * DEPENDENCIES: none beyond Node's fs/readline. Deliberately dependency-free so it can run
 *               inside the GitHub Action with no install step.
 * CONSUMERS: scripts/extract-single.ts (stamps `ringId` onto each roundabout row),
 *            scripts/build-sqlite.ts (writes the `ring_id` column).
 *
 * WHY THIS EXISTS (ARCH-21). The extractor emits ONE row per `junction=roundabout` WAY, and OSM
 * splits a large roundabout into many ways. Each row is therefore an ARC: its centroid sits on the
 * ring EDGE and its "radius" is a half-chord. The app then had to guess which arcs were one
 * roundabout, from coordinates alone, and drew one physical rotary as two, three or six pins —
 * reported six times across BUG-368/399/413/434/459/461.
 *
 * The app-side collapse now reaches ~89% on a 1,200-ring corpus but cannot exceed ~90% on the
 * widest rings, because the information it needs was DISCARDED here: two ways are the same ring
 * exactly when they share a node, and `osmium export -f geojson` does not emit node ids. Measured
 * on the same corpus, stamping the id here takes mega rings from 46.1% to 99.7% and wide rings
 * from 58.9% to 99.2%.
 *
 * A SHARED NODE IS NOT A THRESHOLD. Every distance threshold in this problem's history has been
 * wrong at some ring size — that is the whole recurrence pattern. Node identity is exact: it tells
 * a junction (shared node) apart from a grade-separated crossing (no shared node) by definition,
 * with no tolerance to tune and no size at which it degrades.
 */

import * as fs from 'fs';
import * as readline from 'readline';

interface OplWay {
  id: number;
  tags: Record<string, string>;
  /** True OSM node ids, in way order. A closed way repeats its first id last. */
  nodes: number[];
}

export interface RingIdentity {
  /** OSM way id -> ringId, for every `junction=roundabout` way in the region. */
  ringIdByWayId: Map<number, number>;
  /** OSM node id -> ringId, for every `highway=mini_roundabout` node in the region. */
  ringIdByMiniNodeId: Map<number, number>;
  /** How many distinct physical rings the ways collapsed into (excludes standalone minis). */
  ringCount: number;
  /** How many ring ways were seen. `wayCount - ringCount` is what the app used to guess at. */
  wayCount: number;
  /** Minis whose node is ON a ring, and so inherit that ring's id rather than getting their own. */
  minisOnRing: number;
}

/**
 * osmium OPL escapes a character as `%<hex>%` — note the TRAILING percent, which is what
 * distinguishes it from URI encoding. Decoding this wrong silently corrupts every tag KEY, so a
 * `junction=roundabout` would quietly stop matching and the whole region would emit no ids.
 */
function unescapeOpl(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/%([0-9a-fA-F]+)%/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function parseTags(field: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!field) return out;
  // Tags are comma-separated k=v; a comma inside a value is escaped as '%2C%', so a plain
  // split is safe.
  for (const pair of field.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[unescapeOpl(pair.slice(0, eq))] = unescapeOpl(pair.slice(eq + 1));
  }
  return out;
}

/**
 * Read the OPL dump, keeping ONLY what ring identity needs: roundabout ways with their node
 * refs, and mini_roundabout node ids. Streamed line-by-line — the filtered PBF for a large
 * country is small, but there is no reason to hold it in memory.
 *
 * OPL line shapes (osmium 1.19):
 *   n<id> v.. dV c.. t.. i.. u T<tags> x<lon> y<lat>
 *   w<id> v.. dV c.. t.. i.. u T<tags> Nn<id>,n<id>,...
 */
async function readOpl(oplPath: string): Promise<{ ways: OplWay[]; miniNodeIds: number[] }> {
  const ways: OplWay[] = [];
  const miniNodeIds: number[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(oplPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    const kind = line[0];
    // Relations are not part of ring identity — a route relation over a roundabout does not
    // make two roundabouts one.
    if (kind !== 'n' && kind !== 'w') continue;

    const parts = line.split(' ');
    const id = parseInt(parts[0].slice(1), 10);
    if (!Number.isFinite(id)) continue;

    let tags: Record<string, string> = {};
    let nodeRefs: number[] | undefined;

    for (let i = 1; i < parts.length; i++) {
      const f = parts[i];
      if (f.startsWith('T')) tags = parseTags(f.slice(1));
      else if (f.startsWith('N')) {
        nodeRefs = [];
        const body = f.slice(1); // "n123,n456" — empty when the way's nodes were filtered out
        if (body) {
          for (const ref of body.split(',')) {
            const nid = parseInt(ref.slice(1), 10);
            if (Number.isFinite(nid)) nodeRefs.push(nid);
          }
        }
      }
    }

    if (kind === 'n') {
      if (tags.highway === 'mini_roundabout') miniNodeIds.push(id);
    } else if (tags.junction === 'roundabout') {
      // `junction=circular` is deliberately NOT included: the extractor's own filter only takes
      // `junction=roundabout`, so a circular way has no row to stamp and admitting it here would
      // union two rings through a way the app never sees.
      ways.push({ id, tags, nodes: nodeRefs ?? [] });
    }
  }

  return { ways, miniNodeIds };
}

/** Union-find with path compression. Small enough to inline; a dependency here would have to
 *  survive in the Action's install step for no benefit. */
class UnionFind {
  private parent = new Map<number, number>();

  find(x: number): number {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)!) root = this.parent.get(root)!;
    // Path compression, iterative — a country's largest component is small, but a recursive
    // find on a pathological chain is the kind of thing that only fails in CI.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * `ringId` ENCODING — globally unique, not merely region-unique.
 *
 * A route near a border merges rows from TWO region packs before the app groups them, so a
 * per-region counter would let ring 5 of Lithuania and ring 5 of Poland group together. That is an
 * over-merge, which silently deletes a callout — the one failure mode this whole change exists to
 * prevent. OSM way ids and node ids are each globally unique but occupy OVERLAPPING numeric
 * ranges, so neither can be used raw.
 *
 * So: a ring takes `minWayId * 2` (always even) and a standalone mini takes `nodeId * 2 + 1`
 * (always odd). Two disjoint spaces, both derived from a globally unique id, both non-negative
 * integers — which is what the app's `isTrustedRingId` requires. Largest OSM node id today is
 * ~1.3e10, so doubling stays far inside both SQLite's INTEGER and JS's safe-integer range.
 *
 * The id is deterministic for a given input (min way id, not an allocation order), so two builds
 * of the same extract produce identical values and a diff of two packs is meaningful.
 */
const ringIdForWayComponent = (minWayId: number): number => minWayId * 2;
const ringIdForStandaloneMini = (nodeId: number): number => nodeId * 2 + 1;

/**
 * Compute ring identity for a region from its filtered OPL dump.
 *
 * Two ways belong to the same physical roundabout exactly when they share a node — directly or
 * transitively. That is the definition of a connected circulating carriageway, and it is why a
 * dogbone's two lobes stay separate (their ring ways do not touch; they are joined by a link way
 * which is not tagged `junction=roundabout`) while a 12-way gyratory becomes one.
 */
export async function computeRingIdentity(oplPath: string): Promise<RingIdentity> {
  const { ways, miniNodeIds } = await readOpl(oplPath);

  const uf = new UnionFind();
  const nodeOwner = new Map<number, number>();
  for (const w of ways) {
    uf.find(w.id); // register even a way that shares no node, so it becomes its own ring
    for (const n of w.nodes) {
      const owner = nodeOwner.get(n);
      if (owner === undefined) nodeOwner.set(n, w.id);
      else uf.union(owner, w.id);
    }
  }

  // Component -> its member ways, then the component's id is the SMALLEST way id in it.
  const componentWays = new Map<number, number[]>();
  for (const w of ways) {
    const root = uf.find(w.id);
    const list = componentWays.get(root);
    if (list) list.push(w.id);
    else componentWays.set(root, [w.id]);
  }

  const ringIdByWayId = new Map<number, number>();
  const ringIdByComponentRoot = new Map<number, number>();
  for (const [root, wayIds] of componentWays) {
    const ringId = ringIdForWayComponent(Math.min(...wayIds));
    ringIdByComponentRoot.set(root, ringId);
    for (const wid of wayIds) ringIdByWayId.set(wid, ringId);
  }

  // Every node that lies on some ring, mapped to that ring. Built once — a per-mini scan over
  // every ring way would be O(minis x ways) on a country-sized extract.
  const ringIdByNodeOnRing = new Map<number, number>();
  for (const w of ways) {
    const ringId = ringIdByWayId.get(w.id)!;
    for (const n of w.nodes) ringIdByNodeOnRing.set(n, ringId);
  }

  /**
   * MINI POLICY. A `mini_roundabout` is a NODE, so it is not a member of the union-find over
   * ways — its membership has to be decided explicitly, and both answers occur in real data:
   *
   *   - Node lies ON a ring way  => it IS that roundabout (a small ring mapped as a node on the
   *     circulating way, or a mini tagged at a ring vertex). It inherits the ring's id, so the
   *     app draws ONE pin, not a pin plus a mini on top of it.
   *   - Node lies anywhere else  => it is its own junction (a mini on an approach arm, or inside
   *     a larger rotary's island). It gets its own id.
   *
   * Membership is by NODE ID, not by proximity — a mini 4 m from a ring but not on it is a
   * different junction, and no distance test can say so reliably at every ring size.
   */
  const ringIdByMiniNodeId = new Map<number, number>();
  let minisOnRing = 0;
  for (const nid of miniNodeIds) {
    const onRing = ringIdByNodeOnRing.get(nid);
    if (onRing !== undefined) {
      ringIdByMiniNodeId.set(nid, onRing);
      minisOnRing++;
    } else {
      ringIdByMiniNodeId.set(nid, ringIdForStandaloneMini(nid));
    }
  }

  return {
    ringIdByWayId,
    ringIdByMiniNodeId,
    ringCount: componentWays.size,
    wayCount: ways.length,
    minisOnRing,
  };
}
