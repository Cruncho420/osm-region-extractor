/**
 * New road features (Rods FEAT-264 / FEAT-185 S9a): traffic lights, stop signs, give-way signs and
 * railway level crossings, each in its OWN table of the region pack.
 *
 * PURPOSE: turn the raw OSM nodes into rows the app can use without any further map work: which
 *   approach a stop / give-way sign applies to, whether it sits at an intersection or a roundabout
 *   entrance, which traffic-light nodes are one place, and which crossings are real road-over-rail.
 * RESPONSIBILITY: osmium passes (extractNewRoadFeatures) + the pure rules (buildNewRoadFeatures).
 * DEPENDENCIES: osmium-tool on PATH (tags-filter, getparents, getid, cat). No app code.
 * CONSUMERS: extract-single.ts (writes {region}-roadfeatures.json.gz), build-sqlite.ts (tables),
 *   newRoadFeatures.test.mjs. Reader contract: docs/NEW-ROAD-FEATURES-CONTRACT.md.
 *
 * Why its own tables and never a `type` inside traffic_calming: builds before 1.8.10 read an unknown
 * calming type as "speed bump" (see the toll_points comment in build-sqlite.ts). A table an old build
 * never SELECTs from is invisible to it.
 *
 * Rules and where they come from (Rods doc/specs/custom-routing):
 *   - only nodes on a car / motorcycle road (motorway..service, not track, footway, cycleway, path);
 *     R56 / FEAT-264 spec §2.
 *   - stop / give-way apply to ONE approach. Direction from `direction=forward|backward` (or a
 *     compass value, which is the way the sign FACES); else, per R69, from geometry where the sign's
 *     road is clearly the minor one at a junction within 30 m; else the row is not written.
 *   - at_intersection: a junction of >= 3 car-road arms within 30 m ahead, service roads and ring
 *     nodes excluded. roundabout_entrance: a ring (or mini roundabout) within 25 m ahead (R104).
 *   - traffic lights: signal nodes within 60 m of EACH OTHER at the same layer are one place
 *     (spec §11.2; complete linkage, so a street of lights 50 m apart never chains into one).
 *   - railway: `railway=level_crossing` on a car road; a crossing of a tram line is excluded.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

export const NEW_ROAD_FEATURES_VERSION = 1;

/** Car / motorcycle road classes (the extract's road_ways set minus `track`, spec §2). */
export const CAR_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'road',
]);

/** Same road set as the pack's road_ways (streamConvertWays drops driveways and parking aisles):
 *  a feature is kept only on a road the app itself knows. Lithuania 2026-11-23: 333 level-crossing
 *  nodes sit on driveways (siding service roads), which no route the app builds drives. */
export function isCarRoad(tags) {
  if (!CAR_HIGHWAYS.has(tags.highway)) return false;
  return !(tags.highway === 'service' && (tags.service === 'driveway' || tags.service === 'parking_aisle'));
}

/** Road rank for "clearly the minor road" (R69). Links rank as their road. */
const RANK = {
  motorway: 9, motorway_link: 9, trunk: 8, trunk_link: 8, primary: 7, primary_link: 7,
  secondary: 6, secondary_link: 6, tertiary: 5, tertiary_link: 5, unclassified: 4,
  residential: 3, road: 3, living_street: 2, service: 1,
};

export const INTERSECTION_AHEAD_M = 30;
export const R69_JUNCTION_M = 30;
export const ROUNDABOUT_AHEAD_M = 25;
export const LIGHT_MERGE_M = 60;
/** A light member's "position before the junction" search (spec §11.2 uses the same 60 m). */
export const LIGHT_JUNCTION_SEARCH_M = 60;
/** Compass-tagged sign: the arm it applies to must be within this of the tag. */
const COMPASS_TOLERANCE_DEG = 45;
const CARDINAL = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180,
  SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing a -> b, degrees clockwise from true north, [0, 360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const round1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------------------------
// OPL (osmium's line format, add_metadata=false)
// ---------------------------------------------------------------------------------------------

function decodeOpl(s) {
  return s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Parse one OPL line into { kind, id, tags, lat?, lon?, refs? } or null. */
export function parseOplLine(line) {
  if (!line) return null;
  const parts = line.split(' ');
  const kind = parts[0][0];
  const id = Number(parts[0].slice(1));
  const obj = { kind, id, tags: {} };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const c = p[0];
    const v = p.slice(1);
    if (c === 'T' && v) {
      for (const kv of v.split(',')) {
        const eq = kv.indexOf('=');
        if (eq > 0) obj.tags[decodeOpl(kv.slice(0, eq))] = decodeOpl(kv.slice(eq + 1));
      }
    } else if (c === 'x' && v) obj.lon = Number(v);
    else if (c === 'y' && v) obj.lat = Number(v);
    else if (c === 'N' && v) obj.refs = v.split(',').map((r) => Number(r.slice(1)));
  }
  return obj;
}

function readOpl(path, onObj) {
  const text = readFileSync(path, 'utf-8');
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const o = parseOplLine(text.slice(start, end));
    if (o) onObj(o);
    start = end + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

function featureKind(tags) {
  if (tags.highway === 'traffic_signals' || tags.crossing === 'traffic_signals') return 'light';
  if (tags.highway === 'stop') return 'stop';
  if (tags.highway === 'give_way') return 'give_way';
  if (tags.railway === 'level_crossing') return 'rail';
  return null;
}

function wayLayer(tags) {
  const l = parseInt(tags.layer ?? '', 10);
  if (Number.isFinite(l)) return l;
  if (tags.bridge && tags.bridge !== 'no') return 1;
  if (tags.tunnel && tags.tunnel !== 'no') return -1;
  return 0;
}

/** 'yes' = forward only, '-1' = backward only, null = both ways. */
function onewayOf(tags) {
  const o = tags.oneway;
  if (o === 'yes' || o === '1' || o === 'true') return 'yes';
  if (o === '-1' || o === 'reverse') return '-1';
  if (o === 'no') return null;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 'yes';
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 'yes';
  return null;
}

const isRing = (tags) => tags.junction === 'roundabout' || tags.junction === 'circular';

/**
 * @param {object} input
 * @param {Array<{id:number, lat:number, lon:number, tags:object}>} input.featureNodes
 *   every node carrying one of the four tags (any road or none)
 * @param {Map<number,{tags:object, refs:number[]}>} input.ways   car-road ways touching those
 *   nodes or their ways' nodes (osmium getparents, two levels)
 * @param {Map<number,{lat:number, lon:number, tags:object}>} input.nodes   coordinates (and tags)
 *   of every node of the ways that hold a feature
 * @param {Set<number>} input.tramNodeIds   nodes of railway=tram ways
 */
export function buildNewRoadFeatures({ featureNodes, ways, nodes, tramNodeIds }) {
  // node -> [{wayId, idx}] over car ways (track excluded by CAR_HIGHWAYS)
  const memberOf = new Map();
  for (const [wid, w] of ways) {
    if (!isCarRoad(w.tags)) continue;
    w.refs.forEach((nid, idx) => {
      let a = memberOf.get(nid);
      if (!a) memberOf.set(nid, (a = []));
      a.push({ wayId: wid, idx });
    });
  }

  /** Car-road arms meeting at a node: [{wayId, idx, dir}] where dir is the way-order step that
   *  LEAVES the node along that arm (+1 / -1). Arriving along an arm = travelling -dir. */
  function arms(nid, { skipService = false } = {}) {
    const out = [];
    for (const m of memberOf.get(nid) ?? []) {
      const w = ways.get(m.wayId);
      if (skipService && w.tags.highway === 'service') continue;
      const n = w.refs.length;
      const closed = n > 2 && w.refs[0] === w.refs[n - 1];
      if (m.idx < n - 1 || closed) out.push({ wayId: m.wayId, idx: m.idx, dir: +1 });
      if (m.idx > 0 || closed) out.push({ wayId: m.wayId, idx: m.idx, dir: -1 });
    }
    // a closed way lists its first node twice (idx 0 and n-1): drop exact duplicates
    const seen = new Set();
    return out.filter((a) => {
      const k = `${a.wayId}:${a.dir}:${ways.get(a.wayId).refs[a.idx + a.dir] ?? 'x'}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const onRing = (nid) => (memberOf.get(nid) ?? []).some((m) => isRing(ways.get(m.wayId).tags));
  const isJunction = (nid, opts) => arms(nid, opts).length >= 3;

  /** Walk a way from idx in step dir (+1/-1) up to maxM metres; yields {nid, distM}. */
  function* walk(wayId, idx, dir, maxM) {
    const refs = ways.get(wayId).refs;
    let d = 0;
    let prev = nodes.get(refs[idx]);
    yield { nid: refs[idx], distM: 0 };
    for (let i = idx + dir; i >= 0 && i < refs.length; i += dir) {
      const cur = nodes.get(refs[i]);
      if (!prev || !cur) return;
      d += haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
      if (d > maxM) return;
      yield { nid: refs[i], distM: d };
      prev = cur;
    }
  }

  /** Bearing of travel ARRIVING at refs[idx] while moving in way-order step dir. */
  function travelBearing(wayId, idx, dir) {
    const refs = ways.get(wayId).refs;
    const here = nodes.get(refs[idx]);
    const before = nodes.get(refs[idx - dir]);
    if (before && here) return bearingDeg(before.lat, before.lon, here.lat, here.lon);
    const after = nodes.get(refs[idx + dir]);
    if (here && after) return bearingDeg(here.lat, here.lon, after.lat, after.lon);
    return null;
  }

  function nearestJunctionAhead(wayId, idx, dir, maxM, opts) {
    for (const s of walk(wayId, idx, dir, maxM)) {
      if (isJunction(s.nid, opts) && !(opts?.skipRing && onRing(s.nid))) return s;
    }
    return null;
  }

  /** Context of a sign approached along (wayId, idx) in travel step dir. */
  function approachContext(wayId, idx, dir) {
    let atIntersection = false;
    for (const s of walk(wayId, idx, dir, INTERSECTION_AHEAD_M)) {
      if (!onRing(s.nid) && isJunction(s.nid, { skipService: true })) { atIntersection = true; break; }
    }
    let roundabout = false;
    for (const s of walk(wayId, idx, dir, ROUNDABOUT_AHEAD_M)) {
      if (onRing(s.nid) || nodes.get(s.nid)?.tags?.highway === 'mini_roundabout') { roundabout = true; break; }
    }
    return { atIntersection, roundabout };
  }

  const stats = {
    light: { nodes: 0, onRoad: 0, offRoad: 0, duplicates: 0, members: 0, places60: 0, places40: 0,
      withJunctionNode: 0, dirTag: 0, dirPosition: 0, dirOneway: 0, dirUnknown: 0 },
    stop: { nodes: 0, onRoad: 0, offRoad: 0, duplicates: 0, rows: 0, nodesWritten: 0, dirTag: 0,
      dirGeometry: 0, dirOneway: 0, dirAllWay: 0, notWritten: 0, atIntersection: 0, roundaboutEntrance: 0 },
    give_way: { nodes: 0, onRoad: 0, offRoad: 0, duplicates: 0, rows: 0, nodesWritten: 0, dirTag: 0,
      dirGeometry: 0, dirOneway: 0, dirAllWay: 0, notWritten: 0, atIntersection: 0, roundaboutEntrance: 0 },
    rail: { nodes: 0, onRoad: 0, offRoad: 0, duplicates: 0, tramExcluded: 0, rows: 0 },
  };

  const byKind = { light: [], stop: [], give_way: [], rail: [] };
  for (const f of featureNodes) {
    const k = featureKind(f.tags);
    if (!k) continue;
    stats[k].nodes++;
    if (!(memberOf.get(f.id)?.length)) { stats[k].offRoad++; continue; }
    stats[k].onRoad++;
    byKind[k].push(f);
  }
  for (const k of Object.keys(byKind)) stats[k].duplicates = countNearDuplicates(byKind[k], 2);

  // ---- stop / give-way --------------------------------------------------------------------
  const signRows = { stop: [], give_way: [] };
  for (const k of ['stop', 'give_way']) {
    for (const f of byKind[k]) {
      const rows = resolveSign(f, k === 'stop' && f.tags.stop === 'all');
      if (!rows.length) { stats[k].notWritten++; continue; }
      stats[k].nodesWritten++;
      const src = rows[0].direction_source;
      stats[k][{ tag: 'dirTag', geometry: 'dirGeometry', oneway: 'dirOneway', all_way: 'dirAllWay' }[src]]++;
      for (const r of rows) {
        stats[k].rows++;
        if (r.at_intersection) stats[k].atIntersection++;
        if (r.roundabout_entrance) stats[k].roundaboutEntrance++;
        signRows[k].push(r);
      }
    }
  }

  function signRow(f, wayId, idx, dir, source) {
    const b = travelBearing(wayId, idx, dir);
    if (b === null) return null;
    const ctx = approachContext(wayId, idx, dir);
    return {
      node_id: f.id, lat: f.lat, lon: f.lon, way_id: wayId,
      approach_bearing_deg: round1(b), direction_source: source,
      at_intersection: ctx.atIntersection ? 1 : 0, roundabout_entrance: ctx.roundabout ? 1 : 0,
    };
  }

  function resolveSign(f, allWay) {
    const mem = memberOf.get(f.id);
    const dirTag = (f.tags.direction ?? '').trim();
    const single = mem.length === 1 ? mem[0] : null;
    // 1. forward / backward against the one way the node is on
    if ((dirTag === 'forward' || dirTag === 'backward') && single) {
      const r = signRow(f, single.wayId, single.idx, dirTag === 'forward' ? +1 : -1, 'tag');
      return r ? [r] : [];
    }
    // 2. compass value = the way the sign FACES; travel is the opposite
    const deg = /^\d+(\.\d+)?$/.test(dirTag) ? Number(dirTag) : CARDINAL[dirTag.toUpperCase()];
    if (deg !== undefined && Number.isFinite(deg)) {
      const travel = (deg + 180) % 360;
      let best = null;
      for (const a of arms(f.id)) {
        const b = travelBearing(a.wayId, a.idx, -a.dir); // arriving along this arm
        if (b !== null && angleDiff(b, travel) <= COMPASS_TOLERANCE_DEG && (!best || angleDiff(b, travel) < best.d)) {
          best = { a, d: angleDiff(b, travel) };
        }
      }
      if (best) { const r = signRow(f, best.a.wayId, best.a.idx, -best.a.dir, 'tag'); return r ? [r] : []; }
      return [];
    }
    // 3. the sign sits ON a junction node: the clearly minor arms (or every arm for all-way)
    const nodeArms = arms(f.id);
    if (nodeArms.length >= 3) {
      const rankOf = (a) => RANK[ways.get(a.wayId).tags.highway] ?? 0;
      const top = Math.max(...nodeArms.map(rankOf));
      const pick = allWay ? nodeArms : nodeArms.filter((a) => rankOf(a) < top);
      const rows = pick
        .filter((a) => !isOneWayAgainst(a.wayId, -a.dir))
        .map((a) => signRow(f, a.wayId, a.idx, -a.dir, allWay ? 'all_way' : 'geometry'))
        .filter(Boolean);
      return rows;
    }
    if (!single) return [];
    // 4. one-way road: the sign applies to the only direction of travel
    const ow = onewayOf(ways.get(single.wayId).tags);
    if (ow) {
      const r = signRow(f, single.wayId, single.idx, ow === 'yes' ? +1 : -1, 'oneway');
      return r ? [r] : [];
    }
    // 5. R69: toward the nearest junction within 30 m where this road is the minor one
    const own = RANK[ways.get(single.wayId).tags.highway] ?? 0;
    let best = null;
    for (const dir of [+1, -1]) {
      const j = nearestJunctionAhead(single.wayId, single.idx, dir, R69_JUNCTION_M);
      if (!j) continue;
      const others = (memberOf.get(j.nid) ?? []).filter((m) => m.wayId !== single.wayId);
      const minor = others.some((m) => (RANK[ways.get(m.wayId).tags.highway] ?? 0) > own);
      if ((minor || allWay) && (!best || j.distM < best.distM)) best = { dir, distM: j.distM };
    }
    if (!best) return [];
    const r = signRow(f, single.wayId, single.idx, best.dir, allWay ? 'all_way' : 'geometry');
    return r ? [r] : [];
  }

  function isOneWayAgainst(wayId, travelDir) {
    const ow = onewayOf(ways.get(wayId).tags);
    return (ow === 'yes' && travelDir === -1) || (ow === '-1' && travelDir === +1);
  }

  // ---- traffic lights ---------------------------------------------------------------------
  const lightInfo = byKind.light.map((f) => {
    const mem = memberOf.get(f.id);
    const w0 = ways.get(mem[0].wayId);
    return { f, mem, layer: wayLayer(w0.tags), junctionNode: isJunction(f.id) };
  });
  const groups60 = completeLinkage(lightInfo, LIGHT_MERGE_M);
  stats.light.places60 = groups60.length;
  stats.light.places40 = completeLinkage(lightInfo, 40).length;
  const lightRows = [];
  for (const g of groups60) {
    const members = g.map((i) => lightInfo[i]);
    const cLat = members.reduce((s, m) => s + m.f.lat, 0) / members.length;
    const cLon = members.reduce((s, m) => s + m.f.lon, 0) / members.length;
    const junctionId = Math.min(...members.map((m) => m.f.id));
    if (members.some((m) => m.junctionNode)) stats.light.withJunctionNode++;
    for (const m of members) {
      stats.light.members++;
      const d = lightDirection(m);
      stats.light[{ tag: 'dirTag', position: 'dirPosition', oneway: 'dirOneway' }[d.source] ?? 'dirUnknown']++;
      lightRows.push({
        node_id: m.f.id, lat: m.f.lat, lon: m.f.lon, junction_id: junctionId,
        centre_lat: round7(cLat), centre_lon: round7(cLon), junction_node: m.junctionNode ? 1 : 0,
        way_id: m.mem[0].wayId, approach_bearing_deg: d.bearing, direction_source: d.source,
        layer: m.layer,
        kind: m.f.tags.highway === 'traffic_signals' ? (m.f.tags.traffic_signals ?? null) : 'crossing',
      });
    }
  }

  function lightDirection(m) {
    const none = { bearing: null, source: null };
    if (m.junctionNode) return none; // applies to every approach
    const single = m.mem.length === 1 ? m.mem[0] : null;
    if (!single) return none;
    const t = m.f.tags['traffic_signals:direction'] ?? m.f.tags.direction;
    if (t === 'forward' || t === 'backward') {
      const b = travelBearing(single.wayId, single.idx, t === 'forward' ? +1 : -1);
      return b === null ? none : { bearing: round1(b), source: 'tag' };
    }
    const ow = onewayOf(ways.get(single.wayId).tags);
    // position: the member sits before a junction on one side only (the other side's junction,
    // if any, is more than twice as far)
    const jf = nearestJunctionAhead(single.wayId, single.idx, +1, LIGHT_JUNCTION_SEARCH_M);
    const jb = nearestJunctionAhead(single.wayId, single.idx, -1, LIGHT_JUNCTION_SEARCH_M);
    let dir = null;
    if (jf && (!jb || jb.distM > 2 * jf.distM)) dir = +1;
    else if (jb && (!jf || jf.distM > 2 * jb.distM)) dir = -1;
    if (dir !== null && !(ow && isOneWayAgainst(single.wayId, dir))) {
      const b = travelBearing(single.wayId, single.idx, dir);
      if (b !== null) return { bearing: round1(b), source: 'position' };
    }
    if (ow) {
      const b = travelBearing(single.wayId, single.idx, ow === 'yes' ? +1 : -1);
      if (b !== null) return { bearing: round1(b), source: 'oneway' };
    }
    return none;
  }

  // ---- railway crossings ------------------------------------------------------------------
  const railRows = [];
  for (const f of byKind.rail) {
    if (tramNodeIds.has(f.id)) { stats.rail.tramExcluded++; continue; }
    stats.rail.rows++;
    railRows.push({
      node_id: f.id, lat: f.lat, lon: f.lon, way_id: memberOf.get(f.id)[0].wayId,
      barrier: f.tags['crossing:barrier'] ?? null, light: f.tags['crossing:light'] ?? null,
    });
  }

  return {
    newRoadFeaturesVersion: NEW_ROAD_FEATURES_VERSION,
    trafficLights: lightRows,
    stopSigns: signRows.stop,
    giveWaySigns: signRows.give_way,
    railwayCrossings: railRows,
    stats,
  };
}

const round7 = (x) => Math.round(x * 1e7) / 1e7;

/** Pairs of same-kind nodes within maxM metres (data-fault count). Grid hashed. */
function countNearDuplicates(list, maxM) {
  const cell = (x) => Math.floor(x * 10000); // ~11 m cells
  const grid = new Map();
  let pairs = 0;
  for (const f of list) {
    const cy = cell(f.lat), cx = cell(f.lon);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const g of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
        if (haversineM(f.lat, f.lon, g.lat, g.lon) <= maxM) pairs++;
      }
    }
    const k = `${cy}:${cx}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(f);
  }
  return pairs;
}

/**
 * Greedy complete linkage: every pair inside a group is within maxM and at the same layer.
 * Seeds in node-id order (deterministic); candidates nearest-first. Grid hashed, so it stays
 * linear on a country's worth of signals.
 * ponytail: greedy, not optimal clustering; a 4-node junction never splits in practice because
 * its members are all within ~50 m of each other.
 */
function completeLinkage(info, maxM) {
  const cellDeg = maxM / 111000;
  const key = (lat, lon) => `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
  const grid = new Map();
  info.forEach((m, i) => {
    const k = key(m.f.lat, m.f.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const order = info.map((_, i) => i).sort((a, b) => info[a].f.id - info[b].f.id);
  const used = new Uint8Array(info.length);
  const groups = [];
  for (const s of order) {
    if (used[s]) continue;
    used[s] = 1;
    const g = [s];
    const seed = info[s];
    const cy = Math.floor(seed.f.lat / cellDeg), cx = Math.floor(seed.f.lon / cellDeg);
    const cand = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
      for (const j of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
        if (used[j] || info[j].layer !== seed.layer) continue;
        const d = haversineM(seed.f.lat, seed.f.lon, info[j].f.lat, info[j].f.lon);
        if (d <= maxM) cand.push({ j, d });
      }
    }
    cand.sort((a, b) => a.d - b.d || info[a.j].f.id - info[b.j].f.id);
    for (const { j } of cand) {
      if (used[j]) continue;
      const ok = g.every((i) => haversineM(info[i].f.lat, info[i].f.lon, info[j].f.lat, info[j].f.lon) <= maxM);
      if (ok) { used[j] = 1; g.push(j); }
    }
    groups.push(g);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// osmium passes
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.sourcePbf  the region's full PBF (feature nodes + tram ways)
 * @param {string} o.roadPbf    the extract's car-road filter output (ways + their nodes)
 * @param {string} o.tmpPrefix  path prefix for temporary files (all removed before return)
 */
export function extractNewRoadFeatures({ sourcePbf, roadPbf, tmpPrefix, osmium = 'osmium' }) {
  const f = (s) => `${tmpPrefix}-nrf-${s}`;
  const tmp = [f('feat.pbf'), f('feat.opl'), f('ids1.txt'), f('p1.opl'), f('ids2.txt'), f('p2.opl'), f('nodes.opl')];
  const run = (args) => execFileSync(osmium, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const opl = 'opl,add_metadata=false';
  try {
    run(['tags-filter', sourcePbf, 'n/highway=traffic_signals,stop,give_way', 'n/crossing=traffic_signals',
      'n/railway=level_crossing', 'w/railway=tram', '-o', f('feat.pbf'), '--overwrite']);
    run(['cat', f('feat.pbf'), '-f', opl, '-o', f('feat.opl'), '--overwrite']);
    const featureNodes = [];
    const tramNodeIds = new Set();
    readOpl(f('feat.opl'), (o) => {
      if (o.kind === 'n' && featureKind(o.tags)) featureNodes.push(o);
      else if (o.kind === 'w' && o.tags.railway === 'tram') for (const r of o.refs ?? []) tramNodeIds.add(r);
    });

    writeFileSync(f('ids1.txt'), featureNodes.map((n) => `n${n.id}`).join('\n') + '\n');
    run(['getparents', roadPbf, '-i', f('ids1.txt'), '-f', opl, '-o', f('p1.opl'), '--overwrite']);
    const wayNodeIds = new Set();
    readOpl(f('p1.opl'), (o) => { if (o.kind === 'w') for (const r of o.refs ?? []) wayNodeIds.add(r); });

    writeFileSync(f('ids2.txt'), [...wayNodeIds].map((id) => `n${id}`).join('\n') + '\n');
    run(['getparents', roadPbf, '-i', f('ids2.txt'), '-f', opl, '-o', f('p2.opl'), '--overwrite']);
    run(['getid', roadPbf, '-i', f('ids2.txt'), '-f', opl, '-o', f('nodes.opl'), '--overwrite']);
    const ways = new Map();
    readOpl(f('p2.opl'), (o) => { if (o.kind === 'w') ways.set(o.id, { tags: o.tags, refs: o.refs ?? [] }); });
    const nodes = new Map();
    readOpl(f('nodes.opl'), (o) => { if (o.kind === 'n') nodes.set(o.id, { lat: o.lat, lon: o.lon, tags: o.tags }); });

    return buildNewRoadFeatures({ featureNodes, ways, nodes, tramNodeIds });
  } finally {
    for (const p of tmp) if (existsSync(p)) unlinkSync(p);
  }
}
