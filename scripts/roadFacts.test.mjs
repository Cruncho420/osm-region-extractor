// roadFacts.test.mjs — the lanes / width / single-track parse rules road_ways stores (FEAT-175, 2026-10-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSingleTrack, parseLaneMarkings, parseLanes, parseWidthM } from './roadFacts.mjs';

test('lanes: whole counts only', () => {
  assert.equal(parseLanes('1'), 1);
  assert.equal(parseLanes(' 2 '), 2);
  for (const bad of ['0', '2;3', '1.5', '', 'two', '99', undefined]) assert.equal(parseLanes(bad), null, String(bad));
});

test('width: metres, decimal comma, feet and inches; junk and absurd values are null', () => {
  assert.equal(parseWidthM('3.5'), 3.5);
  assert.equal(parseWidthM('3.5 m'), 3.5);
  assert.equal(parseWidthM('3,5'), 3.5);
  assert.equal(parseWidthM('6m'), 6);
  assert.equal(parseWidthM('10 ft'), 3.05);
  assert.equal(parseWidthM("12'"), 3.66);
  assert.equal(parseWidthM('12\'6"'), 3.81);
  for (const bad of ['narrow', '3-4', '0.2', '120', '', undefined]) assert.equal(parseWidthM(bad), null, String(bad));
});

test('lane_markings: yes / no only', () => {
  assert.equal(parseLaneMarkings('no'), 'no');
  assert.equal(parseLaneMarkings('yes'), 'yes');
  assert.equal(parseLaneMarkings('partial'), null);
});

test('single_track: two-way roads only, single-track evidence wins', () => {
  const two = { oneway: null, junction: null, highway: 'tertiary' };
  assert.equal(deriveSingleTrack({ ...two, lanes: 1, widthM: null }), 1);
  assert.equal(deriveSingleTrack({ ...two, lanes: null, widthM: 3.2 }), 1);
  assert.equal(deriveSingleTrack({ ...two, lanes: 2, widthM: 3.5 }), 1);
  assert.equal(deriveSingleTrack({ ...two, lanes: 2, widthM: null }), 0);
  assert.equal(deriveSingleTrack({ ...two, lanes: null, widthM: 5 }), null); // width may include parking: no proof
  assert.equal(deriveSingleTrack({ ...two, oneway: 'no', lanes: 1, widthM: null }), 1);
  for (const o of ['1', 'true', 'alternating', 'reversible']) assert.equal(deriveSingleTrack({ ...two, oneway: o, lanes: 1, widthM: null }), null, o);
  assert.equal(deriveSingleTrack({ ...two, lanes: null, widthM: null }), null);
  assert.equal(deriveSingleTrack({ ...two, oneway: 'yes', lanes: 1, widthM: null }), null);
  assert.equal(deriveSingleTrack({ ...two, oneway: '-1', lanes: 1, widthM: null }), null);
  assert.equal(deriveSingleTrack({ ...two, junction: 'roundabout', lanes: 1, widthM: null }), null);
  assert.equal(deriveSingleTrack({ ...two, highway: 'motorway', lanes: 1, widthM: null }), null);
});
