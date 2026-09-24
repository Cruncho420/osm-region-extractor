import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { outlineTouchesBox, prepareOutline, slice, tileBounds } from './slice-valhalla-graph.mjs';

const square = (name, x0, x1) => prepareOutline(
  `${name}\n1\n ${x0} 54\n ${x1} 54\n ${x1} 55\n ${x0} 55\nEND\nEND\n`);
// Level-2 tile id = row * 1440 + column, 0.25 degree tiles from (-180, -90).
const l2 = (lon, lat) => {
  const id = String(((lat + 90) / 0.25) * 1440 + (lon + 180) / 0.25).padStart(9, '0');
  return `2/${id.slice(0, 3)}/${id.slice(3, 6)}/${id.slice(6)}.gph`;
};

test('tileBounds decodes a level-2 path', () => {
  assert.equal(l2(25.25, 54.5), '2/000/833/141.gph');
  assert.deepEqual(tileBounds('2/000/833/141.gph'), [25.25, 54.5, 25.5, 54.75]);
  assert.deepEqual(tileBounds('0/002/915.gph'), [-180 + (2915 % 90) * 4, -90 + Math.floor(2915 / 90) * 4,
    -176 + (2915 % 90) * 4, -86 + Math.floor(2915 / 90) * 4]);
});

test('a hole edge crossing the box still counts as touching (never drop a tile)', () => {
  const ring = prepareOutline('h\n1\n 0 0\n 10 0\n 10 10\n 0 10\nEND\n!2\n 4 4\n 6 4\n 6 6\n 4 6\nEND\nEND\n');
  assert.equal(outlineTouchesBox(ring, [4.9, 4.9, 5.1, 5.1]), false); // wholly in the hole
  assert.equal(outlineTouchesBox(ring, [5.9, 5.0, 6.1, 5.2]), true); // straddles the hole edge
  assert.equal(outlineTouchesBox(ring, [20, 20, 21, 21]), false);
});

test('border tiles go to both pieces, orphans to the nearest, union is the whole graph', () => {
  const root = mkdtempSync(join(tmpdir(), 'slice-'));
  const tilesDir = join(root, 'tiles');
  const tiles = {
    west: l2(24.0, 54.25), east: l2(25.5, 54.25),
    border: l2(24.75, 54.25), // spans 24.75-25.0; the shared edge is x = 24.9
    far: l2(30.0, 54.25),
  };
  for (const [name, rel] of Object.entries(tiles)) {
    mkdirSync(dirname(join(tilesDir, rel)), { recursive: true });
    writeFileSync(join(tilesDir, rel), name);
  }
  const outDir = join(root, 'out');
  const report = slice({ tilesDir, outDir, pieces: [
    { id: 'west', outline: square('w', 23, 24.9) }, { id: 'east', outline: square('e', 24.9, 27) }] });

  const west = JSON.parse(readFileSync(join(outDir, 'west.tiles.json'), 'utf8'));
  const east = JSON.parse(readFileSync(join(outDir, 'east.tiles.json'), 'utf8'));
  assert.deepEqual(Object.keys(west).sort(), [tiles.west, tiles.border].sort());
  assert.deepEqual(Object.keys(east).sort(), [tiles.east, tiles.border, tiles.far].sort());
  assert.deepEqual(report.orphanTiles, [tiles.far]);
  assert.equal(report.pieces.west.sharedTiles, 1);
  assert.deepEqual(west[tiles.border], east[tiles.border]); // same bytes, same pin
  // Hard links, not copies: the piece tile IS the build's tile.
  assert.equal(statSync(join(outDir, 'west', tiles.border)).ino, statSync(join(tilesDir, tiles.border)).ino);
  const union = new Set([...Object.keys(west), ...Object.keys(east)]);
  assert.equal(union.size, Object.keys(tiles).length);
  rmSync(root, { recursive: true });
});
