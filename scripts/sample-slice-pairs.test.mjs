import assert from 'node:assert/strict';
import test from 'node:test';
import { drawCandidates, pieceAt, prng, selectPairs } from './sample-slice-pairs.mjs';
import { prepareOutline } from './slice-valhalla-graph.mjs';

const box = (name, x0, x1) => `${name}\n1\n${x0} 50\n${x1} 50\n${x1} 52\n${x0} 52\n${x0} 50\nEND\nEND\n`;
const pieces = [{ id: 'w', outline: prepareOutline(box('w', 0, 2)) }, { id: 'e', outline: prepareOutline(box('e', 2, 4)) }];

test('the same seed draws the same cross-border candidates', () => {
  const a = drawCandidates(pieces, prng(7), 20);
  assert.deepEqual(a, drawCandidates(pieces, prng(7), 20));
  assert.equal(a.length, 20);
  for (const [p, q] of a) assert.notEqual(pieceAt(p, pieces), pieceAt(q, pieces));
});

test('snapped pairs that no longer cross a border, or failed to snap, are dropped', () => {
  const pairs = selectPairs([[[1.9, 51], [2.3, 51]], [[1.9, 51], [1.95, 51.5]], [[1.9, 51], null], [[0.5, 51], [3.5, 51]]], pieces, 5);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0].from, [51, 1.9]);
  assert.equal(pairs[0].pieces, 'auto');
});
