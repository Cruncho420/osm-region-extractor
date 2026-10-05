/**
 * manifest-pointers.test.mjs — a road-data refresh carries the routing-pack and map pointers forward.
 *
 * PURPOSE: Rods reads packs/maps from the releases manifest.json names (`valhallaPackTag`,
 *   `basemapTag`), else from `<prefix>-<version>`. Without carry-forward, every monthly refresh
 *   points phones at `valhalla-<today>` / `basemap-<today>`, which do not exist, and marks every
 *   installed pack stale (Rods doc/specs/mapbox-exit/results/OPS-monthly-run-1005.md §6).
 * RESPONSIBILITY: unit-test resolvePointers, and run the REAL generate-manifest.ts (as CI does)
 *   for carry-forward, seeding from an older manifest, the aligned-release override and refusals.
 * DEPENDENCIES: node:test, tsx (a scripts/ dependency).
 * CONSUMERS: `npm test` in scripts/ (.github/workflows/scripts-tests.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePointers } from './manifest-pointers.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const POINTED = { version: '2026-10-05', valhallaPackTag: 'valhalla-2026-09-02', basemapTag: 'basemap-2026-09-02', regions: {} };

test('carries both pointers forward from the previous manifest', () => {
  assert.deepEqual(resolvePointers(POINTED), { valhallaPackTag: 'valhalla-2026-09-02', basemapTag: 'basemap-2026-09-02' });
});

test('a previous manifest without pointers seeds what the app resolved from it', () => {
  assert.deepEqual(resolvePointers({ version: '2026-09-02', regions: {} }),
    { valhallaPackTag: 'valhalla-2026-09-02', basemapTag: 'basemap-2026-09-02' });
});

test('an override wins per field; the other field still carries forward', () => {
  assert.deepEqual(resolvePointers(POINTED, { valhallaPackTag: 'valhalla-2026-11-01' }),
    { valhallaPackTag: 'valhalla-2026-11-01', basemapTag: 'basemap-2026-09-02' });
  assert.deepEqual(resolvePointers(POINTED, { valhallaPackTag: '', basemapTag: undefined }),
    { valhallaPackTag: 'valhalla-2026-09-02', basemapTag: 'basemap-2026-09-02' });
});

test('no previous manifest and no override: no pointers (the app keeps deriving from the version)', () => {
  assert.deepEqual(resolvePointers(null), {});
  assert.deepEqual(resolvePointers(null, { basemapTag: 'basemap-2026-11-01' }), { basemapTag: 'basemap-2026-11-01' });
});

test('malformed values are refused, never written', () => {
  for (const bad of ['basemap-2026-11-01', 'valhalla-../x', 'valhalla-', 'valhalla-a/b']) {
    assert.throws(() => resolvePointers(POINTED, { valhallaPackTag: bad }), /valhallaPackTag from override/);
  }
  assert.throws(() => resolvePointers({ ...POINTED, basemapTag: 42 }), /basemapTag from previous manifest/);
  assert.throws(() => resolvePointers({ regions: {} }), /from previous manifest version/);
});

/** Run the real generate-manifest.ts over a one-region payload; returns { code, out, manifest }. */
function generate(previous, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-pointers-'));
  try {
    writeFileSync(join(dir, 'europe-lithuania.json.gz'), 'x');
    const args = ['tsx', 'generate-manifest.ts', '--input', dir, '--output', join(dir, 'manifest.json'), '--version', '2026-11-03'];
    if (previous !== undefined) {
      writeFileSync(join(dir, 'previous.json'), typeof previous === 'string' ? previous : JSON.stringify(previous));
      args.push('--previous', join(dir, 'previous.json'));
    }
    const r = spawnSync('npx', [...args, ...extraArgs], { cwd: SCRIPTS, encoding: 'utf8', timeout: 120_000 });
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { /* not written */ }
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, manifest };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('generate-manifest: a plain refresh carries the pointers forward and moves only the version', () => {
  const r = generate(POINTED);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.manifest.version, '2026-11-03');
  assert.equal(r.manifest.valhallaPackTag, 'valhalla-2026-09-02');
  assert.equal(r.manifest.basemapTag, 'basemap-2026-09-02');
  assert.ok(r.manifest.regions['europe-lithuania']);
});

test('generate-manifest: the first run after this change seeds the pointers from the old manifest', () => {
  const r = generate({ version: '2026-09-02', generatedAt: 'x', regions: {} });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.manifest.valhallaPackTag, 'valhalla-2026-09-02');
  assert.equal(r.manifest.basemapTag, 'basemap-2026-09-02');
});

test('generate-manifest: the aligned release overrides both pointers', () => {
  const r = generate(POINTED, ['--valhalla-pack-tag', 'valhalla-2026-11-01', '--basemap-tag', 'basemap-2026-11-01']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.manifest.valhallaPackTag, 'valhalla-2026-11-01');
  assert.equal(r.manifest.basemapTag, 'basemap-2026-11-01');
});

test('generate-manifest: a malformed override or an unreadable previous manifest writes nothing', () => {
  const bad = generate(POINTED, ['--basemap-tag', 'basemap-../../x']);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.manifest, null);
  const unreadable = generate('{not json');
  assert.notEqual(unreadable.code, 0);
  assert.equal(unreadable.manifest, null);
});

test('generate-manifest: without --previous or overrides the manifest has no pointers (local use unchanged)', () => {
  const r = generate(undefined);
  assert.equal(r.code, 0, r.out);
  assert.equal('valhallaPackTag' in r.manifest, false);
  assert.equal('basemapTag' in r.manifest, false);
});

// ── the workflows wire it up ────────────────────────────────────────────────────────────────────
const workflow = (name) => readFileSync(join(SCRIPTS, '..', '.github', 'workflows', name), 'utf8');

test('osm-extract: the release reads the previous published manifest and passes the per-release overrides', () => {
  const w = workflow('osm-extract.yml');
  const step = w.slice(w.indexOf('- name: Generate manifest'), w.indexOf('- name: Verify every asset decompresses'));
  assert.match(step, /gh release download --repo "\$GITHUB_REPOSITORY" --pattern manifest\.json -D \.\.\/previous-release/);
  assert.match(step, /--previous \.\.\/previous-release\/manifest\.json/);
  assert.match(step, /VALHALLA_PACK_TAG: \$\{\{ vars\.MANIFEST_VALHALLA_PACK_TAG \}\}/);
  assert.match(step, /BASEMAP_TAG: \$\{\{ vars\.MANIFEST_BASEMAP_TAG \}\}/);
  assert.match(step, /\$\{VALHALLA_PACK_TAG:\+--valhalla-pack-tag "\$VALHALLA_PACK_TAG"\}/);
  assert.match(step, /\$\{BASEMAP_TAG:\+--basemap-tag "\$BASEMAP_TAG"\}/);
  assert.match(step, /set -euo pipefail/);
});

test('regenerate-manifest: a repair keeps the release\'s own pointers', () => {
  const w = workflow('regenerate-manifest.yml');
  assert.match(w, /PREVIOUS=\(--previous \/tmp\/manifest-before\.json\)/);
  assert.match(w, /"\$\{PREVIOUS\[@\]\}"/);
  assert.match(w, /POINTER CHANGED — cannot proceed/);
});

/** Run the workflow's real check_pointer function with a fake `gh` that knows which tags are published. */
function checkPointer(tag, kind, published) {
  const w = workflow('osm-extract.yml');
  const start = w.indexOf('          check_pointer() {');
  const end = w.indexOf('\n          }\n', start) + '\n          }\n'.length;
  const fn = w.slice(start, end);
  const dir = mkdtempSync(join(tmpdir(), 'check-pointer-'));
  try {
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncase " ${published.join(' ')} " in *" $3 "*) echo false ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
    const script = `set -euo pipefail\n${fn}\ncheck_pointer "$1" "$2"\necho REACHED_END`;
    const r = spawnSync('bash', ['-c', script, 'x', tag, kind], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('osm-extract check_pointer: an override naming an unpublished release refuses; a carried one only warns', () => {
  assert.equal(checkPointer('valhalla-2026-11-01', 'override', ['valhalla-2026-11-01']).code, 0);
  const refused = checkPointer('valhalla-2026-11-01', 'override', []);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /REFUSING TO PUBLISH/);
  const carried = checkPointer('basemap-2026-09-02', '', []);
  assert.equal(carried.code, 0);
  assert.match(carried.out, /::warning::.*basemap-2026-09-02/);
  assert.match(carried.out, /REACHED_END/);
  assert.equal(checkPointer('', 'override', []).code, 0); // no pointer, nothing to check
});
