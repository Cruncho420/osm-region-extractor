#!/usr/bin/env node
/**
 * Generate Regions Script
 *
 * PURPOSE: Generate regions.json for the app from the extraction regions.json
 * RESPONSIBILITY: Create a lightweight regions file with just bounding boxes for app bundling
 * DEPENDENCIES: regions.json (extraction config)
 * CONSUMERS: assets/osm-data/regions.json
 *
 * Usage: npm run generate-regions
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// =============================================================================
// TYPES
// =============================================================================

interface ExtractionRegion {
  id: string;
  name: string;
  continent: string;
  bbox: [number, number, number, number];
  geofabrikPath: string;
  estimatedSize: number;
}

interface ExtractionRegionsFile {
  regions: ExtractionRegion[];
}

interface AppRegion {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  estimatedSize: number;
}

interface AppRegionsFile {
  version: string;
  generatedAt: string;
  regions: AppRegion[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// MAIN
// =============================================================================

function generateAppRegions(): void {
  console.log(`\n========================================`);
  console.log(`Generating App Regions File`);
  console.log(`========================================\n`);

  const inputPath = join(__dirname, 'regions.json');
  const outputPath = join(__dirname, '..', '..', 'assets', 'osm-data', 'regions.json');

  const extractionRegions: ExtractionRegionsFile = JSON.parse(
    readFileSync(inputPath, 'utf-8')
  );

  const appRegions: AppRegionsFile = {
    version: new Date().toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    regions: extractionRegions.regions.map((r) => ({
      id: r.id,
      name: r.name,
      bbox: r.bbox,
      estimatedSize: r.estimatedSize,
    })),
  };

  writeFileSync(outputPath, JSON.stringify(appRegions, null, 2));

  const inputSize = (readFileSync(inputPath).length / 1024).toFixed(1);
  const outputSize = (readFileSync(outputPath).length / 1024).toFixed(1);

  console.log(`Input: ${inputPath} (${inputSize} KB)`);
  console.log(`Output: ${outputPath} (${outputSize} KB)`);
  console.log(`Regions: ${appRegions.regions.length}`);
  console.log(`\n✓ App regions file generated\n`);
}

generateAppRegions();
