// Run: node --test valhallaCoord.test.mjs. Cases are OSM nodes whose 7th digit is 5 and the vertex route.rodsmaps.com
// returned for them on 2026-10-27 (Stelvio, Ronda-Grazalema, Caracoles): both directions on both signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { valhallaLat, valhallaLon } from './valhallaCoord.mjs';

const CASES = [
  // [node lat, node lon] -> [Valhalla lat, Valhalla lon]
  [[46.5302936, 10.4487685], [46.530294, 10.448769]],
  [[46.4709654, 10.3732485], [46.470965, 10.373248]],
  [[36.7894015, -5.2754305], [36.789402, -5.27543]],
  [[36.7894923, -5.2752915], [36.789492, -5.275292]],
  [[-32.8876735, -70.2189875], [-32.887674, -70.218988]],
];

test('reproduces Valhalla 3.6.3 on real tie nodes', () => {
  for (const [[la, lo], [vla, vlo]] of CASES) {
    assert.equal(valhallaLat(la), vla, `lat ${la}`);
    assert.equal(valhallaLon(lo), vlo, `lon ${lo}`);
  }
});

test('idempotent: a 6-decimal value is returned unchanged', () => {
  for (const v of [46.530294, -5.27543, -70.218988, 0, 179.999999, -89.999999]) {
    assert.equal(valhallaLon(v), v);
    assert.equal(valhallaLat(Math.max(-90, Math.min(90, v))), Math.max(-90, Math.min(90, v)));
  }
});

test('never moves an axis more than half a 6th-decimal step', () => {
  for (let i = 0; i < 20000; i++) {
    const lat = -85 + 170 * ((i * 0.6180339887) % 1), lon = -180 + 360 * ((i * 0.4142135623) % 1);
    const la7 = Math.round(lat * 1e7) / 1e7, lo7 = Math.round(lon * 1e7) / 1e7;
    assert.ok(Math.abs(valhallaLat(la7) - la7) <= 5e-7 + 1e-12);
    assert.ok(Math.abs(valhallaLon(lo7) - lo7) <= 5e-7 + 1e-12);
  }
});
