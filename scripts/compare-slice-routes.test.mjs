import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildUnion, compareTrips, decodePolyline6 } from './compare-slice-routes.mjs';

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
