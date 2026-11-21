// Tests for the Geofabrik folder move (migrate-geofabrik-paths.mjs, check-geofabrik-paths.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stemMap, movePbfPath } from './migrate-geofabrik-paths.mjs';
import { addressesFor } from './check-geofabrik-paths.mjs';

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
