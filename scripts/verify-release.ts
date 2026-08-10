#!/usr/bin/env node
/**
 * Verify Release Integrity
 *
 * PURPOSE: Prove that EVERY region's `.sqlite.gz` actually DECOMPRESSES cleanly —
 *   not merely that its size + checksum are self-consistent — before a release is
 *   ever published or considered "finished".
 * RESPONSIBILITY: For every region that declares a `sqliteSize` in the manifest,
 *   run a full gzip integrity test (`gzip -t` = whole DEFLATE stream + CRC32 +
 *   ISIZE footer) against the asset — from a local directory (pre-upload) or
 *   streamed straight from the release URL (post-publish / live) — and FAIL the
 *   run if ANY region is truncated, corrupt, mis-sized, or missing.
 * DEPENDENCIES: node >= 20 (global fetch), `gzip`, `curl` (remote mode only).
 *   No npm dependencies — runnable in any CI step or on a laptop.
 * CONSUMERS: osm-extract.yml (pre-publish gate over release-files/),
 *   verify-manifest.yml (live sweep of the published "latest" release),
 *   humans (`npm run verify-release -- --manifest-url <url>`).
 *
 * WHY THIS EXISTS (the hole it closes):
 *   `generate-manifest.ts` records `sqliteSize` (statSync) and `sqliteChecksum`
 *   (sha256 of the raw bytes) — it never decompresses. `verify-manifest.yml` only
 *   HEAD-compared each asset's Content-Length to that manifest size. So a TRUNCATED
 *   `.sqlite.gz` got a perfectly self-consistent size + checksum and passed every
 *   pre-publish check — then failed only on the user's phone, at decompress
 *   (Android: `java.io.EOFException` — Rods BUG-242) or at SQLite open (iOS:
 *   `database disk image is malformed` — Rods BUG-243). The 2026-07-03 release
 *   shipped a truncated `europe-spain.sqlite.gz` (307003186 B, checksum-valid,
 *   yet `gunzip -t` fails at 712.8 MB of a claimed 752.7 MB) to ~53 users for a
 *   month, invisible to every existing gate. This test decompresses every asset
 *   so that can never happen again.
 *
 * Usage:
 *   # Local (pre-upload) — verify the assembled release payload before publishing:
 *   tsx verify-release.ts --dir ../release-files --manifest ../release-files/manifest.json
 *
 *   # Remote — stream + decompress every asset of a published release:
 *   tsx verify-release.ts --manifest-url https://github.com/OWNER/REPO/releases/latest/download/manifest.json
 *
 *   # Remote, defaulting to this repo's latest release:
 *   tsx verify-release.ts
 *
 * Options:
 *   --dir <path>           Verify local *.sqlite.gz in <path> (else remote mode).
 *   --manifest <path>      Local manifest.json (local mode; defaults to <dir>/manifest.json).
 *   --manifest-url <url>   Manifest URL (remote mode; defaults to this repo's latest).
 *   --base-url <url>       Base URL assets live under (remote mode; defaults to the
 *                          manifest URL's directory).
 *   --concurrency <n>      Parallel region checks (default 6).
 *
 * Exit code: 0 = every region decompressed cleanly; 1 = one or more failed/missing.
 */

import { spawn } from 'child_process';
import { statSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

// -----------------------------------------------------------------------------
// Config / constants
// -----------------------------------------------------------------------------

const DEFAULT_MANIFEST_URL =
  'https://github.com/Cruncho420/osm-region-extractor/releases/latest/download/manifest.json';
const DEFAULT_CONCURRENCY = 6;
// A single region download can be large (largest ~575 MB compressed) and CI
// bandwidth varies — give each streamed check a generous ceiling.
const CURL_MAX_TIME_SECONDS = 1800;

interface ManifestRegion {
  name?: string;
  sqliteSize?: number;
  sqliteChecksum?: string;
  /** Set only once a region has a Valhalla offline-routing pack published. */
  valhallaSize?: number;
  valhallaChecksum?: string;
}
interface Manifest {
  version: string;
  regions: Record<string, ManifestRegion>;
}

// CHECKSUM_MISMATCH is deliberately distinct from CORRUPT: corrupt means the
// bytes are damaged, mismatch means they are intact but are not the file the
// manifest promises — different cause, different fix (re-upload vs re-merge).
type Status = 'ok' | 'MISSING' | 'SIZE_MISMATCH' | 'CORRUPT' | 'CHECKSUM_MISMATCH';
interface Result {
  regionId: string;
  status: Status;
  detail: string;
}

// -----------------------------------------------------------------------------
// Arg parsing
// -----------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const localDir = argValue('--dir');
const manifestPathArg = argValue('--manifest');
const manifestUrlArg = argValue('--manifest-url');
const baseUrlArg = argValue('--base-url');
const concurrency = Math.max(1, parseInt(argValue('--concurrency') ?? '', 10) || DEFAULT_CONCURRENCY);

// -----------------------------------------------------------------------------
// Manifest loading
// -----------------------------------------------------------------------------

async function loadManifest(): Promise<{ manifest: Manifest; baseUrl: string | null }> {
  if (localDir) {
    const manifestPath = manifestPathArg ?? join(localDir, 'manifest.json');
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return { manifest, baseUrl: null };
  }
  const manifestUrl = manifestUrlArg ?? DEFAULT_MANIFEST_URL;
  const res = await fetch(manifestUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch manifest (${res.status}) from ${manifestUrl}`);
  }
  const manifest: Manifest = await res.json();
  // Assets sit next to manifest.json under the same release "download/" path.
  const baseUrl = baseUrlArg ?? manifestUrl.slice(0, manifestUrl.lastIndexOf('/'));
  return { manifest, baseUrl };
}

// -----------------------------------------------------------------------------
// Integrity checks
// -----------------------------------------------------------------------------

/** Run a shell command; resolve with exit code + captured stderr (never rejects). */
function runShell(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // stdout is PIPED, not ignored: the valhalla checksum test needs the digest
    // the pipeline prints. Every command run here emits at most a few bytes on
    // stdout (a hash, or nothing) — the multi-GB asset stream never reaches
    // node, it is consumed inside the shell pipeline.
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout = (stdout + d.toString()).slice(-2000);
    });
    child.stderr.on('data', (d) => {
      // Keep only the tail — a corrupt stream can be noisy.
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: String(err) }));
  });
}

/** Local mode: size must match the manifest, and `gzip -t` must pass. */
async function checkLocal(regionId: string, region: ManifestRegion): Promise<Result> {
  const path = join(localDir!, `${regionId}.sqlite.gz`);
  let actualSize: number;
  try {
    actualSize = statSync(path).size;
  } catch {
    return { regionId, status: 'MISSING', detail: `${regionId}.sqlite.gz not found in ${localDir}` };
  }
  if (region.sqliteSize != null && actualSize !== region.sqliteSize) {
    return {
      regionId,
      status: 'SIZE_MISMATCH',
      detail: `on-disk ${actualSize} B != manifest ${region.sqliteSize} B`,
    };
  }
  // `gzip -t` validates the full DEFLATE stream, CRC32, and ISIZE footer.
  const { code, stderr } = await runShell(`gzip -t "${path}"`);
  if (code !== 0) {
    return { regionId, status: 'CORRUPT', detail: stderr || `gzip -t exited ${code}` };
  }
  return { regionId, status: 'ok', detail: `${(actualSize / 1024 / 1024).toFixed(1)} MB` };
}

/**
 * Remote mode: two checks, a strict superset of the old HEAD-only verify —
 *   1. best-effort HEAD Content-Length vs manifest (catches manifest/asset DRIFT,
 *      the 2026-04-03 re-upload incident this workflow was born for), then
 *   2. stream the asset straight into `gzip -t` (catches a truncated-but-size-
 *      consistent asset the HEAD check is blind to — the BUG-242/243 case).
 * Streaming means constant disk regardless of region size (largest ~575 MB).
 */
async function checkRemote(regionId: string, region: ManifestRegion, baseUrl: string): Promise<Result> {
  const url = `${baseUrl}/${regionId}.sqlite.gz`;

  // 1. Best-effort size check (drift). Skips silently if HEAD is unavailable so a
  //    flaky HEAD never false-fails — the decompress test below is the hard gate.
  if (region.sqliteSize != null) {
    try {
      const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const len = Number(head.headers.get('content-length'));
      if (head.ok && Number.isFinite(len) && len > 0 && len !== region.sqliteSize) {
        return {
          regionId,
          status: 'SIZE_MISMATCH',
          detail: `asset Content-Length ${len} B != manifest ${region.sqliteSize} B`,
        };
      }
    } catch {
      /* HEAD unavailable — fall through to the decompress test */
    }
  }

  // 2. Decompress test. pipefail so a curl failure (HTTP error / truncated
  //    transfer) OR a gzip failure (bad DEFLATE / CRC / ISIZE) fails the check.
  //    --fail: non-2xx => non-zero.
  const cmd =
    `set -o pipefail; ` +
    `curl -sSL --fail --retry 3 --retry-delay 2 --max-time ${CURL_MAX_TIME_SECONDS} ` +
    `"${url}" | gzip -t`;
  const { code, stderr } = await runShell(cmd);
  if (code !== 0) {
    return { regionId, status: 'CORRUPT', detail: (stderr || `exit ${code}`).slice(0, 300) };
  }
  return { regionId, status: 'ok', detail: 'streamed + decompressed clean' };
}

/**
 * Same two checks for the Valhalla offline-routing pack, when the manifest pins one.
 *
 * WHY A SEPARATE RESULT AND NOT A FIELD ON THE REGION'S: collapsing both assets
 * into one verdict lets a healthy .sqlite.gz mask a missing routing pack, and
 * that is the one failure the app can never report — a manifest whose region has
 * no usable valhallaSize makes the pack download return early, after which the
 * app silently routes via Mapbox forever with offline capability dead. The whole
 * point of checking here is that nothing downstream ever will.
 *
 * WHY A DIFFERENT BASE URL: the packs do NOT live on the monthly release. It sits
 * at ~937 assets against GitHub's hard 1000 cap, so 233 tars can never ride it;
 * they get their own `valhalla-<version>` release. That release is a PRERELEASE,
 * so it can never BE `latest` — a releases/latest/download URL here could only
 * ever 404. This builds the same version-pinned URL the app builds
 * (buildValhallaPackUrl in the Rods repo), so it verifies the URL a device will
 * really request rather than one that merely resembles it.
 */
async function checkRemoteValhalla(
  regionId: string,
  region: ManifestRegion,
  manifestVersion: string,
  repoBase: string,
): Promise<Result> {
  const url = `${repoBase}/releases/download/valhalla-${manifestVersion}/${regionId}-valhalla.tar.gz`;
  const label = `${regionId} [valhalla]`;

  if (region.valhallaSize != null) {
    try {
      const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const len = Number(head.headers.get('content-length'));
      if (head.ok && Number.isFinite(len) && len > 0 && len !== region.valhallaSize) {
        return {
          regionId: label,
          status: 'SIZE_MISMATCH',
          detail: `asset Content-Length ${len} B != manifest ${region.valhallaSize} B`,
        };
      }
    } catch {
      /* HEAD unavailable — the decompress test below is the hard gate */
    }
  }

  // ── THE CHECKSUM TEST, and why it REPLACES gzip -t here rather than joining it
  //
  // valhallaChecksum is the field the APP enforces: valhallaPackManager verifies
  // the downloaded tar's sha256 prefix against it and rejects the pack on a
  // mismatch. Nothing verified that field until now — the release could serve a
  // well-formed gzip that simply is not the file the manifest describes, and
  // every device would download it, reject it, and retry forever while this
  // workflow reported green.
  //
  // A matching sha256 is STRICTLY STRONGER than `gzip -t` for this asset: the
  // build job already proved THIS byte sequence unpacks and routes (structure
  // check + a sanity route run in tile_extract mode against the tar gunzipped
  // from the shipped asset). Identical bytes therefore inherit that proof, while
  // `gzip -t` alone only ever proved well-formedness — never identity. So it is
  // one stream, not two, and 45 GB of daily transfer instead of 90.
  //
  // sha256sum on Linux runners, shasum on a developer's mac. Resolved once in
  // the shell so this is runnable locally without a second code path.
  if (region.valhallaChecksum) {
    const cmd =
      `set -o pipefail; SHA=$(command -v sha256sum || echo "shasum -a 256"); ` +
      `curl -sSL --fail --retry 3 --retry-delay 2 --max-time ${CURL_MAX_TIME_SECONDS} ` +
      `"${url}" | $SHA | cut -c1-16`;
    const { code, stdout, stderr } = await runShell(cmd);
    if (code !== 0) {
      return { regionId: label, status: 'CORRUPT', detail: (stderr || `exit ${code}`).slice(0, 300) };
    }
    const actual = stdout.trim();
    if (actual !== region.valhallaChecksum) {
      return {
        regionId: label,
        status: 'CHECKSUM_MISMATCH',
        detail: `served sha256[0:16] ${actual} != manifest ${region.valhallaChecksum} — the app WILL reject this pack`,
      };
    }
    return { regionId: label, status: 'ok', detail: `streamed, sha256 matches (${actual})` };
  }

  // No checksum pinned (should not happen for a published pack — generate-manifest
  // emits both fields together). Fall back to proving the asset is at least a
  // valid gzip, so a missing checksum degrades the check rather than skipping it.
  const cmd =
    `set -o pipefail; ` +
    `curl -sSL --fail --retry 3 --retry-delay 2 --max-time ${CURL_MAX_TIME_SECONDS} ` +
    `"${url}" | gzip -t`;
  const { code, stderr } = await runShell(cmd);
  if (code !== 0) {
    return { regionId: label, status: 'CORRUPT', detail: (stderr || `exit ${code}`).slice(0, 300) };
  }
  return { regionId: label, status: 'ok', detail: 'streamed + decompressed clean (NO checksum pinned)' };
}

// -----------------------------------------------------------------------------
// Concurrency pool
// -----------------------------------------------------------------------------

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<Result>): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  async function drain(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      const r = results[i];
      const icon = r.status === 'ok' ? '✓' : '✗';
      console.log(`  ${icon} ${r.regionId}: ${r.status}${r.status === 'ok' ? '' : ` — ${r.detail}`}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const { manifest, baseUrl } = await loadManifest();
  const mode = localDir ? `local dir ${localDir}` : `remote ${baseUrl}`;

  const regions = Object.entries(manifest.regions).filter(([, r]) => r.sqliteSize != null);
  console.log(`\n========================================`);
  console.log(`Verify Release Integrity — decompress-test every region`);
  console.log(`========================================`);
  console.log(`manifest version: ${manifest.version}`);
  console.log(`source: ${mode}`);
  console.log(`regions with sqlite: ${regions.length}  (concurrency ${concurrency})\n`);

  // ── VALHALLA-ONLY MODE ────────────────────────────────────────────────────
  //
  // The routing packs are delivered on their OWN release, whose manifest.json
  // carries valhallaSize/valhallaChecksum and nothing else — the app resolves
  // pins from there rather than from the monthly manifest, so that no binary
  // built before the feature was gated can ever see them. Pointed at that file,
  // the sqlite scan legitimately finds zero regions, and the guard below would
  // read it as "unexpected" and fail a run that is doing exactly what it should.
  //
  // A manifest with pack pins and no sqlite pins is therefore a VALID input, not
  // a broken one. The distinction is deliberate: zero of BOTH still fails,
  // because that really is a manifest with nothing to verify.
  const valhallaOnly = regions.length === 0
    && Object.values(manifest.regions).some((r) => r.valhallaSize != null);

  if (regions.length === 0 && !valhallaOnly) {
    console.error('::error::No regions with a sqliteSize OR a valhallaSize found in the manifest — nothing to verify (unexpected).');
    process.exit(1);
  }
  if (valhallaOnly) {
    console.log('valhalla-only manifest — skipping the sqlite pass, verifying routing packs only.\n');
  }

  const sqliteResults = regions.length === 0 ? [] : await runPool(regions, concurrency, ([regionId, region]) =>
    localDir ? checkLocal(regionId, region) : checkRemote(regionId, region, baseUrl!),
  );

  // Valhalla packs, only for regions that actually pin one. A region without the
  // field is NOT a failure: most legitimately have no routing pack until the
  // all-regions build lands, and flagging them would bury the real signal in 200
  // lines of noise exactly when it matters. Remote only — the packs live on their
  // own release and are never in the local dir a monthly release is assembled from.
  const valhallaRegions = localDir
    ? []
    : Object.entries(manifest.regions).filter(([, r]) => r.valhallaSize != null);
  let valhallaResults: Result[] = [];
  if (valhallaRegions.length > 0) {
    // baseUrl is <repo>/releases/latest/download; the packs hang off <repo> under
    // a different, version-pinned release.
    const repoBase = baseUrl!.replace(/\/releases\/.*$/, '');
    console.log(`regions with a valhalla pack: ${valhallaRegions.length}\n`);
    valhallaResults = await runPool(valhallaRegions, concurrency, ([regionId, region]) =>
      checkRemoteValhalla(regionId, region, manifest.version, repoBase),
    );
  }

  const results = [...sqliteResults, ...valhallaResults];
  const failures = results.filter((r) => r.status !== 'ok');
  console.log(`\n----------------------------------------`);
  console.log(`Checked: ${results.length}   Passed: ${results.length - failures.length}   Failed: ${failures.length}`);

  if (failures.length > 0) {
    console.log(`\nFAILED REGIONS:`);
    for (const f of failures) {
      console.log(`  - ${f.regionId} [${f.status}]: ${f.detail}`);
      // GitHub Actions annotation — surfaces on the run summary.
      // The asset name is NOT hardcoded to .sqlite.gz any more: a valhalla result
      // arrives labelled "<region> [valhalla]", and "<region> [valhalla].sqlite.gz"
      // would send whoever reads the annotation looking for a file that does not exist.
      const asset = f.regionId.endsWith(' [valhalla]')
        ? `${f.regionId.replace(' [valhalla]', '')}-valhalla.tar.gz`
        : `${f.regionId}.sqlite.gz`;
      console.error(`::error title=Region ${f.regionId} ${f.status}::${asset} failed integrity (${f.status}): ${f.detail}`);
    }
    console.error(
      `\n::error::${failures.length}/${results.length} region asset(s) are truncated/corrupt/missing. ` +
        `This release must NOT be considered finished. Re-extract the failed region(s) and re-publish.`,
    );
    process.exit(1);
  }

  console.log(`\n✓ All ${results.length} region assets decompressed cleanly. Release integrity verified.\n`);
}

main().catch((err) => {
  console.error(`::error::verify-release crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
