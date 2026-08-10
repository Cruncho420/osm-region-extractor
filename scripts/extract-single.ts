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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, createReadStream, createWriteStream, renameSync } from 'fs';
import { gzipSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
// BUG-278: definitive over/under-bridge detection (grade-separated crossing = no shared node).
import { computeUnderBridgeCrossings, type BridgeWayGeom, type HighwayWayGeom } from './underBridgeCrossings';
import { computeRingIdentity, type RingIdentity } from './ringIdentity';

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
  /**
   * ARCH-21: which PHYSICAL roundabout this row belongs to. OSM splits one roundabout into many
   * `junction=roundabout` ways, so this row is an ARC — its centroid sits on the ring EDGE and its
   * radius is a half-chord. Rows sharing a `ringId` are one roundabout; see ringIdentity.ts for the
   * union-find and the id encoding. Optional so a region built by an older extractor still parses:
   * the app requires the id on EVERY row before it trusts any of them, and otherwise falls back to
   * reassembling rings from geometry.
   */
  ringId?: number;
}

interface BundledRoadWay {
  /** Flat array: [lon1, lat1, lon2, lat2, ...] — FULL OSM node density */
  coords: number[];
  /** Road classification for priority matching */
  highway: string;
  /** Normalized surface type when present (asphalt/gravel/etc) */
  surface?: string;
  /** Road name from OSM `name` tag — primary identity signal for "same road" matching at junctions */
  name?: string;
  /** Route reference from OSM `ref` tag (e.g. "A4", "M1", "E67") — strongest identity signal on numbered routes */
  ref?: string;
  /** OSM `oneway` tag value: "yes" | "-1" | "no" | "reversible" — needed for direction-of-travel disambiguation on dual carriageways */
  oneway?: string;
  /** OSM `junction` tag value: "roundabout" | "mini_roundabout" | "circular" | etc — marks ways that are PART of a junction structure */
  junction?: string;
  /** Raw OSM `maxspeed` tag (e.g. "50", "30 mph", "RO:urban", "none") — normalized to whole km/h in build-sqlite for the speed-limit HUD (FEAT-031) */
  maxspeed?: string;
  /** OSM way ID (positive integer) — enables stable cross-reference between segments and topology lookups */
  osmId?: number;
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
  'chicane',
  'choker',
  'island',
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

    // Step 2b: Ring identity (ARCH-21).
    //
    // A SECOND read of the same filtered PBF, in OPL rather than GeoJSON, purely to recover the
    // NODE IDS that GeoJSON does not carry. Two `junction=roundabout` ways are the same physical
    // roundabout exactly when they share a node — the one signal that separates a junction from a
    // grade-separated crossing by definition rather than by a distance threshold. Every threshold
    // tried app-side has been wrong at some ring size; that is the entire recurrence pattern behind
    // BUG-368/399/413/434/459/461.
    //
    // Cheap: the filtered PBF holds only roundabouts, calming and bridges, so this is 67 ms for
    // Lithuania and ~2 s for Great Britain. Non-fatal by design — a region that fails here still
    // ships, just without ids, and the app reassembles rings from geometry as it does today.
    const oplPath = `/tmp/${regionId}-filtered.opl`;
    let ringIdentity: RingIdentity | undefined;
    try {
      console.log(`[2b/11] Resolving physical ring identity from node topology...`);
      execSync(`osmium cat "${filteredPbf}" -f opl -o "${oplPath}" --overwrite`, { stdio: 'inherit' });
      ringIdentity = await computeRingIdentity(oplPath);
      console.log(
        `      ${ringIdentity.wayCount} roundabout ways -> ${ringIdentity.ringCount} physical rings ` +
          `(${ringIdentity.ringIdByMiniNodeId.size} minis, ${ringIdentity.minisOnRing} on a ring)\n`,
      );
    } catch (err) {
      console.warn(`      ⚠️  Ring identity unavailable, falling back to geometric collapse: ${err}`);
      ringIdentity = undefined;
    } finally {
      if (existsSync(oplPath)) unlinkSync(oplPath);
    }

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

    const { data: bundledData, bridgeWays } = convertToBundledFormat(geojson, regionId, ringIdentity);

    console.log(`      Traffic calming points: ${bundledData.trafficCalming.length}`);
    console.log(`      Roundabouts: ${bundledData.roundabouts.length}`);
    console.log(`      Bridge ways (for under-bridge detection): ${bridgeWays.length}`);

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
        `w/highway=motorway,motorway_link,trunk,trunk_link,` +
        `primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,` +
        `residential,unclassified,living_street,service,track,road ` +
        `-o "${wayFilteredPbf}"`,
      { stdio: 'inherit' }
    );

    const wayFilteredSize = statSync(wayFilteredPbf).size / (1024 * 1024);
    console.log(`      Filtered way size: ${wayFilteredSize.toFixed(2)} MB\n`);

    // Step 7: Export ways to GeoJSON sequence (one feature per line — avoids string size limit)
    // --add-unique-id=type_id includes the OSM way @id ("w12345") in feature.properties,
    // letting downstream consumers reference ways stably across runs.
    console.log(`[7/11] Converting ways to GeoJSON sequence...`);
    execSync(`osmium export "${wayFilteredPbf}" -f geojsonseq --add-unique-id=type_id -o "${wayOutputJson}"`, {
      stdio: 'inherit',
    });

    // BUG-278: under-bridge crossings. The highway geojsonseq now exists — stream the roads
    // near bridges, compute where a driven road passes UNDER a grade-separated bridge, append
    // those under_bridge POINTs to the core, and re-compress it (the core was written+compressed
    // above, before the highway geometry existed).
    const nearbyHighways = await collectHighwaysNearBridges(wayOutputJson, bridgeWays);
    const underBridges = computeUnderBridgeCrossings(bridgeWays, nearbyHighways);
    if (underBridges.length > 0) {
      for (const ub of underBridges) {
        bundledData.trafficCalming.push({ lat: ub.lat, lon: ub.lon, type: ub.type, wayId: ub.wayId });
      }
      const recompressed = gzipSync(Buffer.from(JSON.stringify(bundledData)), { level: 9 });
      // Atomic replace: temp file + rename, so a crash mid-write can never leave a
      // truncated-but-checksum-valid core (the manifest step checksums whatever is on disk).
      const tmpGz = `${outputGz}.tmp`;
      writeFileSync(tmpGz, recompressed);
      renameSync(tmpGz, outputGz);
      console.log(`      Under-bridge crossings: ${underBridges.length} (core re-compressed → ${bundledData.trafficCalming.length} TC points)`);
    } else {
      console.log(`      Under-bridge crossings: 0`);
    }

    // Step 8: Convert to optimized way format (streaming read + streaming write)
    console.log(`[8/11] Converting ways to optimized format...`);
    const wayTmpOutput = `${wayOutputJson}.tmp`;
    const wayCount = await streamConvertWays(wayOutputJson, wayTmpOutput, regionId);
    console.log(`      Road ways: ${wayCount}`);

    // Compress from the streamed JSON file (avoid loading into memory)
    execSync(`gzip -9 -c "${wayTmpOutput}" > "${wayOutputGz}"`, { stdio: 'inherit' });
    const wayJsonSize = statSync(wayTmpOutput).size / 1024;
    const wayGzSize = statSync(wayOutputGz).size / 1024;
    unlinkSync(wayTmpOutput);
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

    // Step 11: Convert to optimized surface format (streaming read + streaming write)
    console.log(`[11/11] Converting surfaces to optimized format...`);
    const surfaceTmpOutput = `${surfaceOutputJson}.tmp`;
    const surfaceCount = await streamConvertSurfaces(surfaceOutputJson, surfaceTmpOutput, regionId);
    console.log(`      Road surfaces: ${surfaceCount}`);

    // Compress from the streamed JSON file (avoid loading into memory)
    execSync(`gzip -9 -c "${surfaceTmpOutput}" > "${surfaceOutputGz}"`, { stdio: 'inherit' });
    const surfaceJsonSize = statSync(surfaceTmpOutput).size / 1024;
    const surfaceGzSize = statSync(surfaceOutputGz).size / 1024;
    unlinkSync(surfaceTmpOutput);
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
    const wayTmpOutput = `${wayOutputJson}.tmp`;
    const surfaceTmpOutput = `${surfaceOutputJson}.tmp`;
    [localPbf, filteredPbf, outputJson, wayFilteredPbf, wayOutputJson, surfaceFilteredPbf, surfaceOutputJson, wayTmpOutput, surfaceTmpOutput].forEach((file) => {
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
/**
 * The numeric OSM id behind osmium's typed `feature.id` ("w12345" / "n678"), or undefined when the
 * export carried none. Kept strict about the type prefix: a way id and a node id can be the same
 * NUMBER, so reading one as the other would look up a real but unrelated ring.
 */
function osmIdOf(feature: { id?: unknown }, kind: 'w' | 'n'): number | undefined {
  const raw = feature.id;
  if (typeof raw !== 'string' || !raw.startsWith(kind)) return undefined;
  const num = parseInt(raw.slice(1), 10);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function convertToBundledFormat(
  geojson: GeoJSONFeatureCollection,
  regionId: string,
  ringIdentity?: RingIdentity
): { data: BundledOSMData; bridgeWays: BridgeWayGeom[] } {
  const trafficCalming: TrafficCalmingPoint[] = [];
  const roundabouts: RoundaboutInfo[] = [];
  // BUG-278: full-geometry of every bridge=yes way (+ layer), kept for the under-bridge
  // crossing computation. The trafficCalming entry only keeps the two endpoints; the crossing
  // join needs the whole polyline to test where a road passes underneath.
  const bridgeWays: BridgeWayGeom[] = [];

  for (const feature of geojson.features) {
    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;

    // Handle Point features (nodes)
    if (geometry.type === 'Point') {
      const [lon, lat] = geometry.coordinates as [number, number];

      // Traffic calming nodes — handle semicolon-separated values (e.g. "chicane;choker")
      if (props.traffic_calming) {
        const tcValues = props.traffic_calming.split(';');
        for (const tcValue of tcValues) {
          const trimmed = tcValue.trim();
          if (TRAFFIC_CALMING_TYPES.has(trimmed)) {
            trafficCalming.push({
              lat,
              lon,
              type: mapTrafficCalmingType(trimmed),
              tags: extractRelevantTags(props),
            });
          }
        }
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
        // A mini whose node lies ON a ring inherits that ring's id, so the app draws one pin
        // instead of a ring plus a mini stacked on it; every other mini is its own junction and
        // gets its own id. Decided in ringIdentity.ts, where the node topology still exists.
        const nodeId = osmIdOf(feature, 'n');
        const ringId = nodeId !== undefined ? ringIdentity?.ringIdByMiniNodeId.get(nodeId) : undefined;
        roundabouts.push({
          lat,
          lon,
          type: 'mini_roundabout',
          radius: 3, // Mini roundabouts are typically < 4m
          ...(ringId !== undefined ? { ringId } : {}),
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
        const wayId = osmIdOf(feature, 'w');
        const ringId = wayId !== undefined ? ringIdentity?.ringIdByWayId.get(wayId) : undefined;
        roundabouts.push({
          lat: center[1],
          lon: center[0],
          type: 'roundabout',
          radius: Math.round(radius),
          ...(ringId !== undefined ? { ringId } : {}),
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

        // BUG-278: keep the full bridge polyline (+ layer) for under-bridge crossing detection.
        if (props.bridge === 'yes') {
          const layerRaw = typeof props.layer === 'string' ? parseInt(props.layer, 10) : undefined;
          bridgeWays.push({
            wayId,
            coords: coords.map(([lon, lat]) => [lon, lat] as [number, number]),
            layer: layerRaw !== undefined && !Number.isNaN(layerRaw) ? layerRaw : undefined,
          });
        }
      }
    }

    // Handle Polygon features (closed ways like roundabouts)
    if (geometry.type === 'Polygon') {
      const coords = (geometry.coordinates as [number, number][][])[0];

      if (props.junction === 'roundabout') {
        const center = calculateCentroid(coords);
        const radius = calculateMaxRadius(coords, center);
        // A closed ring exported as a Polygon is still ONE way, and osmium still labels it "w<id>".
        // It usually needs no reassembly on its own, but it can share a node with the arcs of a
        // neighbouring ring, so it must be stamped like any other way — skipping it here would
        // leave a row without an id and, because the app demands the id on EVERY row, silently
        // disable the whole mechanism for that query box.
        const wayId = osmIdOf(feature, 'w');
        const ringId = wayId !== undefined ? ringIdentity?.ringIdByWayId.get(wayId) : undefined;
        roundabouts.push({
          lat: center[1],
          lon: center[0],
          type: 'roundabout',
          radius: Math.round(radius),
          ...(ringId !== undefined ? { ringId } : {}),
        });
      }
    }
  }

  return {
    data: {
      version: new Date().toISOString().split('T')[0],
      region: regionId,
      trafficCalming,
      roundabouts,
    },
    bridgeWays,
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
  if (osmType === 'choker') return 'narrowing';
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
 * BUG-278: stream the highway GeoJSON-sequence and collect ONLY the motor-vehicle ways whose
 * geometry passes near a bridge (any vertex in a grid cell the bridge bbox touches, ±1 cell).
 * Keeps memory ≈ "roads near bridges", not the whole region, then feeds computeUnderBridgeCrossings.
 * Reads full geometry + layer + tunnel/covered so the crossing join is definitive.
 */
async function collectHighwaysNearBridges(
  inputPath: string,
  bridges: BridgeWayGeom[],
): Promise<HighwayWayGeom[]> {
  const CELL = 0.01; // must match GRID_CELL_DEG in underBridgeCrossings.ts
  const key = (cx: number, cy: number) => `${cx}:${cy}`;

  // Grid cells within (bridge bbox + 1-cell ring). A road crossing a bridge necessarily has
  // a vertex in one of these cells.
  const bridgeCells = new Set<string>();
  for (const b of bridges) {
    if (b.coords.length < 2) continue;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of b.coords) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    const x0 = Math.floor(minLon / CELL) - 1, x1 = Math.floor(maxLon / CELL) + 1;
    const y0 = Math.floor(minLat / CELL) - 1, y1 = Math.floor(maxLat / CELL) + 1;
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) bridgeCells.add(key(cx, cy));
  }
  if (bridgeCells.size === 0) return [];

  const parseWayId = (id: unknown): number | undefined => {
    if (typeof id !== 'string') return undefined;
    if (id.startsWith('w')) return parseInt(id.substring(1), 10);
    if (id.startsWith('way/')) return parseInt(id.split('/')[1], 10);
    return undefined;
  };

  const highways: HighwayWayGeom[] = [];
  const rl = createInterface({
    input: createReadStream(inputPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim().replace(/^\x1e/, '');
    if (!trimmed) continue;
    let feature: GeoJSONFeature & { id?: unknown };
    try {
      feature = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;
    if (geometry.type !== 'LineString') continue;
    const highway = props.highway;
    if (!highway) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    let near = false;
    for (const [lon, lat] of coords) {
      if (bridgeCells.has(key(Math.floor(lon / CELL), Math.floor(lat / CELL)))) { near = true; break; }
    }
    if (!near) continue;

    const layerRaw = typeof props.layer === 'string' ? parseInt(props.layer, 10) : undefined;
    highways.push({
      wayId: parseWayId(feature.id),
      highway,
      coords: coords.map(([lon, lat]) => [lon, lat] as [number, number]),
      layer: layerRaw !== undefined && !Number.isNaN(layerRaw) ? layerRaw : undefined,
      isTunnel: props.tunnel === 'yes' || props.covered === 'yes',
    });
  }

  return highways;
}

/**
 * Stream-read a GeoJSON sequence file and stream-write optimized way JSON.
 * Never holds all ways in memory — reads one feature at a time and writes immediately.
 * Returns the count of processed ways.
 */
async function streamConvertWays(inputPath: string, outputPath: string, regionId: string): Promise<number> {
  const ws = createWriteStream(outputPath, { encoding: 'utf-8' });
  const version = new Date().toISOString().split('T')[0];
  ws.write(`{"version":"${version}","region":"${regionId}","roadWays":[`);

  let count = 0;

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
      continue; // Skip malformed lines
    }

    const props = feature.properties as Record<string, string>;
    const geometry = feature.geometry;
    if (geometry.type !== 'LineString') continue;

    const highway = props.highway;
    if (!highway) continue;

    // Skip service subtypes that are never the driving road (driveways, parking aisles).
    // These cause surface contamination when their paving_stones/cobblestone surface
    // gets attributed to the adjacent main road via proximity matching.
    const serviceType = props.service;
    if (highway === 'service' && (serviceType === 'driveway' || serviceType === 'parking_aisle')) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    const flatCoords: number[] = [];
    for (const [lon, lat] of coords) {
      flatCoords.push(lon, lat);
    }

    if (count > 0) ws.write(',');
    // Include surface tag when present — enables primary-tier surface matching
    // on road_ways without needing separate road_surface mediation
    const surface = props.surface ? normalizeSurfaceType(props.surface) : undefined;
    const way: Record<string, unknown> = { coords: flatCoords, highway };
    if (surface && surface !== 'unknown') way.surface = surface;

    // Identity tags — needed by the routing/way-following pipeline to match
    // "same road" continuation at junctions. Each tag is optional; absence means
    // the upstream consumer falls back to bearing/class-only scoring.
    if (props.name) way.name = props.name;
    if (props.ref) way.ref = props.ref;
    if (props.oneway) way.oneway = props.oneway;
    if (props.junction) way.junction = props.junction;
    // Raw maxspeed string — normalized to whole km/h in build-sqlite (FEAT-031 speed HUD).
    if (props.maxspeed) way.maxspeed = props.maxspeed;

    // OSM way ID. osmium-export with --add-unique-id=type_id emits the typed
    // string "w12345" at feature.id (top-level, NOT inside properties). We
    // strip the "w" prefix and store the numeric ID so downstream SQL can
    // index it as an INTEGER.
    const idStr = feature.id;
    if (typeof idStr === 'string' && idStr.startsWith('w')) {
      const num = parseInt(idStr.slice(1), 10);
      if (Number.isFinite(num) && num > 0) way.osmId = num;
    }

    ws.write(JSON.stringify(way));
    count++;
  }

  ws.write(']}');
  ws.end();

  // Wait for the write stream to finish
  await new Promise<void>((resolve, reject) => {
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  return count;
}

/**
 * Stream-read a GeoJSON sequence file and stream-write optimized surface JSON.
 * Never holds all surfaces in memory — reads one feature at a time and writes immediately.
 * Returns the count of processed surfaces.
 */
async function streamConvertSurfaces(inputPath: string, outputPath: string, regionId: string): Promise<number> {
  const ws = createWriteStream(outputPath, { encoding: 'utf-8' });
  const version = new Date().toISOString().split('T')[0];
  ws.write(`{"version":"${version}","region":"${regionId}","roadSurfaces":[`);

  let count = 0;

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
    if (geometry.type !== 'LineString') continue;

    const surface = props.surface;
    if (!surface) continue;

    // Skip service subtypes that are never the driving road (driveways, parking aisles).
    // These cause surface contamination when their paving_stones/cobblestone surface
    // gets attributed to the adjacent main road via proximity matching.
    const serviceType = props.service;
    if (props.highway === 'service' && (serviceType === 'driveway' || serviceType === 'parking_aisle')) continue;

    const coords = geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    const normalized = normalizeSurfaceType(surface);
    const flatCoords: number[] = [];
    for (const [lon, lat] of coords) {
      flatCoords.push(lon, lat);
    }

    if (count > 0) ws.write(',');
    ws.write(JSON.stringify({ surface: normalized, coords: flatCoords }));
    count++;
  }

  ws.write(']}');
  ws.end();

  // Wait for the write stream to finish
  await new Promise<void>((resolve, reject) => {
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  return count;
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
