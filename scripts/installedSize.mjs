/**
 * PURPOSE: Recover the UNCOMPRESSED size of a .gz asset — what it actually
 *          occupies on a phone after install — without downloading or
 *          decompressing it.
 * RESPONSIBILITY: read the gzip trailer, resolve the 32-bit wrap, refuse to
 *          guess when it cannot be resolved.
 * DEPENDENCIES: node:fs only.
 * CONSUMERS: generate-manifest.ts, merge-valhalla-fields.mjs.
 *
 * WHY THIS EXISTS: the manifest publishes only the COMPRESSED size, so the app
 * shows what a region costs to download and is silent about what it costs to
 * store. Measured 2026-08-21 on a Pixel 8a: europe-italy downloads 1,210,402,405
 * bytes and occupies 2,732,687,360 — 2.26x. A user with 2 GB free is told
 * "1.1 GB" and runs out of space mid-install.
 *
 * WHY THE GZIP TRAILER: build-sqlite.ts deletes the uncompressed .sqlite as soon
 * as it has gzipped it, so the number is gone by the time the manifest is built.
 * The trailer travels INSIDE the published asset, so it survives every path that
 * rebuilds the manifest from release assets — a sidecar file would not.
 * Verified against the live europe-italy asset: the trailer reads exactly
 * 2,732,687,360, matching the byte count measured on the device.
 *
 * THE 4 GiB WRAP, AND WHY WE REFUSE RATHER THAN GUESS: the trailer stores the
 * size modulo 2^32, so a >4 GiB payload is indistinguishable from a small one on
 * the trailer alone. We recover the true value by picking the only candidate
 * that lands inside a plausible compression ratio. When two candidates fit, the
 * answer is genuinely unknown and we return undefined — the field is omitted and
 * the app falls back to showing the download size alone. Publishing a plausible
 * wrong number is the exact defect this work exists to remove.
 */

import { openSync, readSync, closeSync, fstatSync } from 'fs';

/**
 * Observed gzip ratios for the assets this is used on (measured 2026-08-21
 * against the live release): region sqlite 2.13x (lithuania) and 2.26x (italy),
 * valhalla routing pack 2.48x (italy).
 *
 * The window must be NARROWER THAN 4 GiB across the largest asset or two
 * candidates fit and we refuse. At the largest published sqlite.gz (~1.71 GB)
 * a 2.0x-wide window spans ~3.4 GB, which is inside 4 GiB — so this pair keeps
 * every current region resolvable while leaving real margin around the
 * measured 2.1-2.5x.
 */
export const MIN_RATIO = 1.5;
export const MAX_RATIO = 3.5;

const FOUR_GIB = 2 ** 32;

/**
 * Above this expansion factor we would not believe a map asset anyway. Used ONLY
 * to decide whether a 32-bit wrap was possible at all — not to judge a size.
 */
export const NO_WRAP_RATIO = 20;

/** Last 4 bytes of a gzip file: uncompressed size, little-endian, mod 2^32. */
export function readGzipTrailerSize(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { size } = fstatSync(fd);
    if (size < 18) return null; // smaller than a valid empty gzip member
    readSync(fd, buf, 0, 4, size - 4);
    return buf.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
}


/**
 * Resolve the true uncompressed size, or undefined when it cannot be known.
 * Exported separately from the file read so the wrap logic is testable without
 * fabricating multi-gigabyte fixtures.
 */
export function resolveInstalledSize(trailerSize, compressedSize) {
  if (!Number.isInteger(trailerSize) || trailerSize < 0) return undefined;
  if (!Number.isInteger(compressedSize) || compressedSize <= 0) return undefined;

  // TIER 1 — wrap is IMPOSSIBLE, so the trailer is exact and no ratio judgement
  // is needed. Anything this small cannot reach 4 GiB even at an absurd ratio,
  // and most regions land here (the largest sqlite.gz today is ~1.71 GB, but the
  // median is a few tens of MB). Applying the narrow ratio window here would
  // wrongly refuse a region that simply compresses very well.
  if (compressedSize * NO_WRAP_RATIO <= FOUR_GIB) return trailerSize;

  // TIER 2 — big enough that the payload could have exceeded 4 GiB, so the
  // trailer is ambiguous. Pick the only candidate inside the measured ratio
  // band; if two fit, the answer is unknowable and we publish nothing.
  const lo = compressedSize * MIN_RATIO;
  const hi = compressedSize * MAX_RATIO;

  const fits = [];
  for (let k = 0; k * FOUR_GIB <= hi; k++) {
    const candidate = trailerSize + k * FOUR_GIB;
    if (candidate >= lo && candidate <= hi) fits.push(candidate);
    if (fits.length > 1) return undefined; // ambiguous — refuse
  }
  return fits.length === 1 ? fits[0] : undefined;
}

/** Convenience: read the trailer and resolve, returning undefined on any doubt. */
export function installedSizeFromGzip(path, compressedSize) {
  let trailer;
  try {
    trailer = readGzipTrailerSize(path);
  } catch {
    return undefined;
  }
  if (trailer === null) return undefined;
  return resolveInstalledSize(trailer, compressedSize);
}
