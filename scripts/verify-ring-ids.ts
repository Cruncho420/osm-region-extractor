/**
 * verify-ring-ids.ts — gate a built pack's `roundabouts.ring_id` against what the APP will accept.
 *
 * PURPOSE: Fail an extraction whose ring ids the app would silently refuse, instead of shipping a
 *          pack that quietly degrades to geometric guessing in the field.
 * RESPONSIBILITY: Read-only verification of one .sqlite pack. Writes nothing, fixes nothing.
 * DEPENDENCIES: better-sqlite3 (already an extractor dependency).
 * CONSUMERS: CI after build-sqlite; run by hand as
 *            `npx tsx verify-ring-ids.ts output/europe-lithuania.sqlite`.
 *
 * WHY A GATE AND NOT A UNIT TEST. The app's fast path is all-or-nothing per query box: it requires
 * a TRUSTED id on EVERY row before it groups by id, and abandons the ids for the whole set if any
 * ring measures implausibly large. Both refusals are SILENT — the app just falls back to geometry
 * and draws the duplicate pins this work exists to remove. Nothing in the app reports it, so
 * without this check a subtly bad column looks exactly like the fix not working.
 *
 * The bounds below are duplicated from services/osm/roundaboutClusters.ts ON PURPOSE: this is a
 * different repository and cannot import them. They must be changed together, and the app's copy
 * is the authority.
 */

import Database from 'better-sqlite3';

/** Mirrors services/osm/roundaboutClusters.ts RING_ID_MAX_OUTER_M. */
const RING_ID_MAX_OUTER_M = 250;

/** Mirrors the app's isTrustedRingId: a non-negative safe integer. */
const isTrustedRingId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v);

interface Row {
  lat: number;
  lon: number;
  radius: number | null;
  type: string;
  ring_id: number | null;
}

const EARTH_R = 6371008.8;

function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const mLat = ((aLat + bLat) / 2) * toRad;
  const x = dLon * Math.cos(mLat);
  return Math.hypot(dLat, x) * EARTH_R;
}

function main(): void {
  const packPath = process.argv[2];
  if (!packPath) {
    console.error('Usage: tsx verify-ring-ids.ts <pack.sqlite>');
    process.exit(2);
  }

  const db = new Database(packPath, { readonly: true });
  const rows = db.prepare('SELECT lat, lon, radius, type, ring_id FROM roundabouts').all() as Row[];
  db.close();

  if (rows.length === 0) {
    console.log(`${packPath}: no roundabouts — nothing to verify.`);
    return;
  }

  const failures: string[] = [];

  // 1. EVERY row must carry a trusted id. One missing id disables the mechanism for any query box
  //    containing that row, so a partial stamp is not a partial win — it is no win at all.
  const missing = rows.filter((r) => r.ring_id === null).length;
  const untrusted = rows.filter((r) => r.ring_id !== null && !isTrustedRingId(r.ring_id)).length;
  if (missing > 0) failures.push(`${missing}/${rows.length} rows have NULL ring_id`);
  if (untrusted > 0) failures.push(`${untrusted}/${rows.length} rows have a non-integer or negative ring_id`);

  // 2. No stamped ring may measure past any real roundabout. This is the app's corruption bound;
  //    a breach there abandons the ids for the WHOLE query box, so it must never reach a device.
  const byRing = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.ring_id === null) continue;
    const list = byRing.get(r.ring_id);
    if (list) list.push(r);
    else byRing.set(r.ring_id, [r]);
  }

  const oversized: Array<{ ringId: number; outerM: number; members: number; lat: number; lon: number }> = [];
  for (const [ringId, members] of byRing) {
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    // Same definition as CollapsedRoundabout.outerM: max hypot(distance from centroid, own radius).
    let outerM = 0;
    for (const m of members) {
      const d = metresBetween(lat, lon, m.lat, m.lon);
      outerM = Math.max(outerM, Math.hypot(d, m.radius ?? 15));
    }
    if (outerM > RING_ID_MAX_OUTER_M) oversized.push({ ringId, outerM, members: members.length, lat, lon });
  }
  if (oversized.length > 0) {
    failures.push(`${oversized.length} ring(s) exceed ${RING_ID_MAX_OUTER_M} m outer reach`);
  }

  // 3. Report the collapse the ids actually buy. Not a failure condition — a region genuinely may
  //    have one way per ring — but a ratio of exactly 1.00 on a large region means the union-find
  //    silently found no shared nodes, which is what a broken OPL parse looks like.
  const multi = [...byRing.values()].filter((m) => m.length > 1).length;
  const ratio = rows.length / byRing.size;

  console.log(`${packPath}`);
  console.log(`  rows            : ${rows.length}`);
  console.log(`  physical rings  : ${byRing.size}`);
  console.log(`  ways per ring   : ${ratio.toFixed(2)}`);
  console.log(`  multi-row rings : ${multi} (${((multi / byRing.size) * 100).toFixed(1)}% of rings)`);

  if (oversized.length > 0) {
    console.log(`  oversized rings :`);
    for (const o of oversized.slice(0, 10)) {
      console.log(
        `    ringId ${o.ringId}  ${o.outerM.toFixed(0)} m  ${o.members} rows  @ ${o.lat.toFixed(5)},${o.lon.toFixed(5)}`,
      );
    }
    if (oversized.length > 10) console.log(`    ... and ${oversized.length - 10} more`);
  }

  if (failures.length > 0) {
    console.error(`\n❌ ring_id verification FAILED:`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }

  console.log(`  ✓ every row carries a trusted id and no ring exceeds the app's bound`);
}

main();
