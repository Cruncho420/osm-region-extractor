/**
 * chain-workflow-name.test.mjs — the monthly chain's silent-no-op guard.
 *
 * PURPOSE: `.github/workflows/chain-valhalla-after-extract.yml` fires on
 *   `workflow_run: workflows: ["Monthly OSM Data Extraction"]`. GitHub matches
 *   that against the other workflow's `name:` FIELD, not its filename. Rename
 *   `osm-extract.yml`'s `name:` and the chain simply never fires again — no
 *   error, no annotation, no failed run. The first symptom would be routing
 *   packs quietly falling a month behind the road data, which is the exact
 *   defect (BUG-626, Rods repo) this whole chain exists to prevent.
 *
 *   So the rename has to break something loudly. This is that something.
 *
 * RESPONSIBILITY: text assertions over the workflow YAML. No YAML parser — the
 *   repo deliberately has no such dependency, and the strings under test are
 *   single-line literals that a regex reads exactly.
 * DEPENDENCIES: node:test, node:fs.
 * CONSUMERS: `npm test` in scripts/ (.github/workflows/scripts-tests.yml).
 *
 * ⚠️ WHAT THIS DOES NOT PROVE: that a real extract completion starts a real
 * chain run. That cannot be tested without running the monthly extract, and it
 * stays UNPROVEN until the first live firing. What is proven here is that the
 * two strings agree, which is the only way the match can silently rot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, '.github', 'workflows', p), 'utf8');

const chain = read('chain-valhalla-after-extract.yml');
const extract = read('osm-extract.yml');
const tiles = read('valhalla-tiles.yml');

test('the chain listens for the extract workflow by its exact name', () => {
  // `name:` at column 0 — the workflow-level name, not a step's.
  const extractName = /^name:\s*(.+?)\s*$/m.exec(extract);
  assert.ok(extractName, 'osm-extract.yml has no top-level name:');

  const listened = /workflows:\s*\[\s*"([^"]+)"\s*\]/.exec(chain);
  assert.ok(listened, 'the chain has no workflows: ["..."] entry');

  assert.equal(
    listened[1],
    extractName[1],
    'chain-valhalla-after-extract.yml listens for a workflow name that osm-extract.yml no longer has — ' +
      'the chain would never fire again, silently. Update the workflows: entry in the same commit as the rename.',
  );
});

test('the chain only acts on a SUCCESSFUL extract', () => {
  // A failed extract demotes its release back to draft, so `releases/latest`
  // still points at last month. Acting on it would rebuild a vintage we have.
  assert.match(chain, /github\.event\.workflow_run\.conclusion == 'success'/);
});

test('the chain passes all four tile-build inputs explicitly', () => {
  // None of these is `required: true` in valhalla-tiles.yml, so an omitted one
  // silently takes its default — which is the 3-region SMOKE set on a smoke tag.
  const dispatch = chain.slice(chain.lastIndexOf('gh workflow run valhalla-tiles.yml'));
  for (const flag of ['-f regions=', '-f tag=', '-f upload=true', '-f prune_old_smoke=false']) {
    assert.ok(dispatch.includes(flag), `the real dispatch is missing ${flag}`);
  }
});

test('the chain targets a production tag, never a smoke tag', () => {
  // `valhalla-YYYY-MM-DD` is the ONLY value that selects the production channel
  // in prepare-release; a smoke tag would publish packs no client resolves.
  assert.match(chain, /target_tag=valhalla-\$VERSION/);
  assert.doesNotMatch(chain, /-f tag=valhalla-smoke/);
});

test('the chain derives the version from the release tag, never from the clock', () => {
  // Stamping today's date publishes `valhalla-<today>` while every client asks
  // for `valhalla-<manifest version>` — a 404 for every region.
  assert.match(chain, /VERSION="\$\{OSM_TAG#osm-\}"/);
  assert.doesNotMatch(chain, /VERSION=\$\(date/);
});

test('valhalla-tiles.yml is still dispatch-only', () => {
  // The chain's whole design depends on this: a `workflow_run` trigger over
  // there does not merely violate policy, it does not WORK — every job carries
  // this gate, so the graph skips silently under any other event. If someone
  // removes these gates, the chain's front-door approach needs rethinking.
  const gates = tiles.match(/if:\s*github\.event_name == 'workflow_dispatch'/g) ?? [];
  assert.ok(
    gates.length >= 2,
    `valhalla-tiles.yml should gate get-regions AND prepare-release on workflow_dispatch; found ${gates.length}`,
  );
  assert.doesNotMatch(tiles, /^\s*workflow_run:/m, 'valhalla-tiles.yml must stay dispatch-only');
});
