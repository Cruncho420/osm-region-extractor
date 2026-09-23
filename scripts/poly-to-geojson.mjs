/**
 * PURPOSE: turn a Geofabrik .poly extract boundary into a GeoJSON MultiPolygon.
 * RESPONSIBILITY: parsing only. `pmtiles extract --region` needs GeoJSON; Geofabrik
 *   publishes the exact boundary each regional PBF was cut with as .poly. Cutting the
 *   basemap with the SAME polygon as the road data keeps map and data coverage equal,
 *   and adjacent Geofabrik polygons overlap slightly, which is what lets two installed
 *   neighbouring regions draw without a seam (the app draws both where they overlap).
 * DEPENDENCIES: node stdlib.
 * CONSUMERS: .github/workflows/basemap-tiles.yml. Tested by poly-to-geojson.test.mjs.
 *
 * Format (osmosis polygon filter): line 1 = name; then sections, each a name line,
 * "lon lat" lines, "END"; a section name starting with "!" is a hole in the previous
 * outer ring; the file ends with a final "END".
 *
 * CLI: node poly-to-geojson.mjs in.poly out.geojson
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function polyToGeoJSON(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const polygons = [];
  let i = 1; // line 0 is the file name
  while (i < lines.length && lines[i] !== 'END') {
    const name = lines[i++];
    const ring = [];
    while (i < lines.length && lines[i] !== 'END') {
      const [x, y] = lines[i++].split(/\s+/).map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad coordinate line ${i}`);
      ring.push([x, y]);
    }
    if (i >= lines.length) throw new Error('unterminated section');
    i++; // section END
    if (ring.length < 3) throw new Error(`section ${name} has fewer than 3 points`);
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
    if (name.startsWith('!')) {
      if (polygons.length === 0) throw new Error('hole before any outer ring');
      polygons[polygons.length - 1].push(ring);
    } else {
      polygons.push([ring]);
    }
  }
  if (polygons.length === 0) throw new Error('no polygon in file');
  return { type: 'MultiPolygon', coordinates: polygons };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('usage: node poly-to-geojson.mjs in.poly out.geojson');
    process.exit(2);
  }
  const g = polyToGeoJSON(readFileSync(input, 'utf8'));
  writeFileSync(output, JSON.stringify(g));
  console.log(`${output}: ${g.coordinates.length} polygon(s)`);
}
