/**
 * valhallaCoord.mjs — one rounding rule for every road coordinate Rods' corner model reads.
 *
 * PURPOSE: Write a road_ways node at exactly the 6 decimals our Valhalla router (phone engine and route.rodsmaps.com,
 *   Valhalla 3.6.3) gives the SAME OSM node, so a road walked from the packs (Free Roam) and the same road routed by
 *   Valhalla reach the corner model as byte-identical points. FEAT-175 source rounding, 2026-10-27.
 * RESPONSIBILITY: The rule only. Valhalla's tile builder stores a node as round((deg + off) * 1e7) (mjolnir OSMNode::set_latlng,
 *   off = 90 lat / 180 lon), reads it back as u * 1e-7 - off, and writes the edge shape at round(x * 1e6) (midgard::encode,
 *   std::round = half away from zero). A 7th digit of 5 therefore goes up or down by IEEE double noise, not by a decimal
 *   rule; only this exact arithmetic reproduces it. Measured on 100 roads: 101,727 of 101,727 Valhalla vertices that are
 *   OSM nodes equal this function of their node; a plain decimal rule matches about half of the 18,744 ties.
 *   Accuracy: each axis moves at most half a 6th-decimal step (0.056 m); the router's line already carries that rounding.
 * DEPENDENCIES: none. CONSUMERS: extract-single.ts streamConvertWays (road_ways coords). Test: valhallaCoord.test.mjs.
 */

/** C++ std::round: half away from zero. */
const roundHalfAway = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));

/** One axis: offset 90 for latitude, 180 for longitude. Idempotent on a 6-decimal value. */
export function valhallaDegree(deg, offset) {
  const fixed7 = Math.round((Math.round(deg * 1e7) / 1e7 + offset) * 1e7);
  return roundHalfAway((fixed7 * 1e-7 - offset) * 1e6) / 1e6;
}

export const valhallaLon = (lon) => valhallaDegree(lon, 180);
export const valhallaLat = (lat) => valhallaDegree(lat, 90);
