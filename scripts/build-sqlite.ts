#!/usr/bin/env node
/**
 * Build SQLite Database Script
 *
 * PURPOSE: Convert extracted JSON.gz files into a pre-built SQLite database
 * RESPONSIBILITY: Stream-decompress JSON, compute bboxes, bulk-insert into SQLite, compress
 * DEPENDENCIES: better-sqlite3, stream-json, extracted .json.gz files
 * CONSUMERS: GitHub Actions workflow, app downloads the resulting .sqlite.gz
 *
 * Usage: npm run build-sqlite -- --region europe-lithuania
 *
 * Input: output/{region-id}.json.gz, output/{region-id}-surfaces.json.gz, output/{region-id}-ways.json.gz
 * Output: output/{region-id}.sqlite.gz
 */

import { createReadStream, existsSync, unlinkSync, statSync } from 'fs';
import { createGunzip } from 'zlib';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick.js';
import { streamArray } from 'stream-json/streamers/StreamArray.js';
import { chain } from 'stream-json/utils/chain.js';

// =============================================================================
// TYPES
// =============================================================================

interface BundledTrafficCalming {
  lat: number;
  lon: number;
  type: string;
  tags?: Record<string, string>;
  endLat?: number;
  endLon?: number;
  wayId?: number;
}

interface BundledRoundabout {
  lat: number;
  lon: number;
  radius?: number;
  type: 'roundabout' | 'mini_roundabout';
}

interface BundledRoadSurface {
  surface: string;
  coords: number[];
}

interface BundledRoadWay {
  highway: string;
  coords: number[];
}

// =============================================================================
// SCHEMA — must match osmDatabase.ts SCHEMA_SQL exactly
// =============================================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS road_surfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  coords TEXT NOT NULL,
  min_lat REAL NOT NULL,
  max_lat REAL NOT NULL,
  min_lon REAL NOT NULL,
  max_lon REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surfaces_bbox ON road_surfaces(min_lat, max_lat, min_lon, max_lon);

CREATE TABLE IF NOT EXISTS traffic_calming (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  type TEXT NOT NULL,
  end_lat REAL,
  end_lon REAL,
  way_id INTEGER,
  tags TEXT
);
CREATE INDEX IF NOT EXISTS idx_tc_lat_lon ON traffic_calming(lat, lon);

CREATE TABLE IF NOT EXISTS roundabouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius REAL,
  type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ra_lat_lon ON roundabouts(lat, lon);

CREATE TABLE IF NOT EXISTS road_ways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  highway TEXT NOT NULL,
  coords TEXT NOT NULL,
  min_lat REAL NOT NULL,
  max_lat REAL NOT NULL,
  min_lon REAL NOT NULL,
  max_lon REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ways_bbox ON road_ways(min_lat, max_lat, min_lon, max_lon);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// =============================================================================
// CONSTANTS
// =============================================================================

const __filename = fileURLToPath(import.meta.url);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Compute bounding box from a flat coords array [lon1, lat1, lon2, lat2, ...].
 * Same logic as computeBboxFromFlatCoords in osmDatabase.ts.
 */
function computeBboxFromFlatCoords(coords: number[]): {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
} {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (let i = 0; i < coords.length - 1; i += 2) {
    const lon = coords[i];
    const lat = coords[i + 1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Stream-parse a JSON array from a .json.gz file using stream-json's pick + streamArray.
 *
 * For core files, the structure is: { version, region, trafficCalming: [...], roundabouts: [...] }
 * For surface files: { version, region, roadSurfaces: [...] }
 * For way files: { version, region, roadWays: [...] }
 *
 * Reads the full file but streams array items one by one, keeping memory bounded.
 */
function streamJsonArray<T>(
  gzipPath: string,
  arrayKey: string,
  onItem: (item: T) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fileStream = createReadStream(gzipPath);

    const jsonChain = chain([
      createGunzip(),
      parser(),
      pick({ filter: arrayKey }),
      streamArray(),
    ]);

    jsonChain.on('data', ({ value }: { value: T }) => {
      onItem(value);
    });

    jsonChain.on('end', resolve);
    jsonChain.on('error', reject);

    fileStream.on('error', (err: Error) => {
      jsonChain.destroy();
      reject(err);
    });

    fileStream.pipe(jsonChain.input);
  });
}

/**
 * Stream-parse a JSON object's scalar properties (version, region) from a .json.gz file.
 * Returns only top-level string properties, ignoring arrays.
 */
function readJsonMetadata(gzipPath: string): Promise<{ version: string; region: string }> {
  return new Promise((resolve, reject) => {
    const result: Record<string, string> = {};
    const fileStream = createReadStream(gzipPath);
    const gunzip = createGunzip();
    const jsonParser = parser();

    let currentKey: string | null = null;
    let depth = 0;

    jsonParser.on('data', (chunk: { name: string; value?: string | number }) => {
      if (chunk.name === 'startObject') depth++;
      else if (chunk.name === 'endObject') depth--;
      else if (chunk.name === 'startArray') depth++;
      else if (chunk.name === 'endArray') depth--;
      else if (depth === 1 && chunk.name === 'keyValue') {
        currentKey = chunk.value as string;
      } else if (depth === 1 && chunk.name === 'stringValue' && currentKey) {
        result[currentKey] = chunk.value as string;
        currentKey = null;
      }
    });

    jsonParser.on('end', () => {
      resolve({
        version: result.version || '',
        region: result.region || '',
      });
    });

    jsonParser.on('error', reject);
    gunzip.on('error', reject);
    fileStream.on('error', reject);

    fileStream.pipe(gunzip).pipe(jsonParser);
  });
}

// =============================================================================
// MAIN BUILD FUNCTION
// =============================================================================

async function buildSqlite(regionId: string, outputDir: string): Promise<void> {
  const t0 = Date.now();
  console.log(`\n========================================`);
  console.log(`Building SQLite for: ${regionId}`);
  console.log(`========================================\n`);

  const corePath = join(outputDir, `${regionId}.json.gz`);
  const surfacePath = join(outputDir, `${regionId}-surfaces.json.gz`);
  const wayPath = join(outputDir, `${regionId}-ways.json.gz`);
  const sqlitePath = join(outputDir, `${regionId}.sqlite`);
  const sqliteGzPath = join(outputDir, `${regionId}.sqlite.gz`);

  // Verify core file exists
  if (!existsSync(corePath)) {
    throw new Error(`Core file not found: ${corePath}`);
  }

  // Clean up any previous output
  if (existsSync(sqlitePath)) unlinkSync(sqlitePath);
  if (existsSync(sqliteGzPath)) unlinkSync(sqliteGzPath);

  // Create SQLite database
  const db = new Database(sqlitePath);

  // Use DELETE journal mode for cross-SQLite-version compatibility (not WAL)
  db.pragma('journal_mode = DELETE');
  // Performance pragmas for bulk insert
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000'); // 64MB cache

  // Create schema
  db.exec(SCHEMA_SQL);

  // Begin transaction for all inserts
  db.exec('BEGIN TRANSACTION');

  // Prepare insert statements
  const insertTC = db.prepare(
    'INSERT INTO traffic_calming (lat, lon, type, end_lat, end_lon, way_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertRA = db.prepare(
    'INSERT INTO roundabouts (lat, lon, radius, type) VALUES (?, ?, ?, ?)',
  );
  const insertSurface = db.prepare(
    'INSERT INTO road_surfaces (surface, coords, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertWay = db.prepare(
    'INSERT INTO road_ways (highway, coords, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?, ?)',
  );

  // Read metadata from core file
  console.log('Reading metadata...');
  const meta = await readJsonMetadata(corePath);
  console.log(`  version: ${meta.version}, region: ${meta.region}`);

  // Insert traffic calming data
  let tcCount = 0;
  console.log('Streaming traffic calming data...');
  await streamJsonArray<BundledTrafficCalming>(corePath, 'trafficCalming', (tc) => {
    insertTC.run(
      tc.lat,
      tc.lon,
      tc.type,
      tc.endLat ?? null,
      tc.endLon ?? null,
      tc.wayId ?? null,
      tc.tags ? JSON.stringify(tc.tags) : null,
    );
    tcCount++;
  });
  console.log(`  ✓ ${tcCount} traffic calming features`);

  // Insert roundabouts
  let raCount = 0;
  console.log('Streaming roundabout data...');
  await streamJsonArray<BundledRoundabout>(corePath, 'roundabouts', (ra) => {
    insertRA.run(ra.lat, ra.lon, ra.radius ?? null, ra.type);
    raCount++;
  });
  console.log(`  ✓ ${raCount} roundabouts`);

  // Insert surface data
  let surfaceCount = 0;
  let hasSurfaceData = false;
  if (existsSync(surfacePath)) {
    console.log('Streaming surface data...');
    await streamJsonArray<BundledRoadSurface>(surfacePath, 'roadSurfaces', (rs) => {
      const { minLat, maxLat, minLon, maxLon } = computeBboxFromFlatCoords(rs.coords);
      insertSurface.run(rs.surface, JSON.stringify(rs.coords), minLat, maxLat, minLon, maxLon);
      surfaceCount++;
    });
    hasSurfaceData = surfaceCount > 0;
    console.log(`  ✓ ${surfaceCount} road surfaces`);
  } else {
    console.log('  ⚠ No surface data file');
  }

  // Insert way data
  let wayCount = 0;
  let hasWayData = false;
  if (existsSync(wayPath)) {
    console.log('Streaming way data...');
    await streamJsonArray<BundledRoadWay>(wayPath, 'roadWays', (rw) => {
      const { minLat, maxLat, minLon, maxLon } = computeBboxFromFlatCoords(rw.coords);
      insertWay.run(rw.highway, JSON.stringify(rw.coords), minLat, maxLat, minLon, maxLon);
      wayCount++;
    });
    hasWayData = wayCount > 0;
    console.log(`  ✓ ${wayCount} road ways`);
  } else {
    console.log('  ⚠ No way data file');
  }

  // Insert metadata
  const insertMeta = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  insertMeta.run('version', meta.version);
  insertMeta.run('region', meta.region);
  insertMeta.run('createdAt', new Date().toISOString());
  insertMeta.run('hasSurfaceData', hasSurfaceData ? 'true' : 'false');
  insertMeta.run('hasWayData', hasWayData ? 'true' : 'false');

  // Commit transaction
  db.exec('COMMIT');
  db.close();

  const sqliteSize = statSync(sqlitePath).size;
  console.log(`\nSQLite database: ${(sqliteSize / 1024 / 1024).toFixed(1)} MB`);

  // Compress with gzip
  console.log('Compressing...');
  execSync(`gzip -9 -k "${sqlitePath}"`, { stdio: 'inherit' });

  // Remove uncompressed SQLite (only keep .sqlite.gz for release)
  unlinkSync(sqlitePath);

  const gzSize = statSync(sqliteGzPath).size;
  const ratio = ((1 - gzSize / sqliteSize) * 100).toFixed(1);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n✓ Built ${regionId}.sqlite.gz`);
  console.log(`  Rows: ${tcCount} tc + ${raCount} ra + ${surfaceCount} surfaces + ${wayCount} ways`);
  console.log(`  SQLite: ${(sqliteSize / 1024 / 1024).toFixed(1)} MB → gzip: ${(gzSize / 1024 / 1024).toFixed(1)} MB (${ratio}% compression)`);
  console.log(`  Time: ${elapsed}s`);
}

// =============================================================================
// CLI ENTRY POINT
// =============================================================================

const args = process.argv.slice(2);
const regionIndex = args.indexOf('--region');
const outputIndex = args.indexOf('--output');

if (regionIndex === -1 || !args[regionIndex + 1]) {
  console.error('Usage: npm run build-sqlite -- --region <region-id> [--output <dir>]');
  process.exit(1);
}

const regionId = args[regionIndex + 1];
const outputDir = outputIndex !== -1 && args[outputIndex + 1] ? args[outputIndex + 1] : './output';

buildSqlite(regionId, outputDir).catch((err) => {
  console.error(`\n✗ Failed to build SQLite for ${regionId}:`, err);
  process.exit(1);
});
