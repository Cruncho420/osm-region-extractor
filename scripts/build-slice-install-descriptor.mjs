/**
 * PURPOSE: Write the phone's connected-install descriptor ("valhalla-directory-tiles-v1") for
 *   the pieces of ONE country cut from ONE graph build.
 * RESPONSIBILITY: Pin every archive (gz and plain tar), inventory, coverage sidecar and source
 *   outline; derive connectedGraphSha256 from the whole graph's tile list; bind the run's own
 *   evidence as the five provenance files the app pins (never content it did not produce).
 * DEPENDENCIES: Node built-ins.
 * CONSUMERS: region-slices-pilot.yml; Rods services/valhalla/valhallaInstallContract.ts reads the
 *   output, and a test build bakes its bytes + pin (services/devProbe/fixtures).
 *
 * connectedGraphSha256 uses the connected-proof producer's digest (sorted [{path,bytes,sha256}],
 * compact JSON) so the same graph always gets the same identity.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const CORE_SHA = 'e2f017b16080f49203de245a211b09efab09cf72'; // Valhalla 3.6.3 = the phone engine
const sha = (data) => createHash('sha256').update(data).digest('hex');
const pin = (data) => ({ bytes: Buffer.byteLength(data), sha256: sha(data) });
// Producer emits ASCII JSON with a trailing newline: the app hashes the exact bytes.
export const encode = (value) => `${JSON.stringify(value).replace(/[\u007f-￿]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

export function graphDigest(tiles) {
  return sha(JSON.stringify(Object.keys(tiles).sort().map((path) => ({ path, ...tiles[path] }))));
}

export function buildDescriptor({ pieces, wholeTiles, evidence }) {
  const provenance = Object.fromEntries(Object.entries(evidence).map(([name, text]) => [name, pin(text)]));
  return {
    schemaVersion: 1, format: 'valhalla-directory-tiles-v1', coreSha: CORE_SHA,
    connectedGraphSha256: graphDigest(wholeTiles),
    regions: pieces.map((p) => ({
      regionId: p.id,
      archive: { file: `${p.id}-valhalla.tar.gz`, ...p.archive },
      tar: p.tar,
      inventory: { file: `${p.id}.inventory.json`, ...pin(p.inventoryJson) },
      coverage: { file: `${p.id}.coverage.json`, schemaVersion: 1, ...pin(p.coverageJson) },
      sourcePolygon: pin(p.polyText),
    })),
    provenance,
  };
}

function main() {
  const { values: a } = parseArgs({ options: Object.fromEntries(
    ['work', 'assets', 'country', 'out', 'inputs'].map((k) => [k, { type: 'string' }])) });
  const slice = JSON.parse(readFileSync(join(a.work, 'slice.json'), 'utf8'));
  const packs = JSON.parse(readFileSync(join(a.work, 'packs.json'), 'utf8'));
  const ids = Object.keys(slice.pieces).sort();
  const wholeTiles = {};
  const pieces = ids.map((id) => {
    const tiles = JSON.parse(readFileSync(join(a.work, 'pieces', `${id}.tiles.json`), 'utf8'));
    for (const [path, p] of Object.entries(tiles)) {
      if (wholeTiles[path] && wholeTiles[path].sha256 !== p.sha256) throw new Error(`conflicting shared tile ${path}`);
      wholeTiles[path] = p;
    }
    return { id, archive: packs[id].archive, tar: packs[id].tar,
      inventoryJson: readFileSync(join(a.assets, `${id}.inventory.json`), 'utf8'),
      coverageJson: readFileSync(join(a.assets, `${id}-valhalla-coverage.json`), 'utf8'),
      polyText: readFileSync(join(a.work, 'polys', `${id}.poly`), 'utf8') };
  });
  if (Object.keys(wholeTiles).length !== slice.tileCount) throw new Error('union of pieces is not the whole graph');
  const evidence = {
    'reconstruction.json': encode({ scope: 'region-slice-pieces-from-one-graph-build', pieces: Object.fromEntries(
      pieces.map((p) => [p.id, { archive: p.archive, tar: p.tar, members: Object.keys(JSON.parse(p.inventoryJson)).length }])) }),
    'partition-integrity.json': encode({ scope: 'whole-tile-partition-union-equals-graph', tileCount: slice.tileCount,
      graphSha256: graphDigest(wholeTiles), orphanTilesToNearestPiece: slice.orphanTiles.length, pieces: slice.pieces }),
    'toolchain-source.json': encode({ coreSha: CORE_SHA, ...JSON.parse(readFileSync(a.inputs, 'utf8')).toolchain }),
    'input-provenance.json': encode({ ...JSON.parse(readFileSync(a.inputs, 'utf8')).inputs,
      polygons: Object.fromEntries(pieces.map((p) => [p.id, pin(p.polyText)])) }),
    'offline-crossing.json': encode({ scope: 'engine-union-vs-whole-graph-not-device-proof',
      routes: JSON.parse(readFileSync(join(a.work, 'routes.json'), 'utf8')) }),
  };
  const descriptor = encode(buildDescriptor({ pieces, wholeTiles, evidence }));
  mkdirSync(a.out, { recursive: true });
  writeFileSync(join(a.out, `${a.country}-install-descriptor.json`), descriptor);
  for (const [name, text] of Object.entries(evidence)) writeFileSync(join(a.out, `${a.country}-provenance-${name}`), text);
  for (const p of pieces) writeFileSync(join(a.out, `${p.id}.coverage.json`), p.coverageJson);
  console.log(JSON.stringify({ descriptorPin: pin(descriptor), connectedGraphSha256: graphDigest(wholeTiles) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
