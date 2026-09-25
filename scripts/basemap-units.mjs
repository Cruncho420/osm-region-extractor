/**
 * PURPOSE: the list of map files one basemap release must carry (FEAT-090 L4, Tadas 2026-09-24:
 *   a region whose download is over 2 GB ships as pieces).
 * RESPONSIBILITY: regions.json minus every country in region-slices.json, plus every piece of
 *   those countries — each with the outline its map is clipped to and its max zoom. A split
 *   country NEVER gets a whole-country map file: its pieces replace it.
 * DEPENDENCIES: node stdlib.
 * CONSUMERS: .github/workflows/basemap-tiles.yml (get-regions, build, finalize). Tested by
 *   basemap-units.test.mjs.
 *
 * `poly` is either `stored:<id>` (scripts/polys/<id>.poly, the SAME outline the piece's road
 * data and routing pack are cut with) or a Geofabrik path whose .poly is downloaded.
 *
 * CLI: node basemap-units.mjs [regions.json] [region-slices.json]  → JSON array on stdout
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function basemapUnits(regionsDoc, slicesDoc) {
  const split = new Map(slicesDoc.countries.map((c) => [c.country, c]));
  const units = [];
  for (const r of regionsDoc.regions) {
    const country = split.get(r.id);
    if (!country) {
      units.push({ id: r.id, poly: r.geofabrikPath.replace(/-latest\.osm\.pbf$/, ''), maxZoom: null, country: null });
      continue;
    }
    for (const p of country.pieces) {
      units.push({
        id: p.id,
        poly: p.outline ? `stored:${p.id}` : p.sources[0],
        maxZoom: p.mapMaxZoom ?? null,
        country: country.country,
      });
    }
  }
  const unknown = [...split.keys()].filter((c) => !regionsDoc.regions.some((r) => r.id === c));
  if (unknown.length) throw new Error(`split countries missing from regions.json: ${unknown.join(', ')}`);
  const ids = units.map((u) => u.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate map unit id');
  return units;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [regions = 'scripts/regions.json', slices = 'scripts/region-slices.json'] = process.argv.slice(2);
  const units = basemapUnits(JSON.parse(readFileSync(regions, 'utf8')), JSON.parse(readFileSync(slices, 'utf8')));
  process.stdout.write(`${JSON.stringify(units)}\n`);
}
