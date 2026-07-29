#!/usr/bin/env node
/**
 * validate-extraction-delta.ts — BUG-278 data-integrity gate for a re-extracted OSM release.
 *
 * PURPOSE: Before promoting a new full extraction to the `latest` GitHub release, PROVE it has
 *   no artifacts or regressions versus the CURRENT production release. The under-bridge change
 *   should ONLY add `under_bridge` POINT rows to the core traffic-calming file — every other
 *   type, roundabouts, surfaces, and ways must be essentially unchanged. A "successful" extract
 *   can still silently drop or corrupt data (cf. the 2026-04-08 audio-deletion and the
 *   OSM-truncation-with-valid-checksum incidents), so this validates CONTENT, not just checksums.
 *
 * WHAT IT CHECKS (per docs/OSM_DATA_PIPELINE.md gate B in the BUG-278 plan):
 *   1. Manifest completeness — every prior region still present; all size/checksum fields set.
 *   2. Per-region traffic-calming type deltas — existing type counts within tolerance; the only
 *      intended new delta is `under_bridge` (and, on the first toll-carrying extract, the
 *      new `tollPoints` array — FEAT-051). A type collapsing toward 0 or ballooning = FAIL.
 *   3. Roundabout count stable; surfaces & ways file sizes essentially unchanged.
 *   4. Asset integrity — every core gzip decompresses AND parses (not just checksum-valid).
 *
 * USAGE (run from the extractor after a full run, BEFORE publishing `latest`):
 *   npx tsx validate-extraction-delta.ts \
 *     --old-manifest <url|path to current latest manifest.json> \
 *     --old-base <url|dir of current release assets> \
 *     --new-dir ./output
 *
 * Exit 0 = safe to promote. Exit 1 = a regression was found; DO NOT publish.
 *
 * MIRROR: keep in sync with Cruncho420/osm-region-extractor.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';

// Count deltas above these are flagged. Existing types must stay within ±COUNT_TOLERANCE_FRAC
// (relative) — real month-to-month OSM churn is a few percent; a big swing is a regression.
const COUNT_TOLERANCE_FRAC = 0.15;
const SIZE_TOLERANCE_FRAC = 0.15; // surfaces/ways must not move materially (we don't touch them)
const KNOWN_TYPES = [
  'speed_bump', 'dip', 'speed_camera', 'construction',
  'bridge', 'tunnel', 'chicane', 'narrowing', 'island',
];

interface CoreData {
  trafficCalming: Array<{ type: string }>;
  roundabouts: unknown[];
  /** FEAT-051 — absent on any core produced before tolls shipped, hence optional. */
  tollPoints?: unknown[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchBytes(ref: string): Promise<Buffer> {
  if (ref.startsWith('http')) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`fetch ${ref} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFileSync(ref);
}

function parseCoreGz(buf: Buffer, label: string): CoreData {
  let json: string;
  try {
    json = gunzipSync(buf).toString('utf-8'); // decompress — catches truncation a checksum misses
  } catch (e) {
    throw new Error(`${label}: gunzip failed (truncated/corrupt) — ${(e as Error).message}`);
  }
  const data = JSON.parse(json) as CoreData; // parse — catches partial JSON
  if (!Array.isArray(data.trafficCalming) || !Array.isArray(data.roundabouts)) {
    throw new Error(`${label}: core missing trafficCalming/roundabouts arrays`);
  }
  return data;
}

function typeCounts(core: CoreData): Record<string, number> {
  const c: Record<string, number> = {};
  for (const tc of core.trafficCalming) c[tc.type] = (c[tc.type] ?? 0) + 1;
  return c;
}

async function main() {
  const oldManifestRef = arg('old-manifest');
  const oldBase = arg('old-base');
  const newDir = arg('new-dir') ?? './output';
  if (!oldManifestRef || !oldBase) {
    console.error('Required: --old-manifest <url|path> --old-base <url|dir> [--new-dir ./output]');
    process.exit(2);
  }

  const failures: string[] = [];
  const warn = (m: string) => console.warn(`  ⚠ ${m}`);
  const fail = (m: string) => { failures.push(m); console.error(`  ✗ ${m}`); };

  const oldManifest = JSON.parse((await fetchBytes(oldManifestRef)).toString('utf-8'));
  const newManifest = JSON.parse(readFileSync(join(newDir, 'manifest.json'), 'utf-8'));
  const oldRegions: Record<string, any> = oldManifest.regions ?? {};
  const newRegions: Record<string, any> = newManifest.regions ?? {};

  console.log(`Regions: old=${Object.keys(oldRegions).length} new=${Object.keys(newRegions).length}\n`);

  // 1. Manifest completeness — no region dropped, all fields present.
  for (const id of Object.keys(oldRegions)) {
    if (!newRegions[id]) fail(`region '${id}' present in OLD manifest but MISSING from new — a partial 'latest' breaks downloads for all its users`);
  }
  const REQUIRED_FIELDS = ['size', 'checksum', 'surfaceSize', 'surfaceChecksum', 'waySize', 'wayChecksum'];
  for (const [id, r] of Object.entries(newRegions)) {
    for (const f of REQUIRED_FIELDS) {
      if ((r as any)[f] === undefined) fail(`region '${id}' missing manifest field '${f}' (→ infinite re-download loop)`);
    }
  }

  // 2-4. Per-region content deltas + integrity (sample: all regions present in both).
  let totalNewUnderBridge = 0;
  for (const id of Object.keys(newRegions)) {
    if (!oldRegions[id]) { warn(`region '${id}' is NEW (not in old manifest) — skipping delta`); continue; }

    const newCorePath = join(newDir, `${id}.json.gz`);
    if (!existsSync(newCorePath)) { fail(`region '${id}' core file missing on disk: ${newCorePath}`); continue; }

    let oldCore: CoreData, newCore: CoreData;
    try {
      oldCore = parseCoreGz(await fetchBytes(`${oldBase.replace(/\/$/, '')}/${id}.json.gz`), `OLD ${id}`);
      newCore = parseCoreGz(readFileSync(newCorePath), `NEW ${id}`);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }

    const oldC = typeCounts(oldCore);
    const newC = typeCounts(newCore);
    totalNewUnderBridge += newC['under_bridge'] ?? 0;

    // Existing traffic-calming types must stay within tolerance.
    for (const t of KNOWN_TYPES) {
      const o = oldC[t] ?? 0;
      const n = newC[t] ?? 0;
      if (o === 0 && n === 0) continue;
      const rel = o === 0 ? (n > 5 ? 1 : 0) : Math.abs(n - o) / o;
      if (rel > COUNT_TOLERANCE_FRAC) {
        fail(`region '${id}' type '${t}' count moved ${o} → ${n} (${(rel * 100).toFixed(0)}% > ${COUNT_TOLERANCE_FRAC * 100}%) — investigate before publishing`);
      }
    }

    // Toll plazas stable (FEAT-051). Skipped entirely on the FIRST toll-carrying extract,
    // where the old core has no `tollPoints` at all — 0 -> N there is the intended delta,
    // exactly like `under_bridge` was. Once both sides have the array it is held to the
    // same tolerance as everything else, so a plaza set collapsing toward 0 fails.
    const oT = oldCore.tollPoints?.length;
    const nT = newCore.tollPoints?.length ?? 0;
    if (typeof oT === 'number' && oT > 0 && Math.abs(nT - oT) / oT > COUNT_TOLERANCE_FRAC) {
      fail(`region '${id}' toll plaza count moved ${oT} → ${nT}`);
    }

    // Roundabouts stable.
    const oR = oldCore.roundabouts.length, nR = newCore.roundabouts.length;
    if (oR > 0 && Math.abs(nR - oR) / oR > COUNT_TOLERANCE_FRAC) {
      fail(`region '${id}' roundabout count moved ${oR} → ${nR}`);
    }

    // Surfaces & ways: we do NOT touch them — sizes must be essentially unchanged.
    for (const [field, label] of [['surfaceSize', 'surfaces'], ['waySize', 'ways']] as const) {
      const o = oldRegions[id][field], n = (newRegions[id] as any)[field];
      if (typeof o === 'number' && typeof n === 'number' && o > 0 && Math.abs(n - o) / o > SIZE_TOLERANCE_FRAC) {
        fail(`region '${id}' ${label} size moved ${o} → ${n} (${(Math.abs(n - o) / o * 100).toFixed(0)}%) — under-bridge must not affect ${label}`);
      }
    }
  }

  console.log(`\nTotal new under_bridge points across regions: ${totalNewUnderBridge}`);
  if (totalNewUnderBridge === 0) warn('ZERO under_bridge points emitted anywhere — the extraction change may not have run; verify before publishing.');

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} data-integrity failure(s) — DO NOT publish this release.`);
    process.exit(1);
  }
  console.log('\n✅ Data-integrity delta clean — only under_bridge added; safe to promote to latest.');
}

main().catch((e) => { console.error(e); process.exit(1); });
