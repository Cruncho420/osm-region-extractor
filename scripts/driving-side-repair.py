#!/usr/bin/env python3
"""
PURPOSE: Give Valhalla's admins.sqlite a correct country row (and so a correct drive_on_right) for
  every country a graph build touches, from REAL country outlines, and prove every country row
  matches scripts/country-driving-side.json before tiles are built.
RESPONSIBILITY: Two pure steps, SQL out / verdict out; the caller applies the SQL with spatialite.
  plan   - countries of the build with NO country row get one: the Natural Earth 1:10m admin-0
           outline (ISO_A2_EH), buffered ~2 km so no node near a border falls between two rows
           and silently defaults to left-hand.
  check  - every admin_level=2 row must have an ISO in the table: a wrong side is corrected (Valhalla
           resolves the side by NAME and gets some wrong, e.g. Brunei), an unknown ISO is an error
           (never a guess), a row with no ISO is reported.
DEPENDENCIES: Python 3 standard library only.
CONSUMERS: .github/workflows/valhalla-tiles.yml, region-slices-pilot.yml, scripts/build-release-graph.sh.

Why not the old padded bbox: it stood in for a missing country polygon on the premise that the
extract only holds this country's roads. Geofabrik extracts carry a buffer of the NEIGHBOUR's roads,
and a padded rectangle then gave those nodes this country's driving side (e.g. Shenzhen inside the
hong-kong extract as left-hand). In a multi-country build (one Europe or planet graph) the premise
fails outright: GB's padded box covers most of Ireland.
"""
import argparse
import json
import sys

BUFFER_DEGREES = 0.02  # ~2 km: covers Natural Earth 1:10m border error against OSM's own rows.


def load_table(path):
    """ISO -> (name, driveOnRight) from the verified per-region table (members share one side)."""
    table = {}
    with open(path) as handle:
        data = json.load(handle)
    for key, entry in data.items():
        if key.startswith('_'):
            continue
        for iso in entry.get('members') or [entry['iso']]:
            side = bool(entry['driveOnRight'])
            if iso in table and table[iso][1] != side:
                raise ValueError(f'{iso} has two driving sides in the table')
            table[iso] = (entry['name'] if iso == entry['iso'] else iso, side)
    return table


def parse_rows(text):
    """spatialite 'iso|dor' lines -> [(iso or None, dor)]"""
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        iso, _, dor = line.rpartition('|')
        rows.append((iso or None, int(dor)))
    return rows


def ring_wkt(ring):
    return '(' + ', '.join(f'{x:.6f} {y:.6f}' for x, y in ring) + ')'


def geometry_wkt(geometry):
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    return 'MULTIPOLYGON(' + ', '.join('(' + ', '.join(ring_wkt(r) for r in p) + ')' for p in polygons) + ')'


def part_boxes(geometry):
    """One box per polygon part: a country's overall box can span the globe (US via the Aleutians)."""
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    boxes = []
    for polygon in polygons:
        xs = [x for x, _ in polygon[0]]
        ys = [y for _, y in polygon[0]]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    return boxes


def outlines(ne_path):
    """ISO_A2_EH -> one MultiPolygon of EVERY feature with that code (ISO_A2 is -99 for France and
    Norway in Natural Earth 5.x; and one code can have several features - FR is both France and
    Clipperton Island, so keeping only the last one silently dropped metropolitan France)."""
    parts = {}
    with open(ne_path) as handle:
        features = json.load(handle)['features']
    for feature in features:
        iso = feature['properties'].get('ISO_A2_EH') or feature['properties'].get('ISO_A2')
        geometry = feature.get('geometry')
        if not iso or iso == '-99' or not geometry:
            continue
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        parts.setdefault(iso, []).extend(polygons)
    return {iso: {'type': 'MultiPolygon', 'coordinates': polygons} for iso, polygons in parts.items()}


def plan(rows, table, ne, bbox, required):
    """SQL inserting a buffered Natural Earth row for each table country in `bbox` that has none.

    `required` ISOs (the build's own countries) must end with a row, or this raises."""
    have = {iso for iso, _ in rows if iso}
    x0, y0, x1, y1 = bbox
    sql, added = [], []
    for iso, geometry in sorted(ne.items()):
        if iso in have or iso not in table:
            continue
        if not any(c >= x0 and a <= x1 and d >= y0 and b <= y1 for a, b, c, d in part_boxes(geometry)):
            continue
        name, side = table[iso]
        name = name.replace("'", "''")
        sql.append(
            "INSERT INTO admins (admin_level, iso_code, parent_admin, name, name_en, drive_on_right, "
            "allow_intersection_names, default_language, supported_languages, geom) VALUES "
            f"(2, '{iso}', NULL, '{name}', '{name}', {1 if side else 0}, 0, NULL, NULL, "
            f"CastToMultiPolygon(ST_Buffer(GeomFromText('{geometry_wkt(geometry)}', 4326), {BUFFER_DEGREES})));")
        added.append(iso)
    missing = [iso for iso in required if iso not in have and iso not in added]
    if missing:
        raise ValueError(f'no row and no Natural Earth outline for {missing}')
    return sql, added


def check(rows, table):
    """(UPDATE statements for wrong sides, unknown ISOs, count of rows without ISO)."""
    fixes, unknown, anonymous = [], set(), 0
    for iso, dor in rows:
        if iso is None:
            anonymous += 1
        elif iso not in table:
            unknown.add(iso)
        elif bool(dor) != table[iso][1]:
            fixes.append(f"UPDATE admins SET drive_on_right={1 if table[iso][1] else 0} "
                         f"WHERE admin_level=2 AND iso_code='{iso}';")
    return sorted(set(fixes)), sorted(unknown), anonymous


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['plan', 'check'])
    parser.add_argument('--rows', required=True, help="file of spatialite 'iso|drive_on_right' lines")
    parser.add_argument('--table', required=True)
    parser.add_argument('--ne', help='Natural Earth 10m admin-0 countries GeoJSON (plan)')
    parser.add_argument('--bbox', help='minLon,minLat,maxLon,maxLat of the build input (plan)')
    parser.add_argument('--require', default='', help='comma ISOs that must end with a row (plan)')
    args = parser.parse_args()
    table = load_table(args.table)
    with open(args.rows) as handle:
        rows = parse_rows(handle.read())
    if args.mode == 'plan':
        bbox = [float(v) for v in args.bbox.split(',')]
        sql, added = plan(rows, table, outlines(args.ne), bbox, [i for i in args.require.split(',') if i])
        if sql:
            print('\n'.join(sql))
        print(f'driving-side plan: added Natural Earth rows for {added or "none"}', file=sys.stderr)
        return 0
    fixes, unknown, anonymous = check(rows, table)
    if fixes:
        print('\n'.join(fixes))
    print(f'driving-side check: {len(rows)} country rows, {len(fixes)} corrected, {anonymous} without ISO',
          file=sys.stderr)
    if unknown:
        print(f'::error::country rows with no entry in country-driving-side.json: {unknown} '
              '- add a verified entry; a guessed side is never shipped', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
