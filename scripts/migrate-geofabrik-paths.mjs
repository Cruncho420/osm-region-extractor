#!/usr/bin/env node
/**
 * migrate-geofabrik-paths.mjs — move every Geofabrik address in the region lists to the folder Geofabrik serves it
 * from, using Geofabrik's own index (https://download.geofabrik.de/index-v1-nogeom.json), never a guess per region.
 *
 * WHY: Geofabrik moved each extract into its own folder (europe/germany/baden-wuerttemberg/baden-wuerttemberg-latest
 * .osm.pbf); the old address of a part of a country now 404s (see check-geofabrik-paths.mjs). Only the download
 * addresses change: region ids, names and everything the app or the manifests read stay as they are.
 * Usage: node scripts/migrate-geofabrik-paths.mjs <index-v1-nogeom.json> [--write]
 * Prints every change and every address the index does not hold; --write rewrites regions.json, region-slices.json
 * and release-trial-packs.json in place (formatting kept: one value replaced per address).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://download.geofabrik.de/';

/** Geofabrik's index -> { old folder-less stem: new stem }, e.g. europe/germany/saarland -> europe/germany/saarland/saarland. */
export function stemMap(index) {
  const map = new Map();
  for (const f of index.features) {
    const url = f.properties?.urls?.pbf;
    if (typeof url !== 'string' || !url.startsWith(BASE)) continue;
    const stem = url.slice(BASE.length).replace(/-latest\.osm\.pbf$/, '');
    const m = stem.match(/^(.*)\/([^/]+)\/\2$/);
    map.set(m ? `${m[1]}/${m[2]}` : stem, stem);
    map.set(stem, stem);   // already moved: maps to itself
  }
  return map;
}

export function movePbfPath(path, map) {
  const stem = path.replace(/-latest\.osm\.pbf$/, '');
  const next = map.get(stem);
  return next === undefined ? null : `${next}-latest.osm.pbf`;
}

function main() {
  const [indexFile] = process.argv.slice(2);
  const write = process.argv.includes('--write');
  const map = stemMap(JSON.parse(readFileSync(indexFile, 'utf8')));
  let changed = 0;
  const missing = [];
  const files = {};
  const edit = (file, from, to) => {
    files[file] ??= readFileSync(join(HERE, file), 'utf8');
    const quoted = JSON.stringify(from);
    if (!files[file].includes(quoted)) throw new Error(`${file}: ${quoted} not found`);
    files[file] = files[file].split(quoted).join(JSON.stringify(to));
    changed += 1;
    console.log(`${file}: ${from} -> ${to}`);
  };
  for (const r of JSON.parse(readFileSync(join(HERE, 'regions.json'), 'utf8')).regions) {
    const next = movePbfPath(r.geofabrikPath, map);
    if (next === null) missing.push(`regions.json ${r.id}: ${r.geofabrikPath}`);
    else if (next !== r.geofabrikPath) edit('regions.json', r.geofabrikPath, next);
  }
  const polys = new Set();
  JSON.stringify(JSON.parse(readFileSync(join(HERE, 'region-slices.json'), 'utf8')), (k, v) => {
    if ((k === 'sources' || k === 'union') && Array.isArray(v)) v.forEach((p) => polys.add(p));
    if ((k === 'pbf' || k === 'within') && typeof v === 'string') polys.add(v);   // download stems too
    return v;
  });
  for (const p of polys) {
    if (p.startsWith('ne:')) continue;   // a Natural Earth outline, not a Geofabrik address
    const next = map.get(p);
    if (next === undefined) missing.push(`region-slices.json: ${p}`);
    else if (next !== p) edit('region-slices.json', p, next);
  }
  for (const t of JSON.parse(readFileSync(join(HERE, 'release-trial-packs.json'), 'utf8'))) {
    const stem = t.poly.slice(BASE.length).replace(/\.poly$/, '');
    const next = map.get(stem);
    if (next === undefined) missing.push(`release-trial-packs.json ${t.id}: ${t.poly}`);
    else if (next !== stem) edit('release-trial-packs.json', t.poly, `${BASE}${next}.poly`);
  }
  console.log(`${changed} addresses move; ${missing.length} not in Geofabrik's index`);
  for (const m of missing) console.log(`  not in index: ${m}`);
  if (write) for (const [file, text] of Object.entries(files)) writeFileSync(join(HERE, file), text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
