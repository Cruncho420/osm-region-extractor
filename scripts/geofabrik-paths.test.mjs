// Tests for the Geofabrik folder move (migrate-geofabrik-paths.mjs, check-geofabrik-paths.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stemMap, movePbfPath } from './migrate-geofabrik-paths.mjs';
import { addressesFor, runChecks } from './check-geofabrik-paths.mjs';

// A fake Geofabrik: `answers[path]` is a list of statuses, one per call (0 = no answer); the last one repeats.
function fakeHead(answers) {
  const calls = {};
  const fn = async (path) => {
    const list = answers[path] ?? [200];
    const n = calls[path] = (calls[path] ?? 0) + 1;
    return { status: list[Math.min(n, list.length) - 1], final: path };
  };
  fn.calls = calls;
  return fn;
}
const checksOf = (...paths) => paths.map((path) => ({ id: path, path }));

test('a 404 fails at once and is not rechecked', async () => {
  const head = fakeHead({ b: [404] });
  const r = await runChecks(checksOf('a', 'b'), head);
  assert.deepEqual(r.failed.map((f) => f.path), ['b']);
  assert.equal(r.notAnswering, false);
  assert.equal(head.calls.b, 1);
});

test('an address with no answer that answers on the recheck passes', async () => {
  const r = await runChecks(checksOf('a', 'b', 'c'), fakeHead({ b: [0, 200] }));
  assert.deepEqual(r.failed, []);
});

test('an address that stays silent fails as "Geofabrik not answering"', async () => {
  const r = await runChecks(checksOf('a', 'b'), fakeHead({ b: [0] }));
  assert.deepEqual(r.failed.map((f) => f.path), ['b']);
  assert.equal(r.notAnswering, true);
});

test('a mass hang stops after maxNoAnswer silent addresses without checking the rest', async () => {
  const paths = Array.from({ length: 100 }, (_, i) => `p${i}`);
  const head = fakeHead(Object.fromEntries(paths.map((p) => [p, [0]])));
  const r = await runChecks(checksOf(...paths), head, { maxNoAnswer: 30 });
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.notAnswering, true);
  assert.equal(Object.keys(head.calls).length, 31);
});

const index = { features: [
  { properties: { urls: { pbf: 'https://download.geofabrik.de/europe/germany/baden-wuerttemberg/baden-wuerttemberg-latest.osm.pbf' } } },
  { properties: { urls: { pbf: 'https://download.geofabrik.de/europe/austria/austria-latest.osm.pbf' } } },
] };

test('an old address maps to the folder Geofabrik serves it from; a moved one maps to itself', () => {
  const m = stemMap(index);
  assert.equal(movePbfPath('europe/germany/baden-wuerttemberg-latest.osm.pbf', m), 'europe/germany/baden-wuerttemberg/baden-wuerttemberg-latest.osm.pbf');
  assert.equal(movePbfPath('europe/austria-latest.osm.pbf', m), 'europe/austria/austria-latest.osm.pbf');
  assert.equal(movePbfPath('europe/austria/austria-latest.osm.pbf', m), 'europe/austria/austria-latest.osm.pbf');
  assert.equal(movePbfPath('europe/nowhere-latest.osm.pbf', m), null);
});

test('the check asks for the latest pbf, the poly and the dated pbf the build downloads', () => {
  assert.deepEqual(addressesFor('europe/austria/austria-latest.osm.pbf', '261101'),
    ['europe/austria/austria-latest.osm.pbf', 'europe/austria/austria.poly', 'europe/austria/austria-261101.osm.pbf']);
});

test('every region is on its own Geofabrik folder (the Nov 2026 layout)', () => {
  const regions = JSON.parse(readFileSync(new URL('./regions.json', import.meta.url), 'utf8')).regions;
  assert.equal(regions.length, 232);
  for (const r of regions) assert.match(r.geofabrikPath, /(^|\/)([^/]+)\/\2-latest\.osm\.pbf$/, r.id);
});
