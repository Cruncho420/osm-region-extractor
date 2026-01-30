#!/usr/bin/env node
/**
 * OSM Data Extraction Script - Single Region
 *
 * PURPOSE: Extract traffic calming and roundabout data from a single Geofabrik region
 * RESPONSIBILITY: Download PBF, filter to relevant tags, convert to JSON, compress
 * DEPENDENCIES: osmium-tool (must be installed on system), regions.json
 * CONSUMERS: GitHub Actions workflow, manual extraction
 *
 * Usage: npm run extract-single -- --region europe-great-britain
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import { createGzip, gzipSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// =============================================================================
// TYPES
// =============================================================================

interface Region {
  id: string;
  name: string;
  continent: string;
  bbox: [number, number, number, number];
  geofabrikPath: string;
  estimatedSize: number;
}

interface RegionsFile {
  regions: Region[];
}

interface GeoJSONFeature {
  type: 'Feature';
  id?: string;
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface TrafficCalmingPoint {
  lat: number;
  lon: number;
  type: string;
  tags?: Record<string, string>;
  /** Second endpoint for linear features (bridges, tunnels) - enables route traversal verification */
  endLat?: number;
  endLon?: number;
  /** OSM way ID for bridges/tunnels - enables deduplication of multi-segment features */
  wayId?: number;
}

interface RoundaboutInfo {
  lat: number;
  lon: number;
  radius?: number;
  type: 'roundabout' | 'mini_roundabout';
}

interface RoadSurfaceWay {
  /** OSM surface tag value (e.g., "asphalt", "gravel") */
  surface: string;
  /** Simplified way geometry as flat array: [lon1, lat1, lon2, lat2, ...] */
  coords: number[];
}

interface BundledOSMData {
  version: string;
  region: string;
  trafficCalming: TrafficCalmingPoint[];
  roundabouts: RoundaboutInfo[];
  roadSurfaces: RoadSurfaceWay[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GEOFABRIK_BASE = 'https://download.geofabrik.de';
const OUTPUT_DIR = join(__dirname, 'output');

// Traffic calming types we care about
const TRAFFIC_CALMING_TYPES = new Set([
  'bump',
  'mini_bumps',
  'hump',
  'table',
  'cushion',
  'dynamic_bump',
  'dip',
  'double_dip',
]);

// =============================================================================
// MAIN FUNCTIONS
// =============================================================================

async function extractRegion(regionId: string): Promise<void> {
  // Load regions config
  const regionsPath = join(__dirname, 'regions.json');
  const regionsData: RegionsFile = JSON.parse(readFileSync(regionsPath, 'utf-8'));

  const region = regionsData.regions.find((r) => r.id === regionId);
  if (!region) {
    console.error(`Region ${regionId} not found in regions.json`);
    process.exit(1);
  }

  console.log(`\n========================================`);
  console.log(`Processing: ${region.name} (${region.id})`);
  console.log(`========================================\n`);

  const pbfUrl = `${GEOFABRIK_BASE}/${region.geofabrikPath}`;
  const localPbf = `/tmp/${regionId}.osm.pbf`;
  const filteredPbf = `/tmp/${regionId}-filtered.osm.pbf`;
  const outputJson = join(OUTPUT_DIR, `${regionId}.json`);
  const outputGz = join(OUTPUT_DIR, `${regionId}.json.gz`);

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    // Step 1: Download PBF from Geofabrik
    console.log(`[1/5] Downloading from Geofabrik...`);
    console.log(`      URL: ${pbfUrl}`);
    // Use curl (available on macOS) instead of wget
    execSync(`curl -L --progress-bar -o "${localPbf}" "${pbfUrl}"`, {
      stdio: 'inherit',
    });

    const pbfSize = statSync(localPbf).size / (1024 * 1024);
    console.log(`      Downloaded: ${pbfSize.toFixed(1)} MB\n`);

    // Step 2: Filter to only relevant tags
    console.log(`[2/5] Filtering to traffic calming + road surface features...`);
    // Use osmium tags-filter to extract only what we need:
    // - n/traffic_calming (nodes with traffic calming)
    // - n/highway=speed_camera (speed camera nodes)
    // - n/enforcement=maxspeed (speed enforcement nodes)
    // - w/bridge=yes (bridge ways)
    // - w/tunnel=yes (tunnel ways)
    // - nw/junction=roundabout (roundabout nodes and ways)
    // - n/highway=mini_roundabout (mini roundabout nodes)
    // - w/surface (ways with surface tags — for road surface breakdown)
    execSync(
      `osmium tags-filter "${localPbf}" ` +
        `n/traffic_calming ` +
        `n/highway=speed_camera ` +
        `n/enforcement=maxspeed ` +
        `w/bridge=yes ` +
        `w/tunnel=yes ` +
        `nw/junction=roundabout ` +
        `n/highway=mini_roundabout ` +
        `w/surface ` +
        `-o "${filteredPbf}"`,
      { stdio: 'inherit' }
    );

    const filteredSize = statSync(filteredPbf).size / (1024 * 1024);
    console.log(`      Filtered size: ${filteredSize.toFixed(2)} MB\n`);

    // Step 3: Export to line-delimited GeoJSON (one feature per line)
    // Use geojsonseq format to avoid loading entire file into memory
    // Use --add-unique-id type_id to include OSM IDs (e.g., "way/12345") for deduplication
    console.log(`[3/5] Converting to GeoJSON (line-delimited)...`);
    execSync(`osmium export "${filteredPbf}" -f geojsonseq --add-unique-id=type_id -o "${outputJson}"`, {
      stdio: 'inherit',
    });

    // Step 4: Parse features line-by-line, streaming road surfaces to temp file
    // Traffic calming and roundabouts are small enough for memory; road surfaces are not.
    console.log(`[4/5] Converting to optimized format...`);
    const rsTempPath = `/tmp/${regionId}-roadsurfaces.ndjson`;
    const { trafficCalming, roundabouts, roadSurfaceCount } =
      await parseAndStreamFeatures(outputJson, rsTempPath);

    console.log(`      Traffic calming points: ${trafficCalming.length}`);
    console.log(`      Roundabouts: ${roundabouts.length}`);
    console.log(`      Road surface ways: ${roadSurfaceCount}`);

    // Step 5: Compose final JSON and compress with gzip (streaming)
    // Write JSON structure piece by piece to avoid holding everything in memory
    console.log(`[5/5] Composing and compressing...`);
    const version = new Date().toISOString().split('T')[0];
    await composeAndCompress(
      outputGz, rsTempPath, version, regionId, trafficCalming, roundabouts
    );

    // Write uncompressed JSON for size reporting, then delete it
    // (Only the .gz is kept)
    const gzSize = statSync(outputGz).size / 1024;

    // Estimate JSON size from gzip (avoid writing huge uncompressed file)
    // For accurate reporting, compute from the parts we have
    const tcJson = JSON.stringify(trafficCalming);
    const raJson = JSON.stringify(roundabouts);
    const headerSize = `{"version":"${version}","region":"${regionId}","trafficCalming":`.length;
    const rsTempSize = existsSync(rsTempPath) ? statSync(rsTempPath).size : 0;
    const jsonSize = (headerSize + tcJson.length + ',"roundabouts":'.length +
      raJson.length + ',"roadSurfaces":['.length + rsTempSize + ']}'.length) / 1024;
    console.log(`      JSON size: ${jsonSize.toFixed(1)} KB`);
    console.log(`      Compressed size: ${gzSize.toFixed(1)} KB`);
    console.log(`      Compression ratio: ${((1 - gzSize / jsonSize) * 100).toFixed(1)}%\n`);

    // Clean up intermediate files
    unlinkSync(localPbf);
    unlinkSync(filteredPbf);
    unlinkSync(outputJson); // Keep only the compressed version
    if (existsSync(rsTempPath)) unlinkSync(rsTempPath);

    console.log(`\n✓ ${region.name} complete: ${outputGz}`);
    console.log(`  Final size: ${(gzSize / 1024).toFixed(2)} MB\n`);
  } catch (error) {
    console.error(`\n✗ Error processing ${region.name}:`, error);

    // Clean up any partial files
    const rsTempCleanup = `/tmp/${regionId}-roadsurfaces.ndjson`;
    [localPbf, filteredPbf, outputJson, rsTempCleanup].forEach((file) => {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    process.exit(1);
  }
}

/**
 * Parse geojsonseq input, collecting small data in memory and streaming
 * road surfaces to a temp ndjson file (one JSON object per line, comma-separated).
 * This avoids OOM on large regions like Russia (9M+ road surface ways).
 */
async function parseAndStreamFeatures(
  inputPath: string,
  rsTempPath: string,
): Promise<{
  trafficCalming: TrafficCalmingPoint[];
  roundabouts: RoundaboutInfo[];
  roadSurfaceCount: number;
}> {
  const trafficCalming: TrafficCalmingPoint[] = [];
  const roundabouts: RoundaboutInfo[] = [];
  let roadSurfaceCount = 0;

  const rsStream = createWriteStream(rsTempPath, { encoding: 'utf-8' });

  const rl = createInterface({
    input: createReadStream(inputPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim().replace(/^\x1e/, '');
    if (!trimmed) continue;

    let feature: GeoJSONFeature;
    try {
      feature = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;

    // Handle Point features (nodes)
    if (geometry.type === 'Point') {
      const [lon, lat] = geometry.coordinates as [number, number];

      if (props.traffic_calming && TRAFFIC_CALMING_TYPES.has(props.traffic_calming)) {
        trafficCalming.push({
          lat, lon,
          type: mapTrafficCalmingType(props.traffic_calming),
          tags: extractRelevantTags(props),
        });
      }

      if (props.highway === 'speed_camera' || props.enforcement === 'maxspeed') {
        trafficCalming.push({ lat, lon, type: 'speed_camera', tags: extractRelevantTags(props) });
      }

      if (props.highway === 'mini_roundabout') {
        roundabouts.push({ lat, lon, type: 'mini_roundabout', radius: 3 });
      }
    }

    // Handle LineString features (ways)
    if (geometry.type === 'LineString') {
      const coords = geometry.coordinates as [number, number][];

      if (props.junction === 'roundabout') {
        const center = calculateCentroid(coords);
        const radius = calculateMaxRadius(coords, center);
        roundabouts.push({
          lat: center[1], lon: center[0], type: 'roundabout', radius: Math.round(radius),
        });
      }

      if (props.bridge === 'yes' || props.tunnel === 'yes') {
        const [startLon, startLat] = coords[0];
        const [endLon, endLat] = coords[coords.length - 1];

        let wayId: number | undefined;
        if (feature.id && typeof feature.id === 'string') {
          if (feature.id.startsWith('w')) {
            wayId = parseInt(feature.id.substring(1), 10);
          } else if (feature.id.startsWith('way/')) {
            wayId = parseInt(feature.id.split('/')[1], 10);
          }
        }

        trafficCalming.push({
          lat: startLat, lon: startLon,
          type: props.bridge === 'yes' ? 'bridge' : 'tunnel',
          tags: extractRelevantTags(props),
          endLat, endLon, wayId,
        });
      }

      // Road surfaces — stream to temp file instead of accumulating in memory
      if (props.surface && props.junction !== 'roundabout') {
        const flatCoords: number[] = [];
        for (const [lon, lat] of coords) {
          flatCoords.push(
            Math.round(lon * 1e7) / 1e7,
            Math.round(lat * 1e7) / 1e7
          );
        }
        const entry = JSON.stringify({ surface: props.surface, coords: flatCoords });
        if (roadSurfaceCount > 0) rsStream.write(',');
        rsStream.write(entry);
        roadSurfaceCount++;
      }
    }

    // Handle Polygon features (closed ways like roundabouts)
    if (geometry.type === 'Polygon') {
      const coords = (geometry.coordinates as [number, number][][])[0];
      if (props.junction === 'roundabout') {
        const center = calculateCentroid(coords);
        const radius = calculateMaxRadius(coords, center);
        roundabouts.push({
          lat: center[1], lon: center[0], type: 'roundabout', radius: Math.round(radius),
        });
      }
    }
  }

  // Wait for write stream to finish flushing
  await new Promise<void>((resolve, reject) => {
    rsStream.end(() => resolve());
    rsStream.on('error', reject);
  });

  return { trafficCalming, roundabouts, roadSurfaceCount };
}

/**
 * Compose the final JSON and gzip-compress it by streaming.
 * Writes: {"version":...,"trafficCalming":[...],"roundabouts":[...],"roadSurfaces":[...streamed from temp...]}
 */
async function composeAndCompress(
  outputGzPath: string,
  rsTempPath: string,
  version: string,
  regionId: string,
  trafficCalming: TrafficCalmingPoint[],
  roundabouts: RoundaboutInfo[],
): Promise<void> {
  const gzipStream = createGzip({ level: 9 });
  const outFile = createWriteStream(outputGzPath);

  // Pipe gzip -> file
  gzipStream.pipe(outFile);

  // Write JSON structure piece by piece through gzip
  gzipStream.write(`{"version":"${version}","region":"${regionId}","trafficCalming":`);
  gzipStream.write(JSON.stringify(trafficCalming));
  gzipStream.write(',"roundabouts":');
  gzipStream.write(JSON.stringify(roundabouts));
  gzipStream.write(',"roadSurfaces":[');

  // Stream road surfaces from temp file (already comma-separated entries)
  if (existsSync(rsTempPath) && statSync(rsTempPath).size > 0) {
    const rsInput = createReadStream(rsTempPath, { encoding: 'utf-8' });
    for await (const chunk of rsInput) {
      gzipStream.write(chunk);
    }
  }

  gzipStream.write(']}');

  // Finalize
  await new Promise<void>((resolve, reject) => {
    outFile.on('finish', resolve);
    outFile.on('error', reject);
    gzipStream.end();
  });
}

/**
 * Map OSM traffic_calming tag to our simplified types
 */
function mapTrafficCalmingType(osmType: string): string {
  const bumpTypes = ['bump', 'mini_bumps', 'hump', 'table', 'cushion', 'dynamic_bump'];
  const dipTypes = ['dip', 'double_dip'];

  if (bumpTypes.includes(osmType)) return 'speed_bump';
  if (dipTypes.includes(osmType)) return 'dip';
  return osmType;
}

/**
 * Extract only relevant tags from properties
 */
function extractRelevantTags(props: Record<string, string>): Record<string, string> | undefined {
  const relevantKeys = ['name', 'maxspeed', 'surface', 'highway', 'ref'];
  const tags: Record<string, string> = {};

  for (const key of relevantKeys) {
    if (props[key]) {
      tags[key] = props[key];
    }
  }

  return Object.keys(tags).length > 0 ? tags : undefined;
}

/**
 * Calculate centroid of a polygon/linestring
 */
function calculateCentroid(coords: [number, number][]): [number, number] {
  let sumLon = 0;
  let sumLat = 0;

  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }

  return [sumLon / coords.length, sumLat / coords.length];
}

/**
 * Calculate maximum radius from center to any point (in meters)
 */
function calculateMaxRadius(
  coords: [number, number][],
  center: [number, number]
): number {
  let maxDistance = 0;

  for (const [lon, lat] of coords) {
    const distance = haversineDistance(center[1], center[0], lat, lon);
    if (distance > maxDistance) {
      maxDistance = distance;
    }
  }

  return maxDistance;
}

/**
 * Calculate total length of a way (in meters)
 */
function calculateWayLength(coords: [number, number][]): number {
  let totalLength = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    totalLength += haversineDistance(lat1, lon1, lat2, lon2);
  }

  return totalLength;
}

/**
 * Calculate distance between two points using Haversine formula
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// =============================================================================
// CLI ENTRY POINT
// =============================================================================

const args = process.argv.slice(2);
const regionIndex = args.indexOf('--region');

if (regionIndex === -1 || !args[regionIndex + 1]) {
  console.error('Usage: npm run extract-single -- --region <region-id>');
  console.error('Example: npm run extract-single -- --region europe-great-britain');
  process.exit(1);
}

const regionId = args[regionIndex + 1];
extractRegion(regionId);
