/**
 * PURPOSE: Pin the .poly-to-routing-coverage supply-chain contract.
 * RESPONSIBILITY: Parser exclusions, closure, validation, and deterministic metadata.
 * DEPENDENCIES: node:test and generate-valhalla-coverage.mjs.
 * CONSUMERS: CI/local verification.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCoverageDocument, isValidCoverageDocument, parseGeofabrikPoly } from './generate-valhalla-coverage.mjs';

const POLY = `sample
outer
  24.0 57.0
  28.0 57.0
  28.0 60.0
  24.0 60.0
END
!hole
  25.0 58.0
  26.0 58.0
  26.0 59.0
  25.0 59.0
END
END
`;

test('parses inclusion/exclusion rings and closes both', () => {
  const rings = parseGeofabrikPoly(POLY);
  assert.equal(rings.length, 2);
  assert.equal(rings[0].exclude, false);
  assert.equal(rings[1].exclude, true);
  assert.deepEqual(rings[0].coordinates[0], rings[0].coordinates.at(-1));
  assert.deepEqual(rings[1].coordinates[0], rings[1].coordinates.at(-1));
});

test('emits the versioned conservative contract deterministically', () => {
  const first = buildCoverageDocument(POLY);
  const second = buildCoverageDocument(POLY);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.source, 'geofabrik-poly-v1');
  assert.equal(first.safetyMarginMeters, 10_000);
  assert.match(first.sourceChecksum, /^[a-f0-9]{16}$/);
});

test('rejects a polygon with no inclusion ring', () => {
  assert.throws(
    () => parseGeofabrikPoly('sample\n!hole\n  1 1\n  2 1\n  2 2\nEND\nEND\n'),
    /no inclusion ring/,
  );
});

test('generated documents pass the app contract; broken ones do not', () => {
  const doc = buildCoverageDocument(POLY);
  assert.equal(isValidCoverageDocument(doc), true);
  assert.equal(isValidCoverageDocument({ ...doc, source: 'bbox' }), false);
  assert.equal(isValidCoverageDocument({ ...doc, rings: doc.rings.filter((r) => r.exclude) }), false);
  const open = structuredClone(doc);
  open.rings[0].coordinates.pop();
  assert.equal(isValidCoverageDocument(open), false);
});

test('Geofabrik exponent notation (Alaska, Russia) parses', () => {
  const rings = parseGeofabrikPoly('a\n1\n -1.800000E+02 5.1E+01\n -1.7E+02 5.1E+01\n -1.7E+02 5.2E+01\nEND\nEND\n');
  assert.deepEqual(rings[0].coordinates[0], [-180, 51]);
});
