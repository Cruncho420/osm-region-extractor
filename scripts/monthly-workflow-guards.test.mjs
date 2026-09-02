/**
 * PURPOSE: Keep the BUG-819 upstream-pressure and owner-notification workflow contract executable.
 * RESPONSIBILITY: Detect YAML edits that restore unsafe concurrency or silent terminal failures.
 * DEPENDENCIES: osm-extract.yml as plain text.
 * CONSUMERS: npm test and Scripts Tests GitHub workflow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/osm-extract.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const failureWorkflow = readFileSync(fileURLToPath(new URL('../.github/workflows/notify-osm-failure.yml', import.meta.url)), 'utf8');
const testWorkflow = readFileSync(fileURLToPath(new URL('../.github/workflows/test-osm-notification.yml', import.meta.url)), 'utf8');

test('monthly extraction limits shared-upstream downloads to four', () => {
  assert.match(workflow, /max-parallel:\s*4\b/);
});

test('notification delivery test is isolated from the extraction workflow', () => {
  assert.doesNotMatch(workflow, /notification_test/);
  assert.match(testWorkflow, /name: Test OSM Discord Notification/);
  assert.doesNotMatch(testWorkflow, /extract|release/);
});

test('independent terminal monitor covers every non-success conclusion', () => {
  assert.match(failureWorkflow, /workflows: \["Monthly OSM Data Extraction", "Chain Valhalla Tiles After Monthly Extract", "Valhalla Graph Tiles \(Smoke\)"\]/);
  assert.match(failureWorkflow, /types: \[completed\]/);
  assert.match(failureWorkflow, /conclusion != 'success'/);
  assert.match(failureWorkflow, /actions: read/);
  assert.match(failureWorkflow, /contents: write/);
  assert.match(failureWorkflow, /actions\/runs\/\$RUN_ID\/jobs/);
  assert.match(failureWorkflow, /secrets\.OPS_SUPABASE_URL/);
  assert.match(failureWorkflow, /secrets\.OPS_SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(failureWorkflow, /jq -e '\.ok == true'/);
  assert.doesNotMatch(failureWorkflow, /\| head /);
  assert.match(failureWorkflow, /\[0:8\]/);
});

test('same-day retries refuse to delete an already-published release', () => {
  assert.match(workflow, /A published \$TAG already exists\. Refusing to replace/);
  assert.doesNotMatch(workflow, /gh release delete "\$TAG" --yes/);
});

test('release rollback is the final step and runs after any earlier failure', () => {
  const rollback = workflow.indexOf('- name: Un-publish the release if any release job step failed');
  assert.ok(rollback > workflow.indexOf('- name: Summary'));
  assert.equal(workflow.slice(rollback).match(/\n\s+- name:/g), null);
  assert.match(workflow.slice(rollback), /if: failure\(\) && steps\.publish-release\.outputs\.created == 'true'/);
  assert.match(workflow, /<!-- osm-workflow-run:\$\{\{ github\.run_id \}\} -->/);
  assert.match(failureWorkflow, /MARKER="<!-- osm-workflow-run:\$RUN_ID -->"/);
  assert.match(failureWorkflow, /contains\(\$marker\)/);
  assert.match(failureWorkflow, /gh release edit "\$TAG" --draft=true/);
  assert.match(failureWorkflow, /ROLLBACK_STATUS="FAILED to demote/);
  assert.match(failureWorkflow, /Release state is unverified\. Inspect releases immediately/);
  assert.match(failureWorkflow, /RELEASE_GUIDANCE="The previous complete map\/routing release remains live\."/);
  assert.doesNotMatch(failureWorkflow, /\$ROLLBACK_STATUS[\s\S]{0,200}\n\s+The previous complete map\/routing release remains live/);
});
