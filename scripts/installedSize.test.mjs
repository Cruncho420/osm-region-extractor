/**
 * PURPOSE: pin the on-device size recovery in installedSize.mjs.
 * RESPONSIBILITY: the two tiers, the refusal, and one real gzip round-trip.
 * CONSUMERS: `npm test` in scripts/.
 *
 * The load-bearing case is REFUSE-WHEN-AMBIGUOUS. Publishing a plausible but
 * wrong installed size is the exact defect this feature exists to remove, so a
 * regression that starts guessing must turn this file red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveInstalledSize,
  installedSizeFromGzip,
  readGzipTrailerSize,
  MIN_RATIO,
  MAX_RATIO,
  NO_WRAP_RATIO,
} from './installedSize.mjs';

const FOUR_GIB = 2 ** 32;

test('no-wrap tier: trailer is taken verbatim, whatever the ratio', () => {
  // 4,905 compressed -> 2,000,000 real is a 408x ratio. Far outside the ratio
  // band, but far too small to have wrapped, so the trailer is simply true.
  assert.equal(resolveInstalledSize(2_000_000, 4_905), 2_000_000);
});

test('wrap tier: europe-italy resolves to the size measured on the device', () => {
  // Live values 2026-08-21. 2,732,687,360 is what the file occupies on a Pixel
  // 8a; 1,210,402,405 is what the manifest publishes as the download.
  assert.equal(resolveInstalledSize(2_732_687_360 % FOUR_GIB, 1_210_402_405), 2_732_687_360);
});

test('wrap tier: the largest published region still resolves', () => {
  // asia-russia, the biggest sqlite.gz there is. If the ratio window is ever
  // widened past ~2.0x this case goes ambiguous and starts returning undefined.
  assert.equal(resolveInstalledSize(3_750_500_000 % FOUR_GIB, 1_707_900_000), 3_750_500_000);
});

test('REFUSES rather than guessing when two candidates fit', () => {
  // Big enough that the ratio window spans more than 4 GiB, so the trailer
  // cannot distinguish one payload from another 4 GiB larger.
  assert.equal(resolveInstalledSize(500_000_000, 3_000_000_000), undefined);
});

test('rejects nonsense inputs instead of returning a number', () => {
  assert.equal(resolveInstalledSize(-1, 1000), undefined);
  assert.equal(resolveInstalledSize(1.5, 1000), undefined);
  assert.equal(resolveInstalledSize(1000, 0), undefined);
  assert.equal(resolveInstalledSize(1000, -5), undefined);
  assert.equal(resolveInstalledSize(undefined, 1000), undefined);
});

test('the ratio band brackets every ratio measured on the live release', () => {
  // Sampled 2026-08-21 across the size range: andorra 2.41, china-shaanxi 2.57,
  // ethiopia 2.40, france-rhone-alpes 2.18, spain 2.38, italy 2.26, japan 2.29,
  // russia 2.20 — plus the valhalla routing pack at 2.48.
  for (const observed of [2.18, 2.20, 2.26, 2.29, 2.38, 2.40, 2.41, 2.48, 2.57]) {
    assert.ok(observed > MIN_RATIO, `${observed}x must sit above MIN_RATIO ${MIN_RATIO}`);
    assert.ok(observed < MAX_RATIO, `${observed}x must sit below MAX_RATIO ${MAX_RATIO}`);
  }
  // And the window must stay narrower than 4 GiB at the largest asset, or that
  // asset becomes unresolvable.
  assert.ok(1_707_900_000 * (MAX_RATIO - MIN_RATIO) < FOUR_GIB);
  assert.ok(NO_WRAP_RATIO > MAX_RATIO);
});

test('reads the trailer off a real gzip file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'installed-size-'));
  const raw = join(dir, 'sample.bin');
  writeFileSync(raw, Buffer.from('the quick brown fox '.repeat(100_000)));
  const realSize = statSync(raw).size;
  execSync(`gzip -9 -k -f "${raw}"`);
  const gz = `${raw}.gz`;
  assert.equal(readGzipTrailerSize(gz), realSize);
  assert.equal(installedSizeFromGzip(gz, statSync(gz).size), realSize);
});

test('a missing or unreadable file yields undefined, never a throw', () => {
  assert.equal(installedSizeFromGzip('/nope/does/not/exist.gz', 1000), undefined);
});
