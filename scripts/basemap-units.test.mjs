/**
 * PURPOSE: prove which map files a basemap release carries (split countries → pieces only).
 * DEPENDENCIES: node:test. CONSUMERS: `npm test` in scripts/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { basemapUnits } from './basemap-units.mjs';

const regions = { regions: [
  { id: 'europe-lithuania', geofabrikPath: 'europe/lithuania-latest.osm.pbf' },
  { id: 'europe-great-britain', geofabrikPath: 'europe/great-britain-latest.osm.pbf' },
] };
const slices = { countries: [{ country: 'europe-great-britain', pieces: [
  { id: 'gb-north', sources: ['a'], outline: { union: ['a'] } },
  { id: 'gb-south', sources: ['europe/uk/england'], mapMaxZoom: 12 },
] }] };

test('a split country is replaced by its pieces, never shipped whole', () => {
  const units = basemapUnits(regions, slices);
  assert.deepEqual(units.map((u) => u.id), ['europe-lithuania', 'gb-north', 'gb-south']);
  assert.deepEqual(units[0], { id: 'europe-lithuania', poly: 'europe/lithuania', maxZoom: null, country: null });
  assert.equal(units[1].poly, 'stored:gb-north');
  assert.equal(units[2].poly, 'europe/uk/england', 'single-source piece clips with its Geofabrik outline');
  assert.equal(units[2].maxZoom, 12);
  assert.equal(units[2].country, 'europe-great-britain');
});

test('refuses a split country that regions.json does not know', () => {
  assert.throws(() => basemapUnits({ regions: [] }, slices), /missing from regions.json/);
});

test('the real config: 12 split countries become 36 pieces, every stored outline exists', () => {
  const real = basemapUnits(JSON.parse(readFileSync('regions.json', 'utf8')), JSON.parse(readFileSync('region-slices.json', 'utf8')));
  const pieces = real.filter((u) => u.country);
  assert.equal(new Set(pieces.map((u) => u.country)).size, 12);
  assert.equal(pieces.length, 36);
  for (const u of pieces.filter((p) => p.poly.startsWith('stored:'))) {
    assert.ok(existsSync(`polys/${u.id}.poly`), `polys/${u.id}.poly`);
  }
  assert.ok(!real.some((u) => u.id === 'europe-great-britain'), 'no whole GB map file');
});
