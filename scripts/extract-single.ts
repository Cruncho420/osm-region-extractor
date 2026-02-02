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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, createReadStream } from 'fs';
import { gzipSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

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

interface BundledRoadWay {
  /** Flat array: [lon1, lat1, lon2, lat2, ...] — FULL OSM node density */
  coords: number[];
  /** Road classification for priority matching */
  highway: string;
}

interface BundledWayData {
  version: string;
  region: string;
  roadWays: BundledRoadWay[];
}

interface BundledRoadSurface {
  /** Normalized surface type (asphalt, gravel, etc.) */
  surface: string;
  /** Flat array: [lon1, lat1, lon2, lat2, ...] */
  coords: number[];
}

interface BundledSurfaceData {
  version: string;
  region: string;
  roadSurfaces: BundledRoadSurface[];
}

interface BundledOSMData {
  version: string;
  region: string;
  trafficCalming: TrafficCalmingPoint[];
  roundabouts: RoundaboutInfo[];
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
    console.log(`[1/11] Downloading from Geofabrik...`);
    console.log(`      URL: ${pbfUrl}`);
    // Use curl (available on macOS) instead of wget
    execSync(`curl -L --progress-bar -o "${localPbf}" "${pbfUrl}"`, {
      stdio: 'inherit',
    });

    const pbfSize = statSync(localPbf).size / (1024 * 1024);
    console.log(`      Downloaded: ${pbfSize.toFixed(1)} MB\n`);

    // Step 2: Filter to only relevant tags
    console.log(`[2/11] Filtering to traffic calming features...`);
    // Use osmium tags-filter to extract only what we need:
    // - n/traffic_calming (nodes with traffic calming)
    // - n/highway=speed_camera (speed camera nodes)
    // - n/enforcement=maxspeed (speed enforcement nodes)
    // - w/bridge=yes (bridge ways)
    // - w/tunnel=yes (tunnel ways)
    // - nw/junction=roundabout (roundabout nodes and ways)
    // - n/highway=mini_roundabout (mini roundabout nodes)
    execSync(
      `osmium tags-filter "${localPbf}" ` +
        `n/traffic_calming ` +
        `n/highway=speed_camera ` +
        `n/enforcement=maxspeed ` +
        `w/bridge=yes ` +
        `w/tunnel=yes ` +
        `nw/junction=roundabout ` +
        `n/highway=mini_roundabout ` +
        `-o "${filteredPbf}"`,
      { stdio: 'inherit' }
    );

    const filteredSize = statSync(filteredPbf).size / (1024 * 1024);
    console.log(`      Filtered size: ${filteredSize.toFixed(2)} MB\n`);

    // Step 3: Export to GeoJSON
    // Use --add-unique-id type_id to include OSM IDs (e.g., "way/12345") for deduplication
    console.log(`[3/11] Converting to GeoJSON...`);
    execSync(`osmium export "${filteredPbf}" -f geojson --add-unique-id=type_id -o "${outputJson}"`, {
      stdio: 'inherit',
    });

    // Step 4: Parse GeoJSON and convert to our optimized format
    console.log(`[4/11] Converting to optimized format...`);
    const geojson: GeoJSONFeatureCollection = JSON.parse(
      readFileSync(outputJson, 'utf-8')
    );

    const bundledData = convertToBundledFormat(geojson, regionId);

    console.log(`      Traffic calming points: ${bundledData.trafficCalming.length}`);
    console.log(`      Roundabouts: ${bundledData.roundabouts.length}`);

    // Write the optimized JSON
    const optimizedJson = JSON.stringify(bundledData);
    writeFileSync(outputJson, optimizedJson);

    // Step 5: Compress with gzip
    console.log(`[5/11] Compressing with gzip...`);
    const jsonContent = readFileSync(outputJson);
    const compressed = gzipSync(jsonContent, { level: 9 });
    writeFileSync(outputGz, compressed);

    const jsonSize = statSync(outputJson).size / 1024;
    const gzSize = statSync(outputGz).size / 1024;
    console.log(`      JSON size: ${jsonSize.toFixed(1)} KB`);
    console.log(`      Compressed size: ${gzSize.toFixed(1)} KB`);
    console.log(`      Compression ratio: ${((1 - gzSize / jsonSize) * 100).toFixed(1)}%\n`);

    // Clean up intermediate files for core data
    unlinkSync(filteredPbf);
    unlinkSync(outputJson); // Keep only the compressed version

    console.log(`\n✓ ${region.name} core data complete: ${outputGz}`);
    console.log(`  Final size: ${(gzSize / 1024).toFixed(2)} MB\n`);

    // Step 6: Extract highway ways for dense road geometry
    console.log(`[6/11] Filtering highway ways for road geometry...`);
    const wayFilteredPbf = `/tmp/${regionId}-ways-filtered.osm.pbf`;
    const wayOutputJson = join(OUTPUT_DIR, `${regionId}-ways.json`);
    const wayOutputGz = join(OUTPUT_DIR, `${regionId}-ways.json.gz`);

    execSync(
      `osmium tags-filter "${localPbf}" ` +
        `w/highway=primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,` +
        `residential,unclassified,living_street,service ` +
        `-o "${wayFilteredPbf}"`,
      { stdio: 'inherit' }
    );

    const wayFilteredSize = statSync(wayFilteredPbf).size / (1024 * 1024);
    console.log(`      Filtered way size: ${wayFilteredSize.toFixed(2)} MB\n`);

    // Step 7: Export ways to GeoJSON sequence (one feature per line — avoids string size limit)
    console.log(`[7/11] Converting ways to GeoJSON sequence...`);
    execSync(`osmium export "${wayFilteredPbf}" -f geojsonseq -o "${wayOutputJson}"`, {
      stdio: 'inherit',
    });

    // Step 8: Convert to optimized way format (streaming, line-by-line)
    console.log(`[8/11] Converting ways to optimized format...`);
    const wayData = await streamConvertWays(wayOutputJson, regionId);
    console.log(`      Road ways: ${wayData.roadWays.length}`);

    const wayOptimizedJson = JSON.stringify(wayData);
    writeFileSync(wayOutputJson, wayOptimizedJson);

    const wayJsonContent = readFileSync(wayOutputJson);
    const wayCompressed = gzipSync(wayJsonContent, { level: 9 });
    writeFileSync(wayOutputGz, wayCompressed);

    const wayJsonSize = statSync(wayOutputJson).size / 1024;
    const wayGzSize = statSync(wayOutputGz).size / 1024;
    console.log(`      Way JSON size: ${(wayJsonSize / 1024).toFixed(1)} MB`);
    console.log(`      Way compressed size: ${(wayGzSize / 1024).toFixed(1)} MB`);
    console.log(`      Compression ratio: ${((1 - wayGzSize / wayJsonSize) * 100).toFixed(1)}%\n`);

    // Step 9: Extract road surfaces (highway ways with surface=* tag)
    console.log(`[9/11] Filtering highway ways with surface tags...`);
    const surfaceFilteredPbf = `/tmp/${regionId}-surfaces-filtered.osm.pbf`;
    const surfaceOutputJson = join(OUTPUT_DIR, `${regionId}-surfaces.json`);
    const surfaceOutputGz = join(OUTPUT_DIR, `${regionId}-surfaces.json.gz`);

    // Two-step filter: first get highway ways, then narrow to those with surface tag.
    // Reuse the wayFilteredPbf (already filtered to highway types) and narrow to surface=*
    execSync(
      `osmium tags-filter "${wayFilteredPbf}" w/surface -o "${surfaceFilteredPbf}"`,
      { stdio: 'inherit' }
    );

    const surfaceFilteredSize = statSync(surfaceFilteredPbf).size / (1024 * 1024);
    console.log(`      Filtered surface size: ${surfaceFilteredSize.toFixed(2)} MB\n`);

    // Step 10: Export surfaces to GeoJSON sequence (one feature per line)
    console.log(`[10/11] Converting surface ways to GeoJSON sequence...`);
    execSync(`osmium export "${surfaceFilteredPbf}" -f geojsonseq -o "${surfaceOutputJson}"`, {
      stdio: 'inherit',
    });

    // Step 11: Convert to optimized surface format (streaming, line-by-line)
    console.log(`[11/11] Converting surfaces to optimized format...`);
    const surfaceData = await streamConvertSurfaces(surfaceOutputJson, regionId);
    console.log(`      Road surfaces: ${surfaceData.roadSurfaces.length}`);

    const surfaceOptimizedJson = JSON.stringify(surfaceData);
    writeFileSync(surfaceOutputJson, surfaceOptimizedJson);

    const surfaceJsonContent = readFileSync(surfaceOutputJson);
    const surfaceCompressed = gzipSync(surfaceJsonContent, { level: 9 });
    writeFileSync(surfaceOutputGz, surfaceCompressed);

    const surfaceJsonSize = statSync(surfaceOutputJson).size / 1024;
    const surfaceGzSize = statSync(surfaceOutputGz).size / 1024;
    console.log(`      Surface JSON size: ${(surfaceJsonSize / 1024).toFixed(1)} MB`);
    console.log(`      Surface compressed size: ${(surfaceGzSize / 1024).toFixed(1)} MB`);
    console.log(`      Compression ratio: ${((1 - surfaceGzSize / surfaceJsonSize) * 100).toFixed(1)}%\n`);

    // Clean up all remaining intermediate files
    unlinkSync(localPbf);
    unlinkSync(wayFilteredPbf);
    unlinkSync(wayOutputJson);
    unlinkSync(surfaceFilteredPbf);
    unlinkSync(surfaceOutputJson);

    console.log(`\n✓ ${region.name} complete: core + ways + surfaces`);
    console.log(`  Core: ${(gzSize / 1024).toFixed(2)} MB, Ways: ${(wayGzSize / 1024).toFixed(2)} MB, Surfaces: ${(surfaceGzSize / 1024).toFixed(2)} MB\n`);
  } catch (error) {
    console.error(`\n✗ Error processing ${region.name}:`, error);

    // Clean up any partial files
    const wayFilteredPbf = `/tmp/${regionId}-ways-filtered.osm.pbf`;
    const wayOutputJson = join(OUTPUT_DIR, `${regionId}-ways.json`);
    const surfaceFilteredPbf = `/tmp/${regionId}-surfaces-filtered.osm.pbf`;
    const surfaceOutputJson = join(OUTPUT_DIR, `${regionId}-surfaces.json`);
    [localPbf, filteredPbf, outputJson, wayFilteredPbf, wayOutputJson, surfaceFilteredPbf, surfaceOutputJson].forEach((file) => {
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
 * Convert GeoJSON to our optimized bundled format
 */
function convertToBundledFormat(
  geojson: GeoJSONFeatureCollection,
  regionId: string
): BundledOSMData {
  const trafficCalming: TrafficCalmingPoint[] = [];
  const roundabouts: RoundaboutInfo[] = [];

  for (const feature of geojson.features) {
    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;

    // Handle Point features (nodes)
    if (geometry.type === 'Point') {
      const [lon, lat] = geometry.coordinates as [number, number];

      // Traffic calming nodes
      if (props.traffic_calming && TRAFFIC_CALMING_TYPES.has(props.traffic_calming)) {
        trafficCalming.push({
          lat,
          lon,
          type: mapTrafficCalmingType(props.traffic_calming),
          tags: extractRelevantTags(props),
        });
      }

      // Speed cameras
      if (props.highway === 'speed_camera' || props.enforcement === 'maxspeed') {
        trafficCalming.push({
          lat,
          lon,
          type: 'speed_camera',
          tags: extractRelevantTags(props),
        });
      }

      // Mini roundabouts (nodes)
      if (props.highway === 'mini_roundabout') {
        roundabouts.push({
          lat,
          lon,
          type: 'mini_roundabout',
          radius: 3, // Mini roundabouts are typically < 4m
        });
      }
    }

    // Handle LineString features (ways)
    if (geometry.type === 'LineString') {
      const coords = geometry.coordinates as [number, number][];

      // Roundabout ways
      if (props.junction === 'roundabout') {
        const center = calculateCentroid(coords);
        const radius = calculateMaxRadius(coords, center);
        roundabouts.push({
          lat: center[1],
          lon: center[0],
          type: 'roundabout',
          radius: Math.round(radius),
        });
      }

      // Bridge and tunnel ways - store BOTH endpoints for route traversal verification
      // This enables the same endpoint-matching logic used by the Overpass API query
      if (props.bridge === 'yes' || props.tunnel === 'yes') {
        const [startLon, startLat] = coords[0];
        const [endLon, endLat] = coords[coords.length - 1];

        // Extract OSM way ID from feature.id
        // osmium exports with --add-unique-id=type_id as "w12345" (w=way, n=node, r=relation)
        // This enables deduplication of multi-segment bridges/tunnels
        let wayId: number | undefined;
        if (feature.id && typeof feature.id === 'string') {
          // Handle osmium format: "w12345" or "way/12345"
          if (feature.id.startsWith('w')) {
            wayId = parseInt(feature.id.substring(1), 10);
          } else if (feature.id.startsWith('way/')) {
            wayId = parseInt(feature.id.split('/')[1], 10);
          }
        }

        trafficCalming.push({
          lat: startLat,
          lon: startLon,
          type: props.bridge === 'yes' ? 'bridge' : 'tunnel',
          tags: extractRelevantTags(props),
          // Store second endpoint for route traversal verification
          endLat: endLat,
          endLon: endLon,
          // Store way ID for deduplication of multi-segment features
          wayId,
        });
      }
    }

    // Handle Polygon features (closed ways like roundabouts)
    if (geometry.type === 'Polygon') {
      const coords = (geometry.coordinates as [number, number][][])[0];

      if (props.junction === 'roundabout') {
        const center = calculateCentroid(coords);
        const radius = calculateMaxRadius(coords, center);
        roundabouts.push({
          lat: center[1],
          lon: center[0],
          type: 'roundabout',
          radius: Math.round(radius),
        });
      }
    }
  }

  return {
    version: new Date().toISOString().split('T')[0],
    region: regionId,
    trafficCalming,
    roundabouts,
  };
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

/**
 * Convert GeoJSON highway ways to optimized format with full node density
 */
function convertToWayFormat(
  geojson: GeoJSONFeatureCollection,
  regionId: string
): BundledWayData {
  const roadWays: BundledRoadWay[] = [];

  for (const feature of geojson.features) {
    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;

    // Only LineString ways (skip any Point or Polygon features)
    if (geometry.type !== 'LineString') continue;

    const highway = props.highway;
    if (!highway) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    // Store as flat array [lon1, lat1, lon2, lat2, ...] at FULL OSM node density
    const flatCoords: number[] = [];
    for (const [lon, lat] of coords) {
      flatCoords.push(lon, lat);
    }

    roadWays.push({
      coords: flatCoords,
      highway,
    });
  }

  return {
    version: new Date().toISOString().split('T')[0],
    region: regionId,
    roadWays,
  };
}

/**
 * Normalize raw OSM surface tag to a standardized type.
 * Must stay in sync with services/osm/roadSurface.ts normalization.
 */
function normalizeSurfaceType(osmSurface: string): string {
  const map: Record<string, string> = {
    // Paved
    'asphalt': 'asphalt',
    'concrete': 'concrete',
    'concrete:plates': 'concrete',
    'concrete:lanes': 'concrete',
    'paved': 'paved',
    'cobblestone': 'cobblestone',
    'cobblestone:flattened': 'cobblestone',
    'paving_stones': 'cobblestone',
    'sett': 'cobblestone',
    // Unpaved
    'gravel': 'gravel',
    'fine_gravel': 'gravel',
    'pebblestone': 'gravel',
    'compacted': 'compacted',
    'dirt': 'dirt',
    'earth': 'dirt',
    'mud': 'dirt',
    'sand': 'dirt',
    'grass': 'grass',
    'grass_paver': 'grass',
    'unpaved': 'unpaved',
    'ground': 'unpaved',
  };
  return map[osmSurface] ?? 'unknown';
}

/**
 * Convert GeoJSON highway ways (with surface tags) to optimized surface format
 */
function convertToSurfaceFormat(
  geojson: GeoJSONFeatureCollection,
  regionId: string
): BundledSurfaceData {
  const roadSurfaces: BundledRoadSurface[] = [];

  for (const feature of geojson.features) {
    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;

    // Only LineString ways
    if (geometry.type !== 'LineString') continue;

    const surface = props.surface;
    if (!surface) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    const normalized = normalizeSurfaceType(surface);

    // Store as flat array [lon1, lat1, lon2, lat2, ...]
    const flatCoords: number[] = [];
    for (const [lon, lat] of coords) {
      flatCoords.push(lon, lat);
    }

    roadSurfaces.push({
      surface: normalized,
      coords: flatCoords,
    });
  }

  return {
    version: new Date().toISOString().split('T')[0],
    region: regionId,
    roadSurfaces,
  };
}

// =============================================================================
// STREAMING CONVERTERS (for large files that exceed Node.js string limit)
// =============================================================================

/**
 * Stream-read a GeoJSON sequence file (one feature per line) and convert ways.
 * Avoids loading the entire file into memory as a single string.
 */
async function streamConvertWays(filePath: string, regionId: string): Promise<BundledWayData> {
  const roadWays: BundledRoadWay[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let feature: GeoJSONFeature;
    try {
      feature = JSON.parse(trimmed);
    } catch {
      continue; // Skip malformed lines
    }

    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;
    if (geometry.type !== 'LineString') continue;

    const highway = props.highway;
    if (!highway) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    const flatCoords: number[] = [];
    for (const [lon, lat] of coords) {
      flatCoords.push(lon, lat);
    }

    roadWays.push({ coords: flatCoords, highway });
  }

  return {
    version: new Date().toISOString().split('T')[0],
    region: regionId,
    roadWays,
  };
}

/**
 * Stream-read a GeoJSON sequence file and convert surface ways.
 */
async function streamConvertSurfaces(filePath: string, regionId: string): Promise<BundledSurfaceData> {
  const roadSurfaces: BundledRoadSurface[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let feature: GeoJSONFeature;
    try {
      feature = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;
    if (geometry.type !== 'LineString') continue;

    const surface = props.surface;
    if (!surface) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    const normalized = normalizeSurfaceType(surface);
    const flatCoords: number[] = [];
    for (const [lon, lat] of coords) {
      flatCoords.push(lon, lat);
    }

    roadSurfaces.push({ surface: normalized, coords: flatCoords });
  }

  return {
    version: new Date().toISOString().split('T')[0],
    region: regionId,
    roadSurfaces,
  };
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
