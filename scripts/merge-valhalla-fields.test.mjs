/**
 * PURPOSE: prove merge-valhalla-fields.mjs cannot damage the production manifest.
 * RESPONSIBILITY: the refusal cases. The happy path is one test; the other nine
 *   are the ways this could quietly break every device in the fleet.
 * DEPENDENCIES: node:test, node:assert (stdlib — the extractor has no test
 *   runner and this is not worth a dependency).
 * CONSUMERS: `npm test` in scripts/, run by merge-valhalla-manifest.yml BEFORE
 *   it is allowed to touch a release asset.
 *
 * Run: cd scripts && node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeValhallaFields, assertAdditiveOnly, MergeRefused } from './merge-valhalla-fields.mjs';

const SHA_A = 'a1b2c3d4e5f60718';
const SHA_B = '00112233445566aa';

function baseManifest(extra = {}) {
  return {
    version: '2026-08-02',
    generatedAt: '2026-08-02T09:00:00Z',
    regions: {
      'europe-lithuania': { name: 'Lithuania', size: 100, checksum: 'aaaabbbbccccdddd', sqliteSize: 80_000_000, sqliteChecksum: 'ffffeeeeddddcccc' },
      'europe-italy': { name: 'Italy', size: 200, checksum: '1111222233334444', sqliteSize: 1_210_000_000, sqliteChecksum: '5555666677778888' },
      ...extra,
    },
  };
}

function valhallaManifest(regions) {
  return { version: '2026-08-02', generatedAt: '2026-08-09T10:00:00Z', regions };
}

test('adds the two fields and leaves everything else byte-identical', () => {
  const base = baseManifest();
  const { manifest, report } = mergeValhallaFields(
    base,
    valhallaManifest({ 'europe-lithuania': { valhallaSize: 82_000_000, valhallaChecksum: SHA_A } }),
  );

  assert.equal(manifest.regions['europe-lithuania'].valhallaSize, 82_000_000);
  assert.equal(manifest.regions['europe-lithuania'].valhallaChecksum, SHA_A);
  // The untouched region must not gain the keys at all — absent, not null.
  assert.equal('valhallaSize' in manifest.regions['europe-italy'], false);
  // Pre-existing data survives verbatim.
  assert.equal(manifest.regions['europe-lithuania'].sqliteChecksum, 'ffffeeeeddddcccc');
  assert.equal(manifest.version, '2026-08-02');
  assert.equal(manifest.generatedAt, '2026-08-02T09:00:00Z');
  assert.equal(report.covered, 1);
  assert.deepEqual(report.missing, ['europe-italy']);
});

test('does not mutate the base object it was handed', () => {
  const base = baseManifest();
  mergeValhallaFields(base, valhallaManifest({ 'europe-italy': { valhallaSize: 1, valhallaChecksum: SHA_A } }));
  assert.equal('valhallaSize' in base.regions['europe-italy'], false);
});

/**
 * THE 404 CASE. The app builds releases/download/valhalla-${manifestVersion}/…,
 * so merging a 2026-09-01 pack set into the 2026-08-02 manifest publishes URLs
 * that cannot resolve, from a run that reported success.
 */
test('refuses a version mismatch between the two manifests', () => {
  const wrong = { ...valhallaManifest({}), version: '2026-09-01' };
  wrong.regions = { 'europe-lithuania': { valhallaSize: 1, valhallaChecksum: SHA_A } };
  assert.throws(() => mergeValhallaFields(baseManifest(), wrong), MergeRefused);
});

test('refuses a region the base manifest does not define', () => {
  assert.throws(
    () => mergeValhallaFields(baseManifest(), valhallaManifest({ 'atlantis': { valhallaSize: 1, valhallaChecksum: SHA_A } })),
    MergeRefused,
  );
});

test('refuses a non-positive or non-integer size', () => {
  for (const bad of [0, -1, 1.5, '82000000', null, undefined]) {
    assert.throws(
      () => mergeValhallaFields(baseManifest(), valhallaManifest({ 'europe-italy': { valhallaSize: bad, valhallaChecksum: SHA_A } })),
      MergeRefused,
      `size ${JSON.stringify(bad)} should be refused`,
    );
  }
});

/**
 * The app compares with startsWith(), so a truncated or upper-case checksum
 * would silently never match and every download would fail integrity — which
 * looks like a corrupt asset, not a bad manifest.
 */
test('refuses a checksum that is not 16 lowercase hex chars', () => {
  for (const bad of ['A1B2C3D4E5F60718', 'a1b2c3d4', 'a1b2c3d4e5f6071', 'a1b2c3d4e5f60718ff', 'zzzzzzzzzzzzzzzz', '']) {
    assert.throws(
      () => mergeValhallaFields(baseManifest(), valhallaManifest({ 'europe-italy': { valhallaSize: 1, valhallaChecksum: bad } })),
      MergeRefused,
      `checksum ${JSON.stringify(bad)} should be refused`,
    );
  }
});

test('re-running with identical values is idempotent, not an error', () => {
  const first = mergeValhallaFields(
    baseManifest(),
    valhallaManifest({ 'europe-lithuania': { valhallaSize: 82_000_000, valhallaChecksum: SHA_A } }),
  ).manifest;
  const second = mergeValhallaFields(
    first,
    valhallaManifest({ 'europe-lithuania': { valhallaSize: 82_000_000, valhallaChecksum: SHA_A } }),
  );
  assert.deepEqual(second.manifest, first);
  assert.equal(second.report.unchanged, 1);
  assert.deepEqual(second.report.updated, []);
});

/**
 * europe-spain, 2026-07-03: an asset was replaced in place, the manifest was
 * not regenerated, and the mismatch survived a month because every size-based
 * check agreed with itself. A checksum moving under a fixed tag is that shape.
 */
test('refuses a checksum change under the same tag unless explicitly allowed', () => {
  const published = mergeValhallaFields(
    baseManifest(),
    valhallaManifest({ 'europe-lithuania': { valhallaSize: 82_000_000, valhallaChecksum: SHA_A } }),
  ).manifest;
  const rebuilt = valhallaManifest({ 'europe-lithuania': { valhallaSize: 82_000_001, valhallaChecksum: SHA_B } });

  assert.throws(() => mergeValhallaFields(published, rebuilt), MergeRefused);

  const forced = mergeValhallaFields(published, rebuilt, { allowChecksumChange: true });
  assert.equal(forced.manifest.regions['europe-lithuania'].valhallaChecksum, SHA_B);
  assert.deepEqual(forced.report.updated, ['europe-lithuania']);
});

test('refuses a base manifest with no regions object', () => {
  assert.throws(() => mergeValhallaFields({ version: '2026-08-02' }, valhallaManifest({})), MergeRefused);
});

/**
 * A run that changes nothing and reports success is worse than one that fails:
 * there is no failure to investigate. The realistic cause is a valhalla_tag
 * pointing at a release whose manifest.json never landed.
 */
test('refuses a valhalla manifest that covers no regions at all', () => {
  assert.throws(() => mergeValhallaFields(baseManifest(), valhallaManifest({})), MergeRefused);
});

/**
 * assertAdditiveOnly used to iterate the BASE's keys only, so a new top-level
 * property written onto the merged object would pass unnoticed — the exact
 * "one edit away from a hole" case the guard exists to prevent. Asserted via the
 * exported helper because no current code path produces it; the point is that the
 * NEXT edit to the merge function cannot introduce one silently.
 */
test('assertAdditiveOnly catches a NEW top-level key, not just a changed one', () => {
  const base = baseManifest();
  const merged = JSON.parse(JSON.stringify(base));
  merged.publishedBy = 'some-new-workflow';
  assert.throws(() => assertAdditiveOnly(base, merged), MergeRefused);
});

test('assertAdditiveOnly still catches a CHANGED top-level key', () => {
  const base = baseManifest();
  const merged = JSON.parse(JSON.stringify(base));
  merged.generatedAt = '2026-09-01T00:00:00Z';
  assert.throws(() => assertAdditiveOnly(base, merged), MergeRefused);
});

test('covers every region when the full set is supplied', () => {
  const { report } = mergeValhallaFields(
    baseManifest(),
    valhallaManifest({
      'europe-lithuania': { valhallaSize: 82_000_000, valhallaChecksum: SHA_A },
      'europe-italy': { valhallaSize: 1_240_000_000, valhallaChecksum: SHA_B },
    }),
  );
  assert.equal(report.covered, 2);
  assert.deepEqual(report.missing, []);
});
