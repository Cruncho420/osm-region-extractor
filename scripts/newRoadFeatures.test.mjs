// Run: node --test newRoadFeatures.test.mjs
// Part 1: the whole osmium pipeline on a REAL fixture (six small Vilnius boxes, fixtures/). Skipped
// where osmium is missing; CI's scripts-tests.yml installs osmium-tool, so it runs there.
// Part 2: the rules on hand-made graphs, for the cases the fixture cannot hold (trams, chaining).
// Part 3: build-sqlite.ts with and without the road-feature file (new pack / old pack shape).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { gzipSync } from 'zlib';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { extractNewRoadFeatures, buildNewRoadFeatures, parseOplLine, bearingDeg } from './newRoadFeatures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/new-road-features-vilnius.opl');
const hasOsmium = spawnSync('osmium', ['--version']).status === 0;

// The road filter of extract-single.ts step 6 (kept in step with it by hand).
const ROAD_FILTER = 'w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,' +
  'tertiary,tertiary_link,residential,unclassified,living_street,service,track,road';

let real;
function realRun() {
  if (real) return real;
  const dir = mkdtempSync(join(tmpdir(), 'nrf-'));
  try {
    const road = join(dir, 'road.osm.pbf');
    execFileSync('osmium', ['tags-filter', FIXTURE, ROAD_FILTER, '-o', road]);
    real = extractNewRoadFeatures({ sourcePbf: FIXTURE, roadPbf: road, tmpPrefix: join(dir, 'x') });
    return real;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real fixture: a junction mapped per approach is ONE place (Kalvarijų g. / Konstitucijos pr.)', { skip: !hasOsmium }, () => {
  const r = realRun();
  const jid = r.trafficLights.find((l) => l.node_id === 31440057)?.junction_id;
  assert.ok(jid, 'junction node 31440057 is kept');
  const members = r.trafficLights.filter((l) => l.junction_id === jid);
  assert.ok(members.length >= 8, `members ${members.length}`);
  assert.ok(members.some((m) => m.junction_node === 1));
  // every member of a place lies within 60 m of every other (complete linkage)
  for (const a of members) for (const b of members) {
    const d = 6371000 * Math.acos(Math.min(1, Math.sin(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((a.lon - b.lon) * Math.PI / 180)));
    assert.ok(d <= 60.001, `span ${d}`);
  }
});

test('real fixture: tagged stop sign gets the tagged approach and sees the junction ahead', { skip: !hasOsmium }, () => {
  const rows = realRun().stopSigns.filter((s) => s.node_id === 3828373740);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction_source, 'tag');
  assert.equal(rows[0].at_intersection, 1);
});

test('real fixture: undirected stop on a junction node -> only the minor road\'s approaches (R69)', { skip: !hasOsmium }, () => {
  const rows = realRun().stopSigns.filter((s) => s.node_id === 59966924);
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.equal(r.direction_source, 'geometry');
  // no two rows for the same approach
  assert.equal(new Set(rows.map((r) => r.approach_bearing_deg)).size, rows.length);
});

test('real fixture: give-way signs at a roundabout are marked as its entrance (R104)', { skip: !hasOsmium }, () => {
  const g = realRun().giveWaySigns;
  // Stoties g. / Geležinkelio g. (one-way approaches) and T. Narbuto g. / Konstitucijos pr. (tagged)
  for (const id of [7399790807, 7399790815, 1869043526, 14252551233]) {
    const row = g.find((x) => x.node_id === id);
    assert.ok(row, `give-way ${id} kept`);
    assert.equal(row.roundabout_entrance, 1);
  }
});

test('real fixture: a level crossing on a road keeps its barrier tag', { skip: !hasOsmium }, () => {
  const row = realRun().railwayCrossings.find((x) => x.node_id === 260640842);
  assert.ok(row);
  assert.equal(row.barrier, 'half');
});

// ---------------------------------------------------------------------------------------------
// Hand-made graphs. A street runs east along lat 54.0 with a node every ~33 m (0.0005 deg lon).
// ---------------------------------------------------------------------------------------------
const LAT = 54.0;
const lonAt = (i) => 25 + i * 0.0005;
function street(n, firstId, tags = { highway: 'residential' }) {
  return { tags, refs: Array.from({ length: n }, (_, i) => firstId + i) };
}
function nodesFor(ids, latOf = () => LAT, lonOf = (i) => lonAt(i)) {
  const m = new Map();
  ids.forEach((id, i) => m.set(id, { lat: latOf(i), lon: lonOf(i), tags: {} }));
  return m;
}

test('forward / backward stop signs face opposite approaches', () => {
  const ways = new Map([[1, street(6, 100)]]);
  const nodes = nodesFor([100, 101, 102, 103, 104, 105]);
  const featureNodes = [
    { id: 102, lat: LAT, lon: lonAt(2), tags: { highway: 'stop', direction: 'forward' } },
    { id: 103, lat: LAT, lon: lonAt(3), tags: { highway: 'stop', direction: 'backward' } },
  ];
  const r = buildNewRoadFeatures({ featureNodes, ways, nodes, tramNodeIds: new Set() });
  const f = r.stopSigns.find((s) => s.node_id === 102);
  const b = r.stopSigns.find((s) => s.node_id === 103);
  assert.ok(Math.abs(f.approach_bearing_deg - 90) < 1, `forward = eastbound, got ${f.approach_bearing_deg}`);
  assert.ok(Math.abs(b.approach_bearing_deg - 270) < 1, `backward = westbound, got ${b.approach_bearing_deg}`);
});

test('compass direction is the way the sign FACES: direction=W serves eastbound traffic', () => {
  const ways = new Map([[1, street(5, 100)]]);
  const nodes = nodesFor([100, 101, 102, 103, 104]);
  const featureNodes = [{ id: 102, lat: LAT, lon: lonAt(2), tags: { highway: 'give_way', direction: 'W' } }];
  const [row] = buildNewRoadFeatures({ featureNodes, ways, nodes, tramNodeIds: new Set() }).giveWaySigns;
  assert.ok(Math.abs(row.approach_bearing_deg - 90) < 1, `${row.approach_bearing_deg}`);
});

test('undirected sign: minor road at a junction within 30 m is resolved; equal roads are not written', () => {
  // residential 100..104 ends at 104, which a primary (200, 104, 201) crosses north-south
  const mk = (crossTags) => {
    const ways = new Map([[1, street(5, 100)], [2, { tags: crossTags, refs: [200, 104, 201] }]]);
    // nodes ~20 m apart here, so the sign at 103 is 20 m before the junction at 104 (inside 30 m)
    const lon20 = (i) => 25 + i * 0.0003;
    const nodes = nodesFor([100, 101, 102, 103, 104], () => LAT, lon20);
    nodes.set(200, { lat: LAT - 0.0005, lon: lon20(4), tags: {} });
    nodes.set(201, { lat: LAT + 0.0005, lon: lon20(4), tags: {} });
    const featureNodes = [{ id: 103, lat: LAT, lon: lon20(3), tags: { highway: 'stop' } }];
    return buildNewRoadFeatures({ featureNodes, ways, nodes, tramNodeIds: new Set() });
  };
  const minor = mk({ highway: 'primary' });
  assert.equal(minor.stopSigns.length, 1);
  assert.equal(minor.stopSigns[0].direction_source, 'geometry');
  assert.ok(Math.abs(minor.stopSigns[0].approach_bearing_deg - 90) < 1);
  assert.equal(minor.stopSigns[0].at_intersection, 1);
  const equal = mk({ highway: 'residential' });
  assert.equal(equal.stopSigns.length, 0);
  assert.equal(equal.stats.stop.notWritten, 1);
});

test('lights along a street never chain into one place wider than 60 m', () => {
  const ways = new Map([[1, street(12, 100, { highway: 'primary' })]]);
  const nodes = nodesFor(Array.from({ length: 12 }, (_, i) => 100 + i));
  // nodes are ~33 m apart: signals on every other node are ~66 m apart
  const street5 = [100, 102, 104, 106, 108].map((id) => ({ id, lat: LAT, lon: lonAt(id - 100), tags: { highway: 'traffic_signals' } }));
  const r = buildNewRoadFeatures({ featureNodes: street5, ways, nodes, tramNodeIds: new Set() });
  assert.equal(new Set(r.trafficLights.map((l) => l.junction_id)).size, 5, 'gaps of ~66 m stay apart');
  const pairs = [100, 101, 102, 103, 104].map((id) => ({ id, lat: LAT, lon: lonAt(id - 100), tags: { highway: 'traffic_signals' } }));
  const r2 = buildNewRoadFeatures({ featureNodes: pairs, ways, nodes, tramNodeIds: new Set() });
  // 5 nodes 33 m apart span 131 m: complete linkage at 60 m gives places of at most 2 nodes
  const sizes = Object.values(r2.trafficLights.reduce((a, l) => ((a[l.junction_id] = (a[l.junction_id] ?? 0) + 1), a), {}));
  assert.ok(Math.max(...sizes) <= 2, `sizes ${sizes}`);
});

test('a crossing on a tram line, a driveway or a footway is not a road feature', () => {
  const ways = new Map([
    [1, street(3, 100)],
    [2, { tags: { highway: 'service', service: 'driveway' }, refs: [300, 301, 302] }],
  ]);
  const nodes = nodesFor([100, 101, 102]);
  nodes.set(301, { lat: LAT + 0.001, lon: 25, tags: {} });
  const featureNodes = [
    { id: 101, lat: LAT, lon: lonAt(1), tags: { railway: 'level_crossing' } }, // tram
    { id: 102, lat: LAT, lon: lonAt(2), tags: { railway: 'level_crossing', 'crossing:barrier': 'full' } },
    { id: 301, lat: LAT + 0.001, lon: 25, tags: { railway: 'level_crossing' } }, // driveway only
    { id: 999, lat: LAT + 0.002, lon: 25, tags: { highway: 'traffic_signals' } }, // no car road
  ];
  const r = buildNewRoadFeatures({ featureNodes, ways, nodes, tramNodeIds: new Set([101]) });
  assert.deepEqual(r.railwayCrossings.map((x) => x.node_id), [102]);
  assert.equal(r.railwayCrossings[0].barrier, 'full');
  assert.equal(r.stats.rail.tramExcluded, 1);
  assert.equal(r.stats.rail.offRoad, 1);
  assert.equal(r.stats.light.offRoad, 1);
  assert.equal(r.trafficLights.length, 0);
});

test('OPL tags are decoded and bearings are compass degrees', () => {
  const o = parseOplLine('n42 Thighway=stop,name=A%20%B%2c%C x25.1 y54.2');
  assert.equal(o.id, 42);
  assert.equal(o.tags.name, 'A B,C');
  assert.equal(o.lon, 25.1);
  assert.ok(Math.abs(bearingDeg(54, 25, 54.001, 25) - 0) < 0.01);
  assert.ok(Math.abs(bearingDeg(54, 25, 54, 25.001) - 90) < 0.01);
});

// ---------------------------------------------------------------------------------------------
// build-sqlite.ts: new pack has the four tables + version key; without the file the pack keeps
// exactly the old table set and no key (what an old reader / the old-pack test expects).
// ---------------------------------------------------------------------------------------------
function buildPack(withRoadFeatures) {
  const dir = mkdtempSync(join(tmpdir(), 'nrf-pack-'));
  const core = { version: '2026-11-24', region: 'test-region', trafficCalming: [{ lat: 54, lon: 25, type: 'speed_bump' }], roundabouts: [] };
  writeFileSync(join(dir, 'test-region.json.gz'), gzipSync(JSON.stringify(core)));
  if (withRoadFeatures) {
    const rf = {
      version: '2026-11-24', region: 'test-region', newRoadFeaturesVersion: 1,
      trafficLights: [{ node_id: 1, lat: 54, lon: 25, junction_id: 1, centre_lat: 54, centre_lon: 25, junction_node: 1, way_id: 9, approach_bearing_deg: null, direction_source: null, layer: 0, kind: null }],
      stopSigns: [{ node_id: 2, lat: 54, lon: 25, way_id: 9, approach_bearing_deg: 90, direction_source: 'tag', at_intersection: 1, roundabout_entrance: 0 }],
      giveWaySigns: [], railwayCrossings: [{ node_id: 3, lat: 54, lon: 25, way_id: 9, barrier: null, light: 'yes' }],
    };
    writeFileSync(join(dir, 'test-region-roadfeatures.json.gz'), gzipSync(JSON.stringify(rf)));
  }
  execFileSync(join(here, 'node_modules/.bin/tsx'), [join(here, 'build-sqlite.ts'), '--region', 'test-region', '--output', dir], { stdio: 'ignore' });
  const db = join(dir, 'test-region.sqlite');
  execFileSync('sh', ['-c', `gzip -dc "${db}.gz" > "${db}"`]);
  return { dir, db };
}

test('build-sqlite: new pack carries the four tables and the version key; old shape otherwise', { skip: !existsSync(join(here, 'node_modules/.bin/tsx')) }, () => {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const tablesOf = (db) => db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map((r) => r.name);
  const neu = buildPack(true);
  const old = buildPack(false);
  try {
    const a = new Database(neu.db, { readonly: true });
    const b = new Database(old.db, { readonly: true });
    const newTables = ['give_way_signs', 'railway_crossings', 'stop_signs', 'traffic_lights'];
    assert.deepEqual(tablesOf(a).filter((t) => !tablesOf(b).includes(t)), newTables);
    assert.deepEqual(tablesOf(b).filter((t) => newTables.includes(t)), []);
    assert.equal(a.prepare("select value from metadata where key='newRoadFeaturesVersion'").get().value, '1');
    assert.equal(b.prepare("select value from metadata where key='newRoadFeaturesVersion'").get(), undefined);
    assert.equal(a.prepare("select value from metadata where key='rows:stop_signs'").get().value, '1');
    assert.equal(a.prepare('select approach_bearing_deg from stop_signs').get().approach_bearing_deg, 90);
    // the shared tables are untouched by the new pass
    assert.equal(a.prepare('select count(*) n from traffic_calming').get().n, 1);
    assert.equal(b.prepare('select count(*) n from traffic_calming').get().n, 1);
    a.close();
    b.close();
  } finally {
    rmSync(neu.dir, { recursive: true, force: true });
    rmSync(old.dir, { recursive: true, force: true });
  }
});
