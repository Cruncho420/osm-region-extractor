/**
 * PURPOSE: Convert Geofabrik's exact extract .poly boundary into compact app metadata.
 * RESPONSIBILITY: Parse/validate polygon rings and stamp the conservative routing margin.
 * DEPENDENCIES: Node built-ins only.
 * CONSUMERS: valhalla-tiles.yml, valhalla-coverage-backfill.yml, verify-release.ts and
 *   the app's Valhalla pack downloader (Rods services/valhalla/valhallaCoverage.ts).
 *
 * The app REFUSES to route on a pack without this file. Output must stay byte-stable:
 * the 2026-09-03 Bayern/Italy/Lithuania files were produced by this exact code and the
 * manifest pins their sha256 prefix.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SAFETY_MARGIN_METERS = 10_000;
const COORDINATE_DECIMALS = 6;

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function rounded(value) {
  return Number(value.toFixed(COORDINATE_DECIMALS));
}

export function parseGeofabrikPoly(text) {
  const lines = text.split(/\r?\n/);
  const rings = [];
  let current = null;
  let sawTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!sawTitle) {
      sawTitle = true;
      continue;
    }
    if (line === 'END') {
      if (current) {
        if (current.coordinates.length < 3) throw new Error('Coverage ring has fewer than 3 points');
        const first = current.coordinates[0];
        const last = current.coordinates[current.coordinates.length - 1];
        if (!samePoint(first, last)) current.coordinates.push([...first]);
        rings.push(current);
        current = null;
      }
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length === 2) {
      const longitude = Number(parts[0]);
      const latitude = Number(parts[1]);
      if (
        current && Number.isFinite(longitude) && Number.isFinite(latitude) &&
        longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
      ) {
        current.coordinates.push([rounded(longitude), rounded(latitude)]);
        continue;
      }
    }

    if (current) throw new Error(`Invalid coordinate line: ${line}`);
    current = { exclude: line.startsWith('!'), coordinates: [] };
  }

  if (current) throw new Error('Coverage polygon ended without END');
  if (!rings.some((ring) => !ring.exclude)) throw new Error('Coverage polygon has no inclusion ring');
  return rings;
}

function isPair(value) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [longitude, latitude] = value;
  return Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
}

function isRing(ring) {
  if (!ring || typeof ring.exclude !== 'boolean' || !Array.isArray(ring.coordinates)) return false;
  if (ring.coordinates.length < 4 || !ring.coordinates.every(isPair)) return false;
  return samePoint(ring.coordinates[0], ring.coordinates[ring.coordinates.length - 1]);
}

/**
 * Mirror of the app's parseValhallaCoverage() acceptance rules. Anything this
 * accepts and the app rejects is a pack the app silently cannot route on, so the
 * two must change together.
 */
export function isValidCoverageDocument(doc) {
  return !!doc && typeof doc === 'object' &&
    doc.schemaVersion === 1 && doc.source === 'geofabrik-poly-v1' &&
    typeof doc.sourceChecksum === 'string' && /^[a-f0-9]{16}$/.test(doc.sourceChecksum) &&
    Number.isFinite(doc.safetyMarginMeters) && doc.safetyMarginMeters > 0 &&
    doc.safetyMarginMeters <= 100_000 && Array.isArray(doc.rings) &&
    doc.rings.every(isRing) && doc.rings.some((ring) => !ring.exclude);
}

export function buildCoverageDocument(polyText) {
  const rings = parseGeofabrikPoly(polyText);
  return {
    schemaVersion: 1,
    source: 'geofabrik-poly-v1',
    sourceChecksum: createHash('sha256').update(polyText).digest('hex').slice(0, 16),
    safetyMarginMeters: SAFETY_MARGIN_METERS,
    rings,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input');
  const outputIndex = args.indexOf('--output');
  const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : null;
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
  if (!inputPath || !outputPath) {
    throw new Error('Usage: node generate-valhalla-coverage.mjs --input region.poly --output coverage.json');
  }
  const document = buildCoverageDocument(readFileSync(inputPath, 'utf8'));
  if (!isValidCoverageDocument(document)) throw new Error(`${inputPath}: coverage fails the app contract`);
  writeFileSync(outputPath, `${JSON.stringify(document)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();

