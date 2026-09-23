/**
 * PURPOSE: prove the .poly parser the basemap build clips with.
 * DEPENDENCIES: node:test. CONSUMERS: `npm test` in scripts/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyToGeoJSON } from './poly-to-geojson.mjs';

const POLY = `lithuania
1
   20.9 53.9
   26.8 53.9
   26.8 56.4
END
!2
   22 54
   23 54
   23 55
   22 54
END
3
   1 1
   2 1
   2 2
END
END
`;

test('outer rings become polygons, "!" sections become holes, rings are closed', () => {
  const g = polyToGeoJSON(POLY);
  assert.equal(g.type, 'MultiPolygon');
  assert.equal(g.coordinates.length, 2);
  assert.equal(g.coordinates[0].length, 2, 'first polygon has its hole');
  assert.deepEqual(g.coordinates[0][0].at(-1), [20.9, 53.9], 'open ring was closed');
  assert.equal(g.coordinates[0][1].length, 4, 'already-closed hole not double-closed');
});

test('refuses broken input rather than clipping with a wrong polygon', () => {
  assert.throws(() => polyToGeoJSON('x\n1\n 1 1\n 2 2\n'), /unterminated/);
  assert.throws(() => polyToGeoJSON('x\n!1\n 1 1\n 2 1\n 2 2\nEND\nEND\n'), /hole before/);
  assert.throws(() => polyToGeoJSON('x\n1\n 1 a\n 2 1\n 2 2\nEND\nEND\n'), /bad coordinate/);
  assert.throws(() => polyToGeoJSON('x\nEND\n'), /no polygon/);
});
