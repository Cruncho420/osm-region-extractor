#!/usr/bin/env node
/**
 * Generate Manifest Script
 *
 * PURPOSE: Generate manifest.json from extracted OSM data files
 * RESPONSIBILITY: Create a manifest with version, checksums, and file sizes for all regions
 * DEPENDENCIES: regions.json, extracted .json.gz files
 * CONSUMERS: GitHub Actions workflow, osmDataUpdateService.ts
 *
 * Usage: npm run generate-manifest -- --input ./output --output ./output/manifest.json
 */

import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
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

interface ManifestRegion {
  name: string;
  size: number;
  checksum: string;
  surfaceSize?: number;
  surfaceChecksum?: string;
  waySize?: number;
  wayChecksum?: string;
}

interface Manifest {
  version: string;
  generatedAt: string;
  regions: Record<string, ManifestRegion>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// FUNCTIONS
// =============================================================================

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function generateManifest(inputDir: string, outputFile: string): void {
  console.log(`\n========================================`);
  console.log(`Generating Manifest`);
  console.log(`========================================\n`);
  console.log(`Input directory: ${inputDir}`);
  console.log(`Output file: ${outputFile}\n`);

  // Load region names from regions.json
  const regionsPath = join(__dirname, 'regions.json');
  const regionsData: RegionsFile = JSON.parse(readFileSync(regionsPath, 'utf-8'));
  const regionNames: Record<string, string> = {};
  regionsData.regions.forEach((r) => {
    regionNames[r.id] = r.name;
  });

  // Find all .json.gz files in input directory
  const allFiles = readdirSync(inputDir).filter((f) => f.endsWith('.json.gz'));
  // Core files are those that don't have a -surfaces or -ways suffix
  const coreFiles = allFiles.filter(
    (f) => !f.includes('-surfaces') && !f.includes('-ways'),
  );
  console.log(`Found ${coreFiles.length} core region files (${allFiles.length} total files)\n`);

  const manifest: Manifest = {
    version: new Date().toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    regions: {},
  };

  let totalSize = 0;

  for (const file of coreFiles) {
    const regionId = file.replace('.json.gz', '');
    const filePath = join(inputDir, file);
    const stats = statSync(filePath);

    const region: ManifestRegion = {
      name: regionNames[regionId] || regionId,
      size: stats.size,
      checksum: computeChecksum(filePath),
    };

    totalSize += stats.size;

    // Check for surface data file
    const surfaceFile = `${regionId}-surfaces.json.gz`;
    const surfacePath = join(inputDir, surfaceFile);
    try {
      const surfaceStats = statSync(surfacePath);
      region.surfaceSize = surfaceStats.size;
      region.surfaceChecksum = computeChecksum(surfacePath);
      totalSize += surfaceStats.size;
    } catch {
      // No surface file — that's fine
    }

    // Check for way data file
    const wayFile = `${regionId}-ways.json.gz`;
    const wayPath = join(inputDir, wayFile);
    try {
      const wayStats = statSync(wayPath);
      region.waySize = wayStats.size;
      region.wayChecksum = computeChecksum(wayPath);
      totalSize += wayStats.size;
    } catch {
      // No way file — that's fine
    }

    manifest.regions[regionId] = region;

    const extras = [
      region.surfaceSize ? `surfaces: ${(region.surfaceSize / 1024).toFixed(1)} KB` : null,
      region.waySize ? `ways: ${(region.waySize / 1024).toFixed(1)} KB` : null,
    ].filter(Boolean).join(', ');
    console.log(
      `  ${regionId}: ${(stats.size / 1024).toFixed(1)} KB${extras ? ` (${extras})` : ''} - ${regionNames[regionId] || 'Unknown'}`
    );
  }

  writeFileSync(outputFile, JSON.stringify(manifest, null, 2));

  console.log(`\n----------------------------------------`);
  console.log(`Total regions: ${Object.keys(manifest.regions).length}`);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Version: ${manifest.version}`);
  console.log(`\n✓ Manifest generated: ${outputFile}\n`);
}

// =============================================================================
// CLI ENTRY POINT
// =============================================================================

const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');
const outputIndex = args.indexOf('--output');

const inputDir = inputIndex !== -1 && args[inputIndex + 1] ? args[inputIndex + 1] : './output';
const outputFile =
  outputIndex !== -1 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : './output/manifest.json';

generateManifest(inputDir, outputFile);
