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
import {
  computeUnderBridgeCrossings,
  type BridgeWayGeom,
  type HighwayWayGeom,
  type UnderBridgeStats,
} from './underBridgeCrossings';

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
  /** Normalized surface type when OSM has surface tag (Phase 2 mirror) */
  surface?: string;
  /** OSM oneway: `'yes'` = forward along polyline, `'-1'` = reverse-only.
   *  Absent = bidirectional (or implicit oneway like motorway, handled by
   *  walker via highway-class rules).
   *  MERGE NOTE: deliberately kept NARROW (`'yes' | '-1'`) rather than the
   *  identity branch's `string`. This value feeds the Free-Roam way-walker, so
   *  widening what gets stored could change walker routing → pace-note output →
   *  a PACE_NOTE_ALGORITHM_VERSION bump. Out of scope for a schema merge. */
  oneway?: 'yes' | '-1';
  /** Diagnostic street name. Used in walker logs and metro traces. */
  name?: string;
  /** Route reference from OSM `ref` (e.g. "A4", "M1", "E67") — strongest
   *  identity signal on numbered routes. Additive: nothing reads it yet. */
  ref?: string;
  /** Restrictive access tag: `private`, `no`, `destination`, `delivery`,
   *  `customers`. Absent = `yes` or `permissive` (public). Walker rejects
   *  ways with restrictive access from drivable candidates. */
  access?: 'private' | 'no' | 'destination' | 'delivery' | 'customers';
  /** OSM junction tag (e.g. `roundabout`). Road-identity signal — absent on
   *  ordinary roads. Written to road_ways.junction by build-sqlite.ts. */
  junction?: string;
  /** Raw OSM `maxspeed` tag (e.g. `"50"`, `"30 mph"`, `"RO:urban"`, `"none"`).
   *  Normalized to a whole km/h integer by build-sqlite.ts for the speed-limit
   *  HUD (FEAT-031). Display-only — never feeds pace-note generation. */
  maxspeed?: string;
  /** Country-coded legal-context tag (`maxspeed:type` / `zone:maxspeed` /
   *  `source:maxspeed`, e.g. `"LT:rural"`, `"DE:zone30"`). Lets the app resolve
   *  the EXACT legal default when no numeric maxspeed exists (inferred-limits
   *  tier 2). Only country-coded values are kept (`"sign"`, survey notes → dropped). */
  maxspeedType?: string;
  /** OSM way ID (positive integer) — a STABLE cross-download identity key, unlike
   *  `road_ways.id`, which is a per-build AUTOINCREMENT rowid and means a
   *  different road in every extract. Additive: nothing reads it yet. */
  osmId?: number;
}

/** Built-up area reduced to its bounding box — all the app's occupancy-grid
 *  urban test needs (inferred-limits tier 3). Bbox-only keeps the payload tiny. */
interface BuiltUpArea {
  /** 'landuse' (residential/retail/commercial/industrial polygon) or
   *  'place_city' | 'place_town' | 'place_village' (place node + nominal radius). */
  kind: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
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
  /** FEAT-051 toll plazas. A SEPARATE array (and a separate SQLite table) rather than a
   *  `type` inside trafficCalming, because builds before 1.8.10 map an unknown calming type
   *  to `speed_bump` — a shared-array row would announce a phantom bump at every toll booth
   *  in Europe on those builds. */
  tollPoints: TollPoint[];
}

/** One toll plaza. Points only — a booth has no extent worth storing. */
interface TollPoint {
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

/** Toll-plaza merge radius, metres — DELIBERATELY EQUAL to the callout's GROUPING_DISTANCE
 *  (config/paceNoteConfig/trafficCalming.ts: 100).
 *
 *  Two problems, one radius:
 *
 *  1. PER-LANE NODES. OSM maps ONE `barrier=toll_booth` node PER LANE — Mont Blanc carries 4
 *     inside ~15 m, and France's 1,827 booths are roughly 400 plazas. Unmerged that is four
 *     stacked pins on one barrier.
 *
 *  2. SEE-VS-HEAR DRIFT, which is why this is 100 and not 40. The callout layer groups toll
 *     points within 100 m into ONE spoken "toll booth". If extraction merged at a SMALLER
 *     radius, two plazas 70 m apart would be announced once but drawn as two pins and counted
 *     as "2 Tolls" on the preview card, the route-list chip and CarPlay — the app contradicting
 *     itself about the same piece of road. Matching the radii makes one plaza-group produce
 *     exactly one point, one pin, one count and one callout.
 *
 *  Merging two plazas the callout would have announced separately is therefore impossible by
 *  construction: the thresholds are the same number. */
const TOLL_CLUSTER_RADIUS_M = 100;

/**
 * Collapse a plaza-group into ONE point — see TOLL_CLUSTER_RADIUS_M.
 *
 * TRANSITIVE flood-fill, not a leader-anchored scan. Each unclustered node opens a cluster and
 * the cluster grows to absorb any node within TOLL_CLUSTER_RADIUS_M of ANY member already in it.
 * The leader-anchored version measured 40 m from whichever node the GeoJSON scan happened to
 * reach first — typically an EDGE lane — so it captured 40 m from one side rather than across
 * the plaza, and a wide motorway plaza (10-20 lanes) split into two clusters and drew two pins.
 * Chaining cannot run away here: the radius stays far below the ~100 m callout GROUPING_DISTANCE,
 * and real plazas are bounded, so a chain terminates at the plaza edge.
 *
 * Emits the cluster's centroid and keeps the richest tag set in it (the named node, when one
 * lane carries `name`/`operator` and the rest are bare — the common OSM shape).
 *
 * O(n²) worst case, deliberately: this runs OFFLINE in the extractor, once per region, over a
 * few thousand nodes per country (FR is 1,827) — never on device, never on the GPS path.
 */
function clusterTollPoints(points: TollPoint[]): TollPoint[] {
  const out: TollPoint[] = [];
  const used = new Array<boolean>(points.length).fill(false);

  for (let i = 0; i < points.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const members = [points[i]];

    // Flood-fill: re-scan while the cluster keeps growing, so a node reachable only via
    // another member (a lane at the far side of a wide plaza) is still absorbed.
    for (let m = 0; m < members.length; m++) {
      for (let j = i + 1; j < points.length; j++) {
        if (used[j]) continue;
        if (haversineMetres(members[m].lat, members[m].lon, points[j].lat, points[j].lon) <= TOLL_CLUSTER_RADIUS_M) {
          used[j] = true;
          members.push(points[j]);
        }
      }
    }

    let sumLat = 0;
    let sumLon = 0;
    let best: TollPoint = members[0];
    for (const m of members) {
      sumLat += m.lat;
      sumLon += m.lon;
      if (Object.keys(m.tags ?? {}).length > Object.keys(best.tags ?? {}).length) best = m;
    }
    const meanLat = sumLat / members.length;
    const meanLon = sumLon / members.length;

    // EMIT THE MEDOID, NOT THE MEAN — the real member node nearest the centre.
    //
    // The app accepts a POINT feature only within POINT_FEATURE_TOLERANCE = 1 m of the routed
    // polyline ("the route must pass THROUGH the feature", osmLocalQuery.ts:53-56). A plaza's
    // booth nodes sit side by side ACROSS the carriageway, so their arithmetic mean is a
    // synthetic point that need not lie on any lane — on a wide plaza it can fall metres to the
    // side of the route line and be silently dropped. That would have failed on exactly the
    // multi-lane plazas this clustering exists for, and it would have been WORSE than no
    // clustering: unclustered, each lane node is tested separately and the one the route
    // actually crosses passes.
    //
    // A medoid is an actual OSM booth node, so it sits on a real lane by construction, while
    // still collapsing the plaza to ONE point.
    let medoid: TollPoint = members[0];
    let bestD = Infinity;
    for (const m of members) {
      const d = haversineMetres(meanLat, meanLon, m.lat, m.lon);
      if (d < bestD) {
        bestD = d;
        medoid = m;
      }
    }
    out.push({ lat: medoid.lat, lon: medoid.lon, tags: best.tags });
  }

  return out;
}

/** Great-circle distance in metres. Local copy — this script must not import app code. */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
        `n/barrier=toll_booth ` +
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

    const { data: bundledData, bridgeWays } = convertToBundledFormat(geojson, regionId);

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
    // BUG-422: the extractor is the ONLY place that knows the (deck, road) pair at decision
    // time — the shipped row records just the deck — so a suppression is invisible downstream
    // forever unless it is counted right here. Printed unconditionally, including the zero
    // case: a silent zero is exactly how a whole feature dies unnoticed.
    const ubStats: UnderBridgeStats = {
      crossings: 0, emitted: 0, suppressedBridgeBelow: 0,
      abstainedEqualLevel: 0, rejectedDeckClass: 0, roadBelowIsDeck: 0,
    };
    const underBridges = computeUnderBridgeCrossings(bridgeWays, nearbyHighways, ubStats);
    console.log(
      `      Under-bridge grade test: ${ubStats.crossings} crossings → ${ubStats.emitted} emitted · ` +
      `${ubStats.suppressedBridgeBelow} suppressed (deck was BELOW the road) · ` +
      `${ubStats.abstainedEqualLevel} abstained (equal layer, OSM contradiction) · ` +
      `${ubStats.rejectedDeckClass} decks rejected by class (footbridge / not built) · ` +
      `${ubStats.roadBelowIsDeck} where the road below was itself a deck`
    );
    if (underBridges.length > 0) {
      for (const ub of underBridges) {
        bundledData.trafficCalming.push({
          lat: ub.lat,
          lon: ub.lon,
          type: ub.type,
          wayId: ub.wayId,
          // BUG-422 / ARCH-41: the id of the road that passes UNDERNEATH, so the app can ask
          // "which of these two ways am I on?" instead of inferring it from heading. Rides the
          // EXISTING `tags` column — no schema change in either repo, and under_bridge rows
          // carry no tags today. `rods:` namespaced because this is a derived join key, not an
          // OSM tag; the colon can never collide with a real key.
          ...(ub.underWayId !== undefined
            ? { tags: { 'rods:under_way_id': String(ub.underWayId) } }
            : {}),
        });
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

    // Steps 12-14: Built-up areas (inferred-limits tier 3 — urban/rural signal).
    // landuse polygons (residential/retail/commercial/industrial) + place nodes
    // (city/town/village), reduced to BBOXES ONLY — the app's occupancy-grid
    // urban test needs nothing more, and bbox-only keeps the payload tiny.
    // NON-FATAL: built-up data is optional-by-design everywhere downstream (the
    // app degrades to "urban unknown"), so a failure here must NOT drop the whole
    // region from the release — log and continue without the builtup file.
    const builtupFilteredPbf = `/tmp/${regionId}-builtup-filtered.osm.pbf`;
    const builtupOutputJson = join(OUTPUT_DIR, `${regionId}-builtup.json`);
    const builtupOutputGz = join(OUTPUT_DIR, `${regionId}-builtup.json.gz`);
    let builtupGzSize = 0;
    try {
      console.log(`[builtup 1/3] Filtering built-up areas (landuse + place)...`);
      execSync(
        `osmium tags-filter "${localPbf}" ` +
          `a/landuse=residential,retail,commercial,industrial ` +
          `n/place=city,town,village ` +
          `-o "${builtupFilteredPbf}"`,
        { stdio: 'inherit' }
      );

      console.log(`[builtup 2/3] Converting built-up areas to GeoJSON sequence...`);
      execSync(`osmium export "${builtupFilteredPbf}" -f geojsonseq -o "${builtupOutputJson}"`, {
        stdio: 'inherit',
      });

      console.log(`[builtup 3/3] Converting built-up areas to bbox format...`);
      const builtupTmpOutput = `${builtupOutputJson}.tmp`;
      const builtupCount = await streamConvertBuiltUp(builtupOutputJson, builtupTmpOutput, regionId);
      console.log(`      Built-up areas: ${builtupCount}`);

      execSync(`gzip -9 -c "${builtupTmpOutput}" > "${builtupOutputGz}"`, { stdio: 'inherit' });
      builtupGzSize = statSync(builtupOutputGz).size / 1024;
      unlinkSync(builtupTmpOutput);
      console.log(`      Built-up compressed size: ${builtupGzSize.toFixed(1)} KB\n`);
    } catch (builtupError) {
      console.warn(`      ⚠ Built-up extraction failed for ${regionId} — continuing WITHOUT builtup data (optional):`, builtupError);
      // Remove any partial builtup outputs so downstream never sees a truncated file
      [builtupOutputGz, builtupOutputJson, `${builtupOutputJson}.tmp`].forEach((f) => {
        if (existsSync(f)) { try { unlinkSync(f); } catch { /* ignore */ } }
      });
    }

    // Clean up all remaining intermediate files
    unlinkSync(localPbf);
    unlinkSync(wayFilteredPbf);
    unlinkSync(wayOutputJson);
    unlinkSync(surfaceFilteredPbf);
    unlinkSync(surfaceOutputJson);
    if (existsSync(builtupFilteredPbf)) unlinkSync(builtupFilteredPbf);
    if (existsSync(builtupOutputJson)) unlinkSync(builtupOutputJson);

    console.log(`\n✓ ${region.name} complete: core + ways + surfaces + builtup`);
    console.log(`  Core: ${(gzSize / 1024).toFixed(2)} MB, Ways: ${(wayGzSize / 1024).toFixed(2)} MB, Surfaces: ${(surfaceGzSize / 1024).toFixed(2)} MB, BuiltUp: ${(builtupGzSize / 1024).toFixed(2)} MB\n`);
  } catch (error) {
    console.error(`\n✗ Error processing ${region.name}:`, error);

    // Clean up any partial files
    const wayFilteredPbf = `/tmp/${regionId}-ways-filtered.osm.pbf`;
    const wayOutputJson = join(OUTPUT_DIR, `${regionId}-ways.json`);
    const surfaceFilteredPbf = `/tmp/${regionId}-surfaces-filtered.osm.pbf`;
    const surfaceOutputJson = join(OUTPUT_DIR, `${regionId}-surfaces.json`);
    const builtupFilteredPbf = `/tmp/${regionId}-builtup-filtered.osm.pbf`;
    const builtupOutputJson = join(OUTPUT_DIR, `${regionId}-builtup.json`);
    const wayTmpOutput = `${wayOutputJson}.tmp`;
    const surfaceTmpOutput = `${surfaceOutputJson}.tmp`;
    const builtupTmpOutput = `${builtupOutputJson}.tmp`;
    [localPbf, filteredPbf, outputJson, wayFilteredPbf, wayOutputJson, surfaceFilteredPbf, surfaceOutputJson, builtupFilteredPbf, builtupOutputJson, wayTmpOutput, surfaceTmpOutput, builtupTmpOutput].forEach((file) => {
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
): { data: BundledOSMData; bridgeWays: BridgeWayGeom[] } {
  const trafficCalming: TrafficCalmingPoint[] = [];
  const roundabouts: RoundaboutInfo[] = [];
  // BUG-278: full-geometry of every bridge=yes way (+ layer), kept for the under-bridge
  // crossing computation. The trafficCalming entry only keeps the two endpoints; the crossing
  // join needs the whole polyline to test where a road passes underneath.
  const bridgeWays: BridgeWayGeom[] = [];
  // Raw per-lane toll nodes; clustered to one point per plaza after the scan (FEAT-051).
  const rawTollPoints: TollPoint[] = [];

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

      // Toll plazas (FEAT-051) — collected raw here, clustered at TOLL_CLUSTER_RADIUS_M below.
      if (props.barrier === 'toll_booth') {
        rawTollPoints.push({ lat, lon, tags: extractRelevantTags(props) });
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

        // BUG-278: keep the full bridge polyline (+ layer) for under-bridge crossing detection.
        if (props.bridge === 'yes') {
          const layerRaw = typeof props.layer === 'string' ? parseInt(props.layer, 10) : undefined;
          bridgeWays.push({
            wayId,
            coords: coords.map(([lon, lat]) => [lon, lat] as [number, number]),
            layer: layerRaw !== undefined && !Number.isNaN(layerRaw) ? layerRaw : undefined,
            // BUG-422: the DECK's own class. `bridge=yes` is taken unfiltered above, so this
            // batch also holds footbridges, boardwalks, rail viaducts, sign gantries and
            // flyovers still under construction. isAnnounceableDeck decides which of those a
            // driver is told about; without these two tags it cannot.
            highway: typeof props.highway === 'string' ? props.highway : undefined,
            railway: typeof props.railway === 'string' ? props.railway : undefined,
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
        roundabouts.push({
          lat: center[1],
          lon: center[0],
          type: 'roundabout',
          radius: Math.round(radius),
        });
      }
    }
  }

  // FEAT-051: collapse per-lane booth nodes into one point per plaza BEFORE emitting.
  const tollPoints = clusterTollPoints(rawTollPoints);

  return {
    data: {
      version: new Date().toISOString().split('T')[0],
      region: regionId,
      trafficCalming,
      roundabouts,
      tollPoints,
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
      // Retain the PARSED array directly — do NOT `.map()` a copy of it.
      //
      // `coords` already IS `[number, number][]` off JSON.parse, so the copy was a pure
      // no-op that allocated a second 2-element array per coordinate. Each of those costs
      // ~80 bytes of V8 object overhead to hold 16 bytes of data, and this accumulator
      // retains every highway near a bridge for the whole region — so on asia-japan the
      // duplication is tens of millions of arrays and it OOM'd the 7 GB heap at
      // `[7/11] Converting ways to GeoJSON sequence` (2026-07-29 + 2026-07-30 runs, both
      // reproduced on pre-toll main, so this predates and is unrelated to FEAT-051).
      //
      // Keeping the reference does not retain the parent feature: `coords` is its own
      // array object, so the enclosing GeoJSON object is still collectable. Nothing
      // downstream mutates these — computeUnderBridgeCrossings only reads them.
      coords,
      layer: layerRaw !== undefined && !Number.isNaN(layerRaw) ? layerRaw : undefined,
      isTunnel: props.tunnel === 'yes' || props.covered === 'yes',
      // BUG-422: is this road ITSELF a deck? Deliberately looser than the `=== 'yes'` test
      // that admits a way to bridgeWays above, because this side only ever ABSTAINS: a
      // `bridge=viaduct` carrying no explicit layer must not be mistaken for the road below.
      isBridge: typeof props.bridge === 'string' && props.bridge !== 'no',
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
    // Phase 2: oneway / name / access drive Free Roam OSM way-walker routing
    // decisions. `oneway` is the canonical wrong-way-on-oneway signal; only
    // `'yes'` (forward-only along polyline) and `'-1'` (reverse-only) carry
    // meaning. Other values (`no`, `reversible`, etc.) are treated as
    // bidirectional by the walker and not stored. `name` is diagnostic-only
    // (lets logs read "wrong way down Pylimo St" instead of way ids).
    // `access` filters private/destination/no roads from drivable candidates
    // at the walker level; only restrictive values are stored (`private`,
    // `no`, `destination`, `delivery`, `customers`).
    const oneway = props.oneway;
    if (oneway === 'yes' || oneway === '-1') way.oneway = oneway;
    const name = props.name;
    if (name) way.name = name;
    const access = props.access;
    if (access === 'private' || access === 'no' || access === 'destination' || access === 'delivery' || access === 'customers') {
      way.access = access;
    }
    // Road-identity: keep the way's junction tag (junction=roundabout). The app
    // announces a roundabout only when the route's walker drives onto a
    // junction=roundabout way (not by point-proximity — a tunnel UNDER the ring is a
    // different way with no junction tag). build-sqlite.ts writes it to road_ways.junction.
    const junction = props.junction;
    if (junction) way.junction = junction;
    // Raw maxspeed string — build-sqlite.ts normalizes it to whole km/h for the
    // speed-limit HUD (FEAT-031). Keep the raw OSM value here so all parsing
    // (mph→km/h, zone-code/none → NULL) lives in one place.
    if (props.maxspeed) way.maxspeed = props.maxspeed;
    // Legal-context tag (inferred-limits tier 2): country-coded values only
    // ("LT:rural", "DE:zone30"). `source:maxspeed` often holds junk ("sign",
    // survey notes) — the pattern filter drops those. Priority: maxspeed:type
    // (canonical) → zone:maxspeed → source:maxspeed (legacy) → a country-coded
    // value in the maxspeed tag ITSELF (`maxspeed=RO:urban` is a common tagging
    // style; normalizeMaxspeedKmh yields NULL for it, so without this route the
    // explicit legal context would be dropped entirely).
    const CC_CONTEXT = /^[A-Za-z]{2}(-[A-Za-z0-9]+)?:.+$/;
    const msType = props['maxspeed:type'] || props['zone:maxspeed'] || props['source:maxspeed'];
    if (msType && CC_CONTEXT.test(msType.trim())) {
      way.maxspeedType = msType.trim();
    } else if (props.maxspeed && CC_CONTEXT.test(props.maxspeed.trim())) {
      way.maxspeedType = props.maxspeed.trim();
    }
    // Route reference (`ref`), e.g. "A4"/"E67". Additive identity signal — the
    // strongest "same road" discriminator on numbered routes. Nothing consumes
    // it yet; it exists so the app can stop inferring identity from geometry.
    if (props.ref) way.ref = props.ref;

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

/**
 * Stream-read a built-up GeoJSON sequence and stream-write bbox-only JSON.
 * Polygons/MultiPolygons (landuse) → geometry bbox; place nodes → point ± a
 * nominal radius by place size. Pathological giant polygons (>0.25° span,
 * ~28 km — malformed relations) are skipped rather than marking half a region
 * urban. Returns the count of written areas.
 */
async function streamConvertBuiltUp(inputPath: string, outputPath: string, regionId: string): Promise<number> {
  const ws = createWriteStream(outputPath, { encoding: 'utf-8' });
  const version = new Date().toISOString().split('T')[0];
  ws.write(`{"version":"${version}","region":"${regionId}","builtUpAreas":[`);

  // Nominal half-side (degrees) around a place node when no polygon exists.
  // city ~4 km, town ~1.5 km, village ~550 m — errs small; landuse polygons
  // carry the real footprint where mapped.
  const PLACE_HALF_DEG: Record<string, number> = { city: 0.036, town: 0.014, village: 0.005 };
  const MAX_SPAN_DEG = 0.25; // skip malformed giant polygons

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
    let area: BuiltUpArea | null = null;

    if (geometry.type === 'Point' && props.place && PLACE_HALF_DEG[props.place] !== undefined) {
      const [lon, lat] = geometry.coordinates as [number, number];
      const h = PLACE_HALF_DEG[props.place];
      area = { kind: `place_${props.place}`, minLon: lon - h, minLat: lat - h, maxLon: lon + h, maxLat: lat + h };
    } else if ((geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && props.landuse) {
      // Bbox over every ring vertex (outer rings dominate; holes are irrelevant to a bbox).
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      const polys = (geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.coordinates) as [number, number][][][];
      for (const rings of polys) {
        for (const ring of rings) {
          for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
      }
      if (
        Number.isFinite(minLon) &&
        maxLon - minLon <= MAX_SPAN_DEG &&
        maxLat - minLat <= MAX_SPAN_DEG
      ) {
        area = { kind: 'landuse', minLon, minLat, maxLon, maxLat };
      }
    }

    if (!area) continue;
    if (count > 0) ws.write(',');
    ws.write(JSON.stringify(area));
    count++;
  }

  ws.write(']}');
  ws.end();

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
