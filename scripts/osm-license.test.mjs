/**
 * PURPOSE: Keep the ODbL notice (Rods ODBL-LEGAL-REVIEW 2026-10-27, option A) in every pack, manifest and release.
 * RESPONSIBILITY: Pin the exact text and prove the three writers read it from osm-license.json.
 * DEPENDENCIES: osm-license.json, build-sqlite.ts, generate-manifest.ts, osm-extract.yml as text.
 * CONSUMERS: npm test and Scripts Tests GitHub workflow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const lic = JSON.parse(read('./osm-license.json'));

test('notice text is the owner-approved line', () => {
  assert.equal(
    lic.attribution,
    '© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) v1.0 — https://www.openstreetmap.org/copyright — https://opendatacommons.org/licenses/odbl/1-0/',
  );
  assert.equal(lic.license, 'ODbL-1.0');
});

test('pack metadata, manifest and release notes all take the notice from osm-license.json', () => {
  assert.match(read('./build-sqlite.ts'), /insertMeta\.run\('license', OSM_LICENSE\.license\)[\s\S]*insertMeta\.run\('attribution', OSM_LICENSE\.attribution\)/);
  assert.match(read('./generate-manifest.ts'), /license: \{\s*name: OSM_LICENSE\.license,\s*attribution: OSM_LICENSE\.attribution/);
  const wf = read('../.github/workflows/osm-extract.yml');
  assert.match(wf, /jq -r \.attribution scripts\/osm-license\.json/);
  assert.match(wf, /release-files\/ATTRIBUTION\.txt/);
  assert.match(wf, /\*\*License:\*\* \$\{ATTRIBUTION\}/);
});
