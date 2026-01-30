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
  /** Size of the separate road surface file */
  surfaceSize?: number;
  /** Checksum of the separate road surface file */
  surfaceChecksum?: string;
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
  // Core files: {id}.json.gz (exclude surface files: {id}-surfaces.json.gz)
  const allFiles = readdirSync(inputDir).filter((f) => f.endsWith('.json.gz'));
  const coreFiles = allFiles.filter((f) => !f.includes('-surfaces'));
  const surfaceFiles = new Set(allFiles.filter((f) => f.includes('-surfaces')));
  console.log(`Found ${coreFiles.length} core files, ${surfaceFiles.size} surface files\n`);

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

    const entry: ManifestRegion = {
      name: regionNames[regionId] || regionId,
      size: stats.size,
      checksum: computeChecksum(filePath),
    };

    // Check for corresponding surface file
    const surfaceFileName = `${regionId}-surfaces.json.gz`;
    if (surfaceFiles.has(surfaceFileName)) {
      const surfacePath = join(inputDir, surfaceFileName);
      const surfaceStats = statSync(surfacePath);
      entry.surfaceSize = surfaceStats.size;
      entry.surfaceChecksum = computeChecksum(surfacePath);
      totalSize += surfaceStats.size;
    }

    manifest.regions[regionId] = entry;
    totalSize += stats.size;

    const surfaceInfo = entry.surfaceSize
      ? ` + ${(entry.surfaceSize / 1024).toFixed(1)} KB surfaces`
      : '';
    console.log(
      `  ${regionId}: ${(stats.size / 1024).toFixed(1)} KB${surfaceInfo} - ${regionNames[regionId] || 'Unknown'}`
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
