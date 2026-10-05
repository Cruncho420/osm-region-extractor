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

// Basemap chain (FEAT-090): same silent-no-op risk, same guards.
const basemapChain = read('chain-basemap-after-extract.yml');
test('the basemap chain listens for the extract by its exact name, on success only', () => {
  const extractName = read('osm-extract.yml').match(/^name:\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, '');
  assert.ok(basemapChain.includes(`workflows: ["${extractName}"]`), 'chain-basemap-after-extract.yml must listen for osm-extract.yml by its exact name');
  assert.match(basemapChain, /workflow_run\.conclusion == 'success'/);
});
test('the basemap chain dispatches every input explicitly, to a production tag from the release', () => {
  const dispatch = basemapChain.slice(basemapChain.lastIndexOf('gh workflow run basemap-tiles.yml'));
  for (const input of ['regions=all', 'tag="$TAG"', 'maxzoom=14', 'planet=', 'upload=true']) assert.ok(dispatch.includes(input), input);
  assert.match(basemapChain, /TAG="basemap-\$\{OSM_TAG#osm-\}"/);
  assert.doesNotMatch(basemapChain, /date -u/);
});

// OPS-monthly-run-1005 (5 Oct 2026): neither chain may publish from an unattended monthly run
// unless a human armed it for that exact tag. Runs each workflow's real gating block in bash.
import { spawnSync } from 'node:child_process';
function gate(workflow, env) {
  const block = workflow.match(/^( *)if \[ "\$EVENT" = workflow_dispatch \]; then\n[\s\S]*?^\1fi$/m);
  assert.ok(block, 'gating block not found');
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${block[0]}\necho "$DRY_RUN"`], { env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').pop();
}
for (const [name, wf, tagVar, tag] of [
  ['valhalla', chain, 'TARGET_TAG', 'valhalla-2026-11-01'],
  ['basemap', basemapChain, 'TAG', 'basemap-2026-11-01'],
]) {
  test(`the ${name} chain is a dry run unless armed for exactly this tag`, () => {
    const auto = { EVENT: 'workflow_run', MANUAL_DRY_RUN: '', [tagVar]: tag };
    assert.equal(gate(wf, { ...auto, ARMED_TAG: '' }), 'true', 'unarmed must be dry');
    assert.equal(gate(wf, { ...auto, ARMED_TAG: tag.replace('11-01', '10-05') }), 'true', 'armed for another month must be dry');
    assert.equal(gate(wf, { ...auto, ARMED_TAG: tag }), 'false', 'armed for this tag goes live');
    assert.equal(gate(wf, { EVENT: 'workflow_dispatch', MANUAL_DRY_RUN: 'true', ARMED_TAG: tag, [tagVar]: tag }), 'true');
    assert.equal(gate(wf, { EVENT: 'workflow_dispatch', MANUAL_DRY_RUN: 'false', ARMED_TAG: '', [tagVar]: tag }), 'false');
    assert.doesNotMatch(wf, /DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run \}\}/);
  });
}
