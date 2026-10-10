/**
 * search-manifest.test.mjs — the offline search file in manifest.json and the release gate.
 *
 * PURPOSE: <region>-search.sqlite.gz (search_index.py, Rods FEAT-090) is listed per region as
 *   searchSize/searchChecksum, only when the file is in the release directory, never as a region of
 *   its own; and verify-release refuses a truncated one before it is published (the BUG-242 case).
 * RESPONSIBILITY: spawn the real generate-manifest.ts and verify-release.ts on a temp directory.
 * DEPENDENCIES: node:test, tsx, gzip.
 * CONSUMERS: `npm test` in scripts/ (.github/workflows/scripts-tests.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, truncateSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const tsx = (...args) => {
  const r = spawnSync('npx', ['tsx', ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

function releaseDir({ withSearch }) {
  const dir = mkdtempSync(join(tmpdir(), 'search-manifest-'));
  writeFileSync(join(dir, 'europe-malta.json.gz'), gzipSync('{}'));
  writeFileSync(join(dir, 'europe-malta.sqlite.gz'), gzipSync(Buffer.alloc(4096, 1)));
  if (withSearch) writeFileSync(join(dir, 'europe-malta-search.sqlite.gz'), gzipSync(Buffer.alloc(65536, 7)));
  const gen = tsx('generate-manifest.ts', '--input', dir, '--output', join(dir, 'manifest.json'), '--version', '2026-11-01');
  assert.equal(gen.code, 0, gen.out);
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) };
}

test('search file present: per-region searchSize + 16-hex sha256 prefix, never a region of its own', () => {
  const { dir, manifest } = releaseDir({ withSearch: true });
  try {
    assert.deepEqual(Object.keys(manifest.regions), ['europe-malta']);
    const r = manifest.regions['europe-malta'];
    const bytes = readFileSync(join(dir, 'europe-malta-search.sqlite.gz'));
    assert.equal(r.searchSize, bytes.length);
    assert.equal(r.searchChecksum, createHash('sha256').update(bytes).digest('hex').slice(0, 16));
    assert.ok(r.sqliteSize > 0, 'road data fields unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run month (no search file in the release dir): manifest has no search fields', () => {
  const { dir, manifest } = releaseDir({ withSearch: false });
  try {
    assert.equal('searchSize' in manifest.regions['europe-malta'], false);
    assert.equal('searchChecksum' in manifest.regions['europe-malta'], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-release passes a whole search file and refuses a truncated one', () => {
  const { dir, manifest } = releaseDir({ withSearch: true });
  try {
    const ok = tsx('verify-release.ts', '--dir', dir);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /europe-malta \[search\]/);
    const search = join(dir, 'europe-malta-search.sqlite.gz');
    truncateSync(search, statSync(search).size - 10);
    // Re-pin the truncated size, as a manifest generated after a truncating transfer would.
    manifest.regions['europe-malta'].searchSize = statSync(search).size;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const bad = tsx('verify-release.ts', '--dir', dir);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /europe-malta-search\.sqlite\.gz failed integrity \(CORRUPT\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflows keep the search file dry-run unless PUBLISH_SEARCH_INDEX is on', () => {
  const wf = (name) => readFileSync(join(SCRIPTS, '..', '.github', 'workflows', name), 'utf8');
  const monthly = wf('osm-extract.yml');
  // default OFF, and the scheduled run only turns on through the repo variable
  assert.match(monthly, /publish_search:[\s\S]{0,200}default: false/);
  assert.match(monthly, /PUBLISH_SEARCH_INDEX: \$\{\{ inputs\.publish_search \|\| vars\.PUBLISH_SEARCH_INDEX == 'true' \}\}/);
  // the release job never downloads search artifacts unless publishing (disk: BUG-242; assets: dry-run)
  assert.match(monthly, /path: all-regions\n\s+# [^\n]*\n\s+# [^\n]*\n\s+pattern: '!search-\*'/);
  assert.match(monthly, /if: env\.PUBLISH_SEARCH_INDEX == 'true'\n\s+uses: actions\/download-artifact@v4\n\s+with:\n\s+path: all-regions\n\s+pattern: 'search-\*'/);
  // a search failure never costs a region its road data
  assert.match(monthly, /id: search\n\s+continue-on-error: true/);
  // the house-number rule measures THIS run's road data, so search runs after build-sqlite
  assert.ok(monthly.indexOf('npm run build-sqlite') < monthly.indexOf('id: search'), 'search step after build-sqlite');
  assert.match(monthly, /--road-gz "scripts\/output\/\$REGION\.sqlite\.gz"/);
  const pilot = wf('region-slices-pilot.yml');
  assert.match(pilot, /publish_search:[\s\S]{0,200}default: false/);
  assert.match(pilot, /merge-multiple: true\n\s+pattern: '!search-\*'/);
});
