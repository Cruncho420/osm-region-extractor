/**
 * PURPOSE: Exercise partition integrity with actual temporary binary tile trees.
 * RESPONSIBILITY: Success, tampering, omissions, overlaps and unsafe filesystem paths.
 * DEPENDENCIES: Node standard library and verify-valhalla-partitions.mjs.
 * CONSUMERS: npm test in scripts/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPartitions, validateTilePath } from './verify-valhalla-partitions.mjs';

const A = '2/001/001.gph';
const B = '2/002/002.gph';
const S = '0/003.gph';
const content = new Map([[A, Buffer.from([0, 255, 1, 128])],
  [B, Buffer.from([254, 0, 128, 3])], [S, Buffer.alloc(180_000, 127)]]);

async function put(root, name, bytes) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
}

async function fixture(t, first = [A, S], second = [B, S]) {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'partition-proof-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = ['unsplit', 'first', 'second'].map(name => path.join(base, name));
  for (const [index, names] of [[0, [...content.keys()]], [1, first], [2, second]]) {
    await mkdir(roots[index]);
    for (const name of names) await put(roots[index], name, content.get(name));
  }
  return roots;
}

test('hashes real binary tiles and emits deterministic exact-union inventories', async t => {
  const roots = await fixture(t);
  await writeFile(path.join(roots[1], 'index.bin'), Buffer.from([42]));
  const report = await verifyPartitions(...roots);
  assert.deepEqual(report, await verifyPartitions(...roots));
  assert.deepEqual(report.counts, { shared: 1, firstOnly: 1, secondOnly: 1 });
  assert.deepEqual(report.union, report.unsplit);
  assert.deepEqual(report.union.tiles.map(tile => tile.path), [S, A, B]);
  for (const tile of report.union.tiles) {
    assert.equal(tile.sha256, createHash('sha256').update(content.get(tile.path)).digest('hex'));
    assert.equal(tile.bytes, content.get(tile.path).length);
  }
});

test('rejects same-size corruption in an exclusive tile', async t => {
  const roots = await fixture(t);
  await put(roots[1], A, Buffer.from([0, 255, 2, 128]));
  await assert.rejects(verifyPartitions(...roots), /Changed tile/);
});

test('rejects missing source tile', async t => {
  const roots = await fixture(t, [S]);
  await assert.rejects(verifyPartitions(...roots), /Missing tile/);
});

test('rejects extra pack tile', async t => {
  const roots = await fixture(t);
  await put(roots[1], '2/999/999.gph', Buffer.from([9]));
  await assert.rejects(verifyPartitions(...roots), /Extra tile/);
});

test('rejects conflicting bytes under an overlapping tile path', async t => {
  const roots = await fixture(t);
  await put(roots[2], S, Buffer.alloc(180_000, 126));
  await assert.rejects(verifyPartitions(...roots), /Conflicting overlap/);
});

test('rejects duplicate full packs even when their union is exact', async t => {
  const roots = await fixture(t, [A, B, S], [A, B, S]);
  await assert.rejects(verifyPartitions(...roots), /exclusive tiles/);
});

test('rejects an empty pack', async t => {
  const roots = await fixture(t, []);
  await assert.rejects(verifyPartitions(...roots), /Empty graph/);
});

test('rejects a union with no shared tiles', async t => {
  const roots = await fixture(t, [A, S], [B]);
  await assert.rejects(verifyPartitions(...roots), /must share tiles/);
});

test('rejects symlink tile, directory, root and ignored metadata', async t => {
  for (const kind of ['tile', 'directory', 'root', 'index']) {
    const roots = await fixture(t);
    if (kind === 'tile') await symlink(path.join(roots[0], B), path.join(roots[1], '2/001/002.gph'));
    if (kind === 'directory') await symlink(path.join(roots[0], '2'), path.join(roots[1], '9'));
    if (kind === 'index') await symlink(path.join(roots[0], S), path.join(roots[1], 'index.bin'));
    if (kind === 'root') {
      const alias = `${roots[1]}-alias`;
      await symlink(roots[1], alias);
      roots[1] = alias;
    }
    await assert.rejects(verifyPartitions(...roots), /[Ss]ymlink/);
  }
});

test('rejects traversal, absolute paths and Windows separators', async t => {
  for (const name of ['../001.gph', '2/../001.gph', '/2/001.gph', '2\\001.gph']) {
    assert.throws(() => validateTilePath(name), /Unsafe/);
  }
  const roots = await fixture(t);
  roots[1] = `${roots[1]}/../first`;
  await assert.rejects(verifyPartitions(...roots), /traversal/);
});

test('rejects unexpected files, empty tile bytes and aliased roots', async t => {
  const roots = await fixture(t);
  await assert.rejects(verifyPartitions(roots[0], roots[1], roots[1]), /separate/);
  await put(roots[1], A, Buffer.alloc(0));
  await assert.rejects(verifyPartitions(...roots), /Empty tile/);
  const other = await fixture(t);
  await writeFile(path.join(other[1], 'outside.gph'), Buffer.from([1]));
  await assert.rejects(verifyPartitions(...other), /Unsafe/);
});

test('CLI emits JSON on success and a failing status without a receipt on corruption', async t => {
  const roots = await fixture(t);
  const script = fileURLToPath(new URL('./verify-valhalla-partitions.mjs', import.meta.url));
  const success = spawnSync(process.execPath, [script, ...roots], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).scope, 'unchanged-tile-union-only');
  await put(roots[1], A, Buffer.from([99]));
  const failure = spawnSync(process.execPath, [script, ...roots], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /Changed tile/);
});
