import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildDescriptor, encode, graphDigest } from './build-slice-install-descriptor.mjs';

test('graph digest matches the connected-proof producer (sorted, compact JSON)', () => {
  const tiles = { '2/000/000/002.gph': { bytes: 2, sha256: 'b'.repeat(64) }, '0/000/001.gph': { bytes: 1, sha256: 'a'.repeat(64) } };
  const expected = createHash('sha256').update('[{"path":"0/000/001.gph","bytes":1,"sha256":"' + 'a'.repeat(64) +
    '"},{"path":"2/000/000/002.gph","bytes":2,"sha256":"' + 'b'.repeat(64) + '"}]').digest('hex');
  assert.equal(graphDigest(tiles), expected);
});

test('descriptor has exactly the fields and file names the app contract accepts', () => {
  const d = buildDescriptor({ wholeTiles: { '0/000/001.gph': { bytes: 1, sha256: 'a'.repeat(64) } },
    evidence: { 'reconstruction.json': encode({}), 'partition-integrity.json': encode({}), 'toolchain-source.json': encode({}),
      'input-provenance.json': encode({}), 'offline-crossing.json': encode({}) },
    pieces: [{ id: 'europe-great-britain-north', archive: { bytes: 5, sha256: 'c'.repeat(64) }, tar: { bytes: 9, sha256: 'd'.repeat(64) },
      inventoryJson: '{}\n', coverageJson: '{}\n', polyText: 'x\nEND\n' }] });
  assert.deepEqual(Object.keys(d), ['schemaVersion', 'format', 'coreSha', 'connectedGraphSha256', 'regions', 'provenance']);
  const r = d.regions[0];
  assert.deepEqual(Object.keys(r), ['regionId', 'archive', 'tar', 'inventory', 'coverage', 'sourcePolygon']);
  assert.equal(r.inventory.file, 'europe-great-britain-north.inventory.json');
  assert.equal(r.coverage.file, 'europe-great-britain-north.coverage.json');
  assert.match(r.archive.file, /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z.]+$/);
  assert.match(encode({ s: 'Québec' }), /^[\x20-\x7e]*\n$/); // ASCII only, exact bytes
});
