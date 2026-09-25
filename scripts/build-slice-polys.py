#!/usr/bin/env python3
"""PURPOSE: Write the stored outline (.poly) of EVERY region-slice piece.
RESPONSIBILITY: Union / intersect / subtract Geofabrik .poly files exactly as
scripts/region-slices.json describes, then REPARTITION the country: each piece keeps only its own
land, and everything else (sea, the extract's buffer into neighbouring countries, overlaps between
neighbouring Geofabrik outlines, land slivers) goes to the piece whose land is nearest. Written in
Geofabrik .poly format.
DEPENDENCIES: shapely >= 2.1 (local use only; CI reads the committed .poly files and never runs
this); Natural Earth 1:10m admin-0 ($NE_ADMIN0) and admin-1 ($NE_ADMIN1), v5.1.2.
CONSUMERS: scripts/polys/*.poly, read by basemap-tiles.yml (map files), routing-pieces-release.yml
and region-slices-pilot.yml (routing, coverage, road data), and the Rods app's region-pieces.json.

WHY THE REPARTITION (FEAT-090 border review 2026-09-25): Geofabrik outlines reach far out to sea,
so "country minus the first piece" handed the second piece the first piece's whole coastline:
Blackpool was 1 km from England South, Cabo San Lucas 23 km from Central Mexico, and the phone
queues a neighbour within 30 km. Land borders stay where the admin units put them; the sea and
every other leftover is split by nearest land, so a coastal city is as far from the other piece as
its land border is.

Run from the repo root:  python3 scripts/build-slice-polys.py [country-id ...]
(no country ids = every country; name some to write only theirs and leave the others' committed
files untouched, since Geofabrik outlines drift between runs).
A piece with `outline` gets a file; `outline.union` lists Geofabrik paths to union,
`outline.within` clips to one Geofabrik path, `outline.minus` subtracts other pieces'
outlines (so two halves of one region share an exact border, with no gap or overlap).
`outline.seaward` (degrees) widens an outline built from Natural Earth states out to sea by that
much, minus every other state of the same country: Natural Earth coasts are coarser than the
Geofabrik outline, so without it a coastal road can fall in the sea strip, which the `minus` then
hands to the OTHER piece.
"""
import json
import urllib.request
from pathlib import Path

import math
import os

from shapely.geometry import MultiPoint, MultiPolygon, Polygon, shape
from shapely import coverage_simplify, coverage_union_all, get_coordinates, set_precision, voronoi_polygons
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent
CACHE = {}
CLOSE_DEG = 0.01  # ~1 km: wider than any gap between Geofabrik county outlines seen in England


NE_FILE = None  # set from $NE_ADMIN1 (ne_10m_admin_1_states_provinces.geojson) for "ne:ISO:Name" parts


def geofabrik_poly(path):
    if path.startswith("ne:"):
        return natural_earth(path)
    if path not in CACHE:
        url = f"https://download.geofabrik.de/{path}.poly"
        CACHE[path] = parse(urllib.request.urlopen(url, timeout=60).read().decode())
    return CACHE[path]


def natural_earth(token):
    """ne:ISO:Name -> Natural Earth admin-1 shape, for pieces that split a Geofabrik region."""
    global NE_FILE
    import os
    from shapely.geometry import shape
    if NE_FILE is None:
        NE_FILE = {(f["properties"]["iso_a2"], f["properties"]["name"]): shape(f["geometry"])
                   for f in json.load(open(os.environ["NE_ADMIN1"]))["features"]}
    _, iso, name = token.split(":", 2)
    return NE_FILE[(iso, name)]


MIN_SLIVER_KM2 = 50   # a smaller land part touching ANOTHER piece's land is a sliver, not an island
SAMPLE_DEG = 0.02     # ~2 km between the land-edge samples that decide "nearest land"
SIMPLIFY_DEG = 0.002  # ~200 m, applied to all pieces together so they keep shared edges


def country_land(iso):
    """Natural Earth 1:10m land of one country (ISO_A2_EH: Norway's ISO_A2 is -99)."""
    feats = json.load(open(os.environ["NE_ADMIN0"]))["features"]
    return unary_union([shape(f["geometry"]) for f in feats if f["properties"]["ISO_A2_EH"] == iso]).buffer(0)


def parts(geom):
    return list(geom.geoms) if hasattr(geom, "geoms") else ([] if geom.is_empty else [geom])


def km2(geom):
    return geom.area * 111.32 ** 2 * math.cos(math.radians(geom.centroid.y))


def repartition(raw, land):
    """raw: {id: outline as the config draws it} -> {id: outline}. The result covers the same
    extent, each piece's land is its own admin units, and the rest goes to the nearest land."""
    ids = list(raw)
    extent = unary_union(list(raw.values()))
    cores = {i: raw[i].intersection(land).difference(unary_union([raw[j] for j in ids if j != i])) for i in ids}
    for i in ids:  # drop slivers: small land parts pressed against another piece's land
        others = unary_union([cores[j] for j in ids if j != i])
        cores[i] = unary_union([p for p in parts(cores[i]) if km2(p) >= MIN_SLIVER_KM2 or p.distance(others) > 0.01])
    rest = extent.difference(unary_union(list(cores.values())))
    points, owner, seen = [], [], set()
    for i in ids:
        edge = cores[i].simplify(SAMPLE_DEG / 4).boundary.segmentize(SAMPLE_DEG)
        for x, y in get_coordinates(edge):
            key = (round(x, 6), round(y, 6))
            if key not in seen:
                seen.add(key); points.append(key); owner.append(i)
    cells = voronoi_polygons(MultiPoint(points), extend_to=extent.envelope.buffer(1), ordered=True)
    near = {i: coverage_union_all([c for c, o in zip(cells.geoms, owner) if o == i]) for i in ids}
    out = {i: unary_union([cores[i], rest.intersection(near[i])]).buffer(0) for i in ids}
    simple = coverage_simplify([out[i] for i in ids], SIMPLIFY_DEG)
    return {i: g.buffer(0) for i, g in zip(ids, simple)}


def other_states(tokens):
    """Every Natural Earth state of the tokens' countries that is not one of the tokens."""
    natural_earth(tokens[0])  # loads NE_FILE
    isos = {t.split(":", 2)[1] for t in tokens}
    mine = {tuple(t.split(":", 2)[1:]) for t in tokens}
    return unary_union([g for key, g in NE_FILE.items() if key[0] in isos and key not in mine])


def parse(text):
    """Geofabrik .poly -> shapely geometry (outer rings unioned, '!' rings subtracted)."""
    lines = [l.strip() for l in text.splitlines() if l.strip()][1:]
    outers, holes, ring, hole = [], [], None, False
    for line in lines:
        if line == "END":
            if ring is not None:
                (holes if hole else outers).append(Polygon(ring))
                ring = None
            continue
        parts = line.split()
        if ring is not None and len(parts) == 2:
            ring.append((float(parts[0]), float(parts[1])))
        else:
            ring, hole = [], line.startswith("!")
    geom = unary_union(outers)
    return geom.difference(unary_union(holes)) if holes else geom


def write(path, name, geom):
    polys = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    out, n = [name], 0
    for poly in polys:
        for hole, ring in [(False, poly.exterior)] + [(True, r) for r in poly.interiors]:
            n += 1
            out.append(f"{'!' if hole else ''}{n}")
            out += [f"   {x:.7f}   {y:.7f}" for x, y in ring.coords]
            out.append("END")
    out.append("END")
    path.write_text("\n".join(out) + "\n")


def country_iso(pbf):
    """The country's ISO code, by the token rule of valhalla-tiles.yml (continent/country/sub -> country)."""
    bits = pbf.split("/")
    token = bits[1] if len(bits) == 3 else bits[-1]
    return json.loads((ROOT / "country-driving-side.json").read_text())[token]["iso"]


def main():
    import sys
    config = json.loads((ROOT / "region-slices.json").read_text())
    only = set(sys.argv[1:])
    for country in config["countries"]:
        if only and country["country"] not in only:
            continue
        built = {}
        for piece in country["pieces"]:
            spec = piece.get("outline") or {"union": [piece["sources"][0]]}
            geom = unary_union([geofabrik_poly(p) for p in spec["union"]])
            # Close the few-hundred-metre gaps between neighbouring Geofabrik outlines,
            # or the piece that is later subtracted from its parent keeps them as slivers.
            geom = geom.buffer(CLOSE_DEG).buffer(-CLOSE_DEG)
            if spec.get("seaward"):
                geom = geom.buffer(spec["seaward"]).difference(other_states(spec["union"]))
            if spec.get("within"):
                geom = geom.intersection(geofabrik_poly(spec["within"]))
            for other in spec.get("minus", []):
                geom = geom.difference(built[other])
            built[piece["id"]] = geom.buffer(0)
        land = (unary_union([natural_earth(t) for t in country["land"]]).buffer(0) if country.get("land")
                else country_land(country_iso(country["pbf"])))
        final = repartition(built, land)
        for pid, geom in final.items():
            # Snap to the written precision so the file re-reads as valid geometry.
            geom = set_precision(unary_union([p for p in parts(geom) if km2(p) >= 0.01]), 1e-7)
            assert geom.is_valid and not geom.is_empty, pid
            target = ROOT / "polys" / f"{pid}.poly"
            target.parent.mkdir(exist_ok=True)
            write(target, pid, geom)
            print(f"{target.relative_to(ROOT.parent)}: {len(parts(geom))} polygon(s), {km2(geom):,.0f} km2")


if __name__ == "__main__":
    main()
