#!/usr/bin/env python3
"""PURPOSE: Write the stored outline (.poly) of every region-slice piece that is not a
single Geofabrik region.
RESPONSIBILITY: Union / intersect / subtract Geofabrik .poly files exactly as
scripts/region-slices.json describes, and write the result in Geofabrik .poly format.
DEPENDENCIES: shapely (local use only; CI reads the committed .poly files and never runs this).
CONSUMERS: scripts/polys/*.poly, read by region-slices-pilot.yml (partition, coverage, road data).

Run from the repo root:  python3 scripts/build-slice-polys.py
A piece with `outline` gets a file; `outline.union` lists Geofabrik paths to union,
`outline.within` clips to one Geofabrik path, `outline.minus` subtracts other pieces'
outlines (so two halves of one region share an exact border, with no gap or overlap).
"""
import json
import urllib.request
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon
from shapely import set_precision
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


def main():
    config = json.loads((ROOT / "region-slices.json").read_text())
    for country in config["countries"]:
        built = {}
        for piece in country["pieces"]:
            spec = piece.get("outline")
            if not spec:
                continue
            geom = unary_union([geofabrik_poly(p) for p in spec["union"]])
            # Close the few-hundred-metre gaps between neighbouring Geofabrik outlines,
            # or the piece that is later subtracted from its parent keeps them as slivers.
            geom = geom.buffer(CLOSE_DEG).buffer(-CLOSE_DEG)
            if spec.get("within"):
                geom = geom.intersection(geofabrik_poly(spec["within"]))
            for other in spec.get("minus", []):
                geom = geom.difference(built[other])
            # Snap to the written precision so the file re-reads as valid geometry.
            geom = set_precision(geom.buffer(0), 1e-7)
            assert geom.is_valid and not geom.is_empty, piece["id"]
            built[piece["id"]] = geom
            target = ROOT / "polys" / f"{piece['id']}.poly"
            target.parent.mkdir(exist_ok=True)
            write(target, piece["id"], geom)
            parts = len(geom.geoms) if isinstance(geom, MultiPolygon) else 1
            print(f"{target.relative_to(ROOT.parent)}: {parts} polygon(s)")


if __name__ == "__main__":
    main()
