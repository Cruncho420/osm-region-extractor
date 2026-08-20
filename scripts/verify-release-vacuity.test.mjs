/**
 * verify-release-vacuity.test.mjs — a verifier that checked nothing must not say "verified".
 *
 * PURPOSE: verify-release is the last gate between a damaged release and every
 *   app install. Found 2026-08-20 by running it rather than reading it: pointed
 *   at a valhalla-only manifest in LOCAL mode (`--dir`), it passed the
 *   "is this a valid input" gate — that manifest does pin valhalla assets — then
 *   checked zero of them, because the valhalla pass is remote-only by design
 *   (packs live on their own release, never in a monthly release's local dir),
 *   and finished with:
 *
 *     ✓ All 0 region assets decompressed cleanly. Release integrity verified.
 *
 *   Exit code 0. A wrong flag combination declaring the release sound is worse
 *   than no verifier at all, because it is believed.
 *
 * RESPONSIBILITY: spawn the real script and assert its exit code and message.
 *   Behavioural, not textual — it runs the same entry point CI runs.
 * DEPENDENCIES: node:test, tsx (already a scripts/ dependency).
 * CONSUMERS: `npm test` in scripts/ (.github/workflows/scripts-tests.yml).
 *
 * REVERT-PROOF: delete the vacuity guard in verify-release.ts and this goes RED —
 * the script exits 0 and prints the success line instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** A manifest shaped exactly like a published valhalla release's: pack pins, no sqlite pins. */
const VALHALLA_ONLY = {
  version: '2026-08-02',
  generatedAt: '2026-08-10T05:30:14Z',
  regions: {
    'europe-lithuania': { valhallaSize: 80450692, valhallaChecksum: '859b8ef6b35d02fc' },
  },
};

function runVerify(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-vacuity-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const r = spawnSync('npx', ['tsx', 'verify-release.ts', '--dir', dir], {
      cwd: SCRIPTS,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('local mode over a valhalla-only manifest fails instead of reporting success', () => {
  const { code, out } = runVerify(VALHALLA_ONLY);

  assert.equal(code, 1, `expected exit 1, got ${code}. Output:\n${out}`);
  assert.match(out, /checked ZERO assets/i);
  // The specific trap: the old build printed this having verified nothing.
  assert.doesNotMatch(out, /Release integrity verified/);
});

test('the failure names the fix, not just the fault', () => {
  // An operator reading a red CI job needs the next command, not a diagnosis.
  // Without this the natural reaction is "the release is broken", and the real
  // answer is "you used the wrong mode".
  const { out } = runVerify(VALHALLA_ONLY);
  assert.match(out, /--manifest-url/);
});

test('a manifest pinning nothing at all still fails, as it always did', () => {
  // The pre-existing guard. Kept under test so the vacuity fix above cannot be
  // written in a way that swallows this earlier, different error.
  const { code, out } = runVerify({ version: '2026-08-02', generatedAt: 'x', regions: { 'europe-lithuania': {} } });
  assert.equal(code, 1, `expected exit 1, got ${code}. Output:\n${out}`);
  assert.match(out, /nothing to verify|checked ZERO assets/i);
});
