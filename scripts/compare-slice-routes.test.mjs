import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildUnion, compareTrips, decodePolyline6, level2Tile, piecesAlongShape } from './compare-slice-routes.mjs';
import { prepareOutline, tileBounds } from './slice-valhalla-graph.mjs';

test('decodes a Valhalla polyline6', () => {
  // Google's reference example, at 1e6 precision.
  assert.deepEqual(decodePolyline6('_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI'),
    [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('union refuses a shared tile whose bytes differ, like the phone', () => {
  const root = mkdtempSync(join(tmpdir(), 'union-'));
  for (const [pack, body] of [['a', 'x'], ['b', 'y']]) {
    mkdirSync(join(root, pack, '2/000/000'), { recursive: true });
    writeFileSync(join(root, pack, '2/000/000/001.gph'), body);
  }
  assert.throws(() => buildUnion([join(root, 'a'), join(root, 'b')], join(root, 'u')), /differs between packs/);
  mkdirSync(join(root, 'c', '2/000/000'), { recursive: true });
  writeFileSync(join(root, 'c', '2/000/000/001.gph'), 'x');
  assert.equal(buildUnion([join(root, 'a'), join(root, 'c')], join(root, 'u2')), 1);
  rmSync(root, { recursive: true });
});

test('a changed roundabout exit is reported even when the road is the same', () => {
  const trip = (exit) => ({ trip: { summary: { length: 1, time: 60 }, legs: [{ shape: '_izlhA~rlgdF_{geC~ywl@',
    maneuvers: [{ type: 1 }, { type: 26, roundabout_exit_count: exit }, { type: 4 }] }] } });
  const same = compareTrips(trip(2), trip(2));
  assert.equal(same.identicalShape, true);
  assert.equal(same.maneuverDiffs.length, 0);
  assert.deepEqual(compareTrips(trip(2), trip(3)).maneuverDiffs.map((d) => d.index), [1]);
});

test('level2Tile is the inverse of the slicer tileBounds', () => {
  for (const [lat, lon] of [[51.5074, -0.1278], [-33.87, 151.21], [64.1, -21.9], [0.01, 0.01]]) {
    const [minLon, minLat, maxLon, maxLat] = tileBounds(level2Tile([lat, lon]));
    assert.ok(lon >= minLon && lon < maxLon && lat >= minLat && lat < maxLat, `${lat},${lon}`);
  }
});

test('a route needs every piece its shape enters; a point in no outline takes its tile owners', () => {
  const box = (name, x0, x1) => `${name}\n1\n${x0} 0\n${x1} 0\n${x1} 1\n${x0} 1\n${x0} 0\nEND\nEND\n`;
  const pieces = [{ id: 'w', outline: prepareOutline(box('w', 0, 0.5)) }, { id: 'e', outline: prepareOutline(box('e', 0.6, 1)) },
    { id: 'x', outline: prepareOutline(box('x', 5, 6)) }];
  const gap = [0.5, 0.55]; // [lat, lon] between w and e
  const owners = new Map([[level2Tile(gap), ['w', 'x']]]);
  assert.deepEqual(piecesAlongShape([[0.5, 0.1], [0.5, 0.2]], pieces, owners), ['w']);
  assert.deepEqual(piecesAlongShape([[0.5, 0.1], [0.5, 0.8]], pieces, owners), ['e', 'w']);
  assert.deepEqual(piecesAlongShape([[0.5, 0.1], gap], pieces, owners), ['w', 'x']);
});
