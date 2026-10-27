/**
 * roadFacts.mjs — the road facts a way's OSM tags carry for the corner model's car (Rods FEAT-175, 2026-10-29).
 *
 * PURPOSE: Parse `lanes`, `width` and `lane_markings` into the values road_ways stores, and derive `single_track`
 *   (a two-way road one car wide), so the app can cap the car's speed on narrow roads from the map, never from maxspeed.
 * RESPONSIBILITY: The parse rules only, one place (build-sqlite.ts inserts them; extract-single.ts keeps the raw tags,
 *   as it does for maxspeed). Every value is nullable: null = the map does not say, never "wide" or "two lanes".
 *   - lanes: OSM `lanes` is the total lane count, a whole number. Anything else ("2;3", "1.5", "") is null.
 *   - width: metres by default (OSM wiki Key:width); "3.5", "3.5 m", "3,5" (decimal comma), "12'", "12'6\"", "10 ft".
 *     Outside 0.5..50 m is a tagging error and null.
 *   - lane_markings: "yes" / "no" only.
 *   - single_track: only on a two-way way (not oneway=yes/-1, not a ring junction, not a motorway, whose oneway is
 *     implied): 1 when lanes = 1 or width < 4 m; 0 when lanes >= 2 or width >= 4 m (and neither says 1); else null.
 *     Any single-track evidence wins over two-lane evidence: the cap is the cautious side.
 * DEPENDENCIES: none. CONSUMERS: build-sqlite.ts. Test: roadFacts.test.mjs.
 */

/** A two-way road narrower than this is one car wide (FEAT-175 coordinator rule, 2026-10-29). */
export const SINGLE_TRACK_MAX_WIDTH_M = 4;

/** OSM `lanes` → whole lane count 1..20, else null. */
export function parseLanes(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 20 ? n : null;
}

/** OSM `width` → metres (2 decimals), else null. */
export function parseWidthM(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/(\d),(\d)/, '$1.$2');
  let m;
  let metres = null;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(m|metres|meters)?$/))) metres = Number(m[1]);
  else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(ft|feet)$/))) metres = Number(m[1]) * 0.3048;
  else if ((m = s.match(/^(\d+)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/))) metres = Number(m[1]) * 0.3048 + Number(m[2] ?? 0) * 0.0254;
  if (metres === null || !Number.isFinite(metres) || metres < 0.5 || metres > 50) return null;
  return Math.round(metres * 100) / 100;
}

/** OSM `lane_markings` → 'yes' | 'no', else null. */
export function parseLaneMarkings(raw) {
  return raw === 'yes' || raw === 'no' ? raw : null;
}

/** 1 / 0 / null — see the header. `oneway` and `junction` are the stored road_ways values. */
export function deriveSingleTrack({ lanes, widthM, oneway, junction, highway }) {
  const oneWay = oneway === 'yes' || oneway === '-1' || junction === 'roundabout' || junction === 'circular'
    || highway === 'motorway' || highway === 'motorway_link';
  if (oneWay) return null;
  if (lanes === 1 || (widthM !== null && widthM < SINGLE_TRACK_MAX_WIDTH_M)) return 1;
  if ((lanes !== null && lanes >= 2) || (widthM !== null && widthM >= SINGLE_TRACK_MAX_WIDTH_M)) return 0;
  return null;
}
