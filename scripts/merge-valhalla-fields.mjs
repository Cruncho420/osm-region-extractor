#!/usr/bin/env node
/**
 * Merge Valhalla pack fields into a published OSM manifest.
 *
 * PURPOSE: add per-region valhallaSize / valhallaChecksum to the monthly
 *   manifest.json WITHOUT downloading a single asset.
 * RESPONSIBILITY: the merge and its safety assertions only. Fetching, uploading
 *   and verifying live in .github/workflows/merge-valhalla-manifest.yml.
 * DEPENDENCIES: none (node stdlib).
 * CONSUMERS: merge-valhalla-manifest.yml; scripts/merge-valhalla-fields.test.mjs.
 *
 * ── WHY THIS EXISTS RATHER THAN regenerate-manifest.yml ────────────────────
 *
 * regenerate-manifest.yml is the designed path and it is correct in shape: it
 * downloads every asset and rebuilds the manifest from what it finds, with a
 * per-field guard that refuses to drop a published field. At 234 regions that
 * means 43.8 GB of .sqlite.gz PLUS ~45 GB of valhalla tars on one runner. A
 * GitHub-hosted runner does not have 89 GB. The workflow has never run (0 runs),
 * so nothing has ever exercised that arithmetic.
 *
 * The values we would recompute are already known exactly: CI computes size and
 * sha256 on the very file it hands to `gh release upload`, and the build job
 * HEAD-checks the uploaded asset's Content-Length against that size before the
 * region is accepted. Downloading 45 GB to recompute them proves nothing that
 * the post-merge streaming verification (verify-release.ts) does not prove
 * better — it re-downloads every asset anyway, and checks the sha256 AGAINST
 * THIS MERGED MANIFEST, which is the direction that actually matters.
 *
 * ── THE RULE THIS FILE ENFORCES ───────────────────────────────────────────
 *
 * manifest.json is the file EVERY device reads to download road data. A bad
 * edit here breaks the app for users who have never heard of Valhalla. So the
 * merge is additive or it does not happen: same version, same region set, every
 * pre-existing field byte-identical, only the two new keys added. Anything else
 * exits non-zero and writes nothing.
 */

import { readFileSync, writeFileSync } from 'fs';

const CHECKSUM_RE = /^[0-9a-f]{16}$/;

/** Thrown for every refusal so the CLI can exit 1 with one message shape. */
export class MergeRefused extends Error {}

function refuse(message) {
  throw new MergeRefused(message);
}

/**
 * Pure merge. Returns { manifest, report } or throws MergeRefused.
 *
 * @param base      parsed monthly manifest (the one clients read)
 * @param valhalla  parsed manifest from the valhalla-<version> release
 * @param options   { allowChecksumChange?: boolean }
 */
export function mergeValhallaFields(base, valhalla, options = {}) {
  if (!base || typeof base !== 'object' || !base.regions) {
    refuse('base manifest has no regions object');
  }
  if (!valhalla || typeof valhalla !== 'object' || !valhalla.regions) {
    refuse('valhalla manifest has no regions object');
  }

  // The tag contract. The app builds its pack URL as
  // releases/download/valhalla-${manifestVersion}/..., so a version mismatch
  // here is not a cosmetic disagreement — it is a 404 for every region, from a
  // merge that would otherwise report success.
  if (base.version !== valhalla.version) {
    refuse(
      `version mismatch: base is ${base.version}, valhalla release is ${valhalla.version}. ` +
        'The valhalla tag must be valhalla-<base version>.',
    );
  }

  const merged = JSON.parse(JSON.stringify(base));
  const report = { covered: 0, unchanged: 0, updated: [], missing: [] };

  for (const [regionId, pack] of Object.entries(valhalla.regions)) {
    // An id the base manifest does not know means the two files are from
    // different corpora — never silently introduce a region here, because
    // generate-manifest is the only thing allowed to define what a region IS.
    if (!merged.regions[regionId]) {
      refuse(`valhalla manifest has region "${regionId}" which the base manifest does not`);
    }
    const size = pack?.valhallaSize;
    const checksum = pack?.valhallaChecksum;
    if (!Number.isInteger(size) || size <= 0) {
      refuse(`${regionId}: valhallaSize must be a positive integer, got ${JSON.stringify(size)}`);
    }
    if (typeof checksum !== 'string' || !CHECKSUM_RE.test(checksum)) {
      refuse(
        `${regionId}: valhallaChecksum must be 16 lowercase hex chars, got ${JSON.stringify(checksum)}`,
      );
    }

    const before = merged.regions[regionId];
    const hadFields = before.valhallaSize != null || before.valhallaChecksum != null;
    const changed =
      hadFields && (before.valhallaSize !== size || before.valhallaChecksum !== checksum);

    // A CHANGED checksum under an UNCHANGED tag means a release asset was
    // replaced in place. That is the exact shape of the 2026-07-03 europe-spain
    // incident (asset re-uploaded, manifest not regenerated, size-consistent and
    // wrong for a month). Legitimate when a region is deliberately rebuilt, so
    // it is allowed — but never by default and never silently.
    if (changed && !options.allowChecksumChange) {
      refuse(
        `${regionId}: already published as ${before.valhallaSize} B / ${before.valhallaChecksum}, ` +
          `now ${size} B / ${checksum}. An asset changed under a fixed tag. ` +
          'Re-run with --allow-checksum-change if this rebuild is intended.',
      );
    }
    if (changed) report.updated.push(regionId);
    else if (hadFields) report.unchanged += 1;

    before.valhallaSize = size;
    before.valhallaChecksum = checksum;
    report.covered += 1;
  }

  for (const regionId of Object.keys(base.regions)) {
    if (merged.regions[regionId].valhallaSize == null) report.missing.push(regionId);
  }

  assertAdditiveOnly(base, merged);
  return { manifest: merged, report };
}

/**
 * The guard that makes this safe to point at production. Everything the base
 * manifest said must survive verbatim; the only permitted difference is the two
 * new keys. Written as a comparison rather than trusted from construction
 * because "I only assigned two properties" is exactly the kind of claim that
 * stops being true after the next edit to this file.
 */
export function assertAdditiveOnly(base, merged) {
  const ADDED = new Set(['valhallaSize', 'valhallaChecksum']);

  for (const key of Object.keys(base)) {
    if (key === 'regions') continue;
    if (JSON.stringify(base[key]) !== JSON.stringify(merged[key])) {
      refuse(`top-level field "${key}" changed: ${base[key]} -> ${merged[key]}`);
    }
  }
  const baseIds = Object.keys(base.regions);
  const mergedIds = Object.keys(merged.regions);
  if (baseIds.length !== mergedIds.length) {
    refuse(`region count changed: ${baseIds.length} -> ${mergedIds.length}`);
  }
  for (const regionId of baseIds) {
    const before = base.regions[regionId];
    const after = merged.regions[regionId];
    if (!after) refuse(`region "${regionId}" disappeared`);
    for (const [key, value] of Object.entries(before)) {
      if (ADDED.has(key)) continue;
      if (JSON.stringify(after[key]) !== JSON.stringify(value)) {
        refuse(`${regionId}.${key} changed: ${JSON.stringify(value)} -> ${JSON.stringify(after[key])}`);
      }
    }
    for (const key of Object.keys(after)) {
      if (!(key in before) && !ADDED.has(key)) {
        refuse(`${regionId}.${key} was ADDED and is not a valhalla field`);
      }
    }
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

// import.meta.url comparison: only run the CLI when executed directly, so the
// test file can import the pure functions without triggering a file write.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (invokedDirectly) {
  const basePath = arg('base');
  const valhallaPath = arg('valhalla');
  const outPath = arg('out');
  if (!basePath || !valhallaPath || !outPath) {
    console.error('usage: merge-valhalla-fields.mjs --base <m.json> --valhalla <v.json> --out <m.json> [--allow-checksum-change]');
    process.exit(2);
  }
  try {
    const { manifest, report } = mergeValhallaFields(
      JSON.parse(readFileSync(basePath, 'utf-8')),
      JSON.parse(readFileSync(valhallaPath, 'utf-8')),
      { allowChecksumChange: process.argv.includes('--allow-checksum-change') },
    );
    writeFileSync(outPath, JSON.stringify(manifest, null, 2));
    console.log(`version            ${manifest.version}`);
    console.log(`regions with pack  ${report.covered} / ${Object.keys(manifest.regions).length}`);
    console.log(`already present    ${report.unchanged}`);
    console.log(`checksum changed   ${report.updated.length}${report.updated.length ? ` (${report.updated.join(', ')})` : ''}`);
    console.log(`still WITHOUT pack ${report.missing.length}`);
    if (report.missing.length) console.log(`  ${report.missing.join(', ')}`);
    console.log(`\n✓ merged -> ${outPath}`);
  } catch (err) {
    if (err instanceof MergeRefused) {
      console.error(`::error::REFUSING TO MERGE — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
