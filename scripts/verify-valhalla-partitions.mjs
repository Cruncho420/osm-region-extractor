/**
 * PURPOSE: Refuse reconstructed routing packs whose tile union changed the graph.
 * RESPONSIBILITY: Stream actual tile bytes; validate paths and union inventories.
 * DEPENDENCIES: Node standard library only.
 * CONSUMERS: Build-only connected-graph proof; verify-valhalla-partitions.test.mjs.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function refuse(message) { throw new Error(message); }

export function validateTilePath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') ||
      !/^[0-9]+\/(?:[0-9]+\/)*[0-9]+\.gph$/.test(relative)) {
    refuse(`Unsafe or unexpected tile path: ${relative}`);
  }
  return relative;
}

async function checkedRoot(input) {
  if (typeof input !== 'string' || input.split(/[\\/]/).includes('..')) {
    refuse('Root path traversal is forbidden');
  }
  const absolute = path.resolve(input);
  if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isDirectory()) {
    refuse(`Root must be a real directory without symlinks: ${input}`);
  }
  return absolute;
}

async function hashTile(filename, expected) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== expected.ino || before.dev !== expected.dev) {
      refuse(`Tile changed during inspection: ${filename}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) refuse(`Tile changed while hashing: ${filename}`);
    return { bytes: after.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function walk(root, relative, tiles) {
  const directory = path.join(root, relative);
  const entries = (await readdir(directory)).sort();
  for (const name of entries) {
    const member = relative ? `${relative}/${name}` : name;
    const filename = path.join(root, member);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) refuse(`Symlink forbidden: ${member}`);
    if (await realpath(filename) !== filename) refuse(`Path escapes through symlink: ${member}`);
    if (info.isDirectory()) {
      if (!/^[0-9]+$/.test(name)) refuse(`Unexpected directory: ${member}`);
      await walk(root, member, tiles);
    } else if (info.isFile()) {
      // Generated tar metadata is not graph content; never follow links even here.
      if (member === 'index.bin') continue;
      validateTilePath(member);
      const digest = await hashTile(filename, info);
      if (digest.bytes === 0) refuse(`Empty tile: ${member}`);
      tiles.push({ path: member, ...digest });
    } else refuse(`Non-regular member forbidden: ${member}`);
  }
}

function inventory(tiles) {
  tiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    count: tiles.length,
    bytes: tiles.reduce((total, tile) => total + tile.bytes, 0),
    sha256: createHash('sha256').update(JSON.stringify(tiles)).digest('hex'),
    tiles,
  };
}

async function inspect(root) {
  const tiles = [];
  await walk(root, '', tiles);
  if (!tiles.length) refuse(`Empty graph directory: ${root}`);
  return inventory(tiles);
}

function compare(unsplit, first, second) {
  const source = new Map(unsplit.tiles.map(tile => [tile.path, tile]));
  const union = new Map();
  const shared = [];
  for (const pack of [first, second]) {
    for (const tile of pack.tiles) {
      const previous = union.get(tile.path);
      if (previous && previous.sha256 !== tile.sha256) refuse(`Conflicting overlap: ${tile.path}`);
      if (previous) shared.push(tile.path);
      union.set(tile.path, tile);
    }
  }
  for (const [name, tile] of union) {
    const original = source.get(name);
    if (!original) refuse(`Extra tile: ${name}`);
    if (tile.sha256 !== original.sha256) refuse(`Changed tile: ${name}`);
  }
  for (const name of source.keys()) if (!union.has(name)) refuse(`Missing tile: ${name}`);
  const overlap = new Set(shared);
  const firstOnly = first.tiles.filter(tile => !overlap.has(tile.path)).map(tile => tile.path);
  const secondOnly = second.tiles.filter(tile => !overlap.has(tile.path)).map(tile => tile.path);
  if (!firstOnly.length || !secondOnly.length) refuse('Each pack must contain exclusive tiles');
  if (!shared.length) refuse('Packs must share tiles');
  return { union: inventory([...union.values()]), shared: shared.sort(), firstOnly, secondOnly };
}

export async function verifyPartitions(unsplitPath, firstPath, secondPath) {
  const roots = await Promise.all([unsplitPath, firstPath, secondPath].map(checkedRoot));
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (roots[i] === roots[j] || roots[i].startsWith(`${roots[j]}${path.sep}`) ||
          roots[j].startsWith(`${roots[i]}${path.sep}`)) refuse('Graph roots must be separate directories');
    }
  }
  // Serial scans bound open descriptors and concurrent disk traffic for large graphs.
  const [unsplit, first, second] = [await inspect(roots[0]), await inspect(roots[1]), await inspect(roots[2])];
  const comparison = compare(unsplit, first, second);
  return {
    schemaVersion: 1,
    scope: 'unchanged-tile-union-only',
    unsplit, first, second, ...comparison,
    counts: { shared: comparison.shared.length, firstOnly: comparison.firstOnly.length,
      secondOnly: comparison.secondOnly.length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) refuse('Usage: node verify-valhalla-partitions.mjs UNSPLIT PACK_A PACK_B');
    console.log(JSON.stringify(await verifyPartitions(...process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(`Partition verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
