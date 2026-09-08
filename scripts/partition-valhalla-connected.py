#!/usr/bin/env python3
"""PURPOSE: Partition one unchanged connected graph into two proof packs.
RESPONSIBILITY: Exact extract polygon membership and safe whole-tile hardlinks.
DEPENDENCIES: stdlib; Shapely and pinned Valhalla Python bindings at runtime.
CONSUMERS: Build-only connected graph proof; test_partition_valhalla_connected.py.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

# e2f017b16080f49203de245a211b09efab09cf72 src/baldr/tilehierarchy.cc,
# levels()[2]: local road tiles are 0.25 degrees. Never use this for L0/L1.
LOCAL_TILE_DEGREES = 0.25


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(value, exists=True, directory=False):
    require(".." not in Path(value).parts, "Path traversal forbidden")
    absolute = Path(value).absolute()
    require(absolute.resolve() == absolute, "Symlink path forbidden")
    if exists:
        require(absolute.is_dir() if directory else absolute.is_file(), "Required input missing or wrong type")
    else:
        require(not absolute.exists() and not absolute.is_symlink(), "Output already exists")
        require(absolute.parent.is_dir(), "Output parent must already exist")
    return absolute


def parse_poly(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    require(len(lines) >= 3 and lines[0] != "END", "Missing polygon name")
    rings, labels, index = [], set(), 1
    while index < len(lines) and lines[index] != "END":
        label = lines[index]
        require(label not in labels and label != "!", "Invalid or duplicate ring label")
        labels.add(label)
        index += 1
        points = []
        while index < len(lines) and lines[index] != "END":
            values = lines[index].split()
            require(len(values) == 2, "Polygon coordinate must have two numbers")
            x, y = map(float, values)
            require(math.isfinite(x) and math.isfinite(y) and -180 <= x <= 180 and -90 <= y <= 90,
                    "Invalid polygon coordinate")
            points.append((x, y))
            index += 1
        require(index < len(lines), "Unterminated polygon ring")
        require(len(set(points)) >= 3, "Polygon ring has fewer than three distinct points")
        if points[-1] != points[0]:
            points.append(points[0])
        rings.append((label.startswith("!"), points))
        index += 1
    require(index == len(lines) - 1 and lines[index] == "END", "Missing final END or trailing data")
    require(any(not hole for hole, _ in rings), "No outer polygon ring")
    return rings


def polygon_geometry(rings, polygon, union):
    shells = [points for hole, points in rings if not hole]
    hole_rings = [points for hole, points in rings if hole]
    outer = [polygon(points) for points in shells]
    holes = [polygon(points) for points in hole_rings]
    require(all(item.is_valid and not item.is_empty for item in outer + holes), "Invalid polygon geometry")
    owned_holes = [[] for _ in outer]
    for hole, points in zip(holes, hole_rings):
        owners = [index for index, shell in enumerate(outer) if shell.contains(hole)]
        require(len(owners) == 1, "Hole must lie inside exactly one outer ring")
        owned_holes[owners[0]].append(points)
    # Subtract only from the owning component: a separate outer island within
    # that hole must survive the final union.
    components = [polygon(shell, inner) for shell, inner in zip(shells, owned_holes)]
    require(all(item.is_valid and not item.is_empty for item in components), "Invalid polygon component")
    result = union(components)
    require(result.is_valid and not result.is_empty, "Invalid or empty extract polygon")
    return result


def tile_identity(relative, graph_id):
    require(re.fullmatch(r"[012]/(?:[0-9]+/)*[0-9]+\.gph", relative), "Unexpected tile path")
    parts = relative.split("/")
    tile = graph_id(int("".join(parts[1:]).removesuffix(".gph")), int(parts[0]), 0)
    require(tile.is_valid() and tile.level() in (0, 1, 2), "Invalid native tile identity")
    require(Path(tile).as_posix() == relative, "Noncanonical native tile path")
    return tile


def enumerate_tiles(root, graph_id):
    tiles = []
    for current, directories, files in os.walk(root, followlinks=False):
        require(all(re.fullmatch(r"[0-9]+", name) for name in directories), "Unexpected source directory")
        for name in directories + files:
            item = Path(current) / name
            require(not item.is_symlink() and item.resolve().is_relative_to(root), "Unsafe source member")
        for name in files:
            item = Path(current) / name
            relative = item.relative_to(root).as_posix()
            require(item.is_file(), "Nonregular source member")
            if relative == "index.bin":
                continue
            identity = tile_identity(relative, graph_id)
            require(item.stat().st_size > 0, "Empty source tile")
            tiles.append((relative, identity))
    require(tiles, "No graph tiles found")
    return sorted(tiles, key=lambda item: item[0])


def classify(tiles, first, second, base_lon_lat, box):
    groups = {"firstOnly": [], "secondOnly": [], "shared": [], "leftovers": []}
    for relative, identity in tiles:
        if identity.level() < 2:
            groups["shared"].append(relative)
            continue
        x, y = base_lon_lat(identity)
        require(math.isfinite(x) and math.isfinite(y), "Invalid native tile origin")
        bounds = box(x, y, x + LOCAL_TILE_DEGREES, y + LOCAL_TILE_DEGREES)
        a, b = first.intersects(bounds), second.intersects(bounds)
        key = "firstOnly" if a and not b else "secondOnly" if b and not a else "shared"
        groups[key].append(relative)
        if not a and not b:
            groups["leftovers"].append(relative)
    require(groups["firstOnly"] and groups["secondOnly"], "Each pack requires exclusive local tiles")
    require(groups["shared"], "Proof packs require shared tiles")
    return groups


def link_packs(source, first, second, groups):
    # Immutable, trusted staging is required; failures leave a refused partial
    # output in place for inspection, never erase or overwrite somebody's files.
    first.mkdir()
    second.mkdir()
    for root, exclusive in ((first, "firstOnly"), (second, "secondOnly")):
        for relative in sorted(groups[exclusive] + groups["shared"]):
            original, target = source / relative, root / relative
            require(not original.is_symlink() and original.resolve().is_relative_to(source), "Source changed")
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(original, target, follow_symlinks=False)
            require(os.path.samefile(original, target), "Hardlink verification failed")


def partition(source, first_poly, second_poly, first_out, second_out, bindings):
    source = safe_path(source, directory=True)
    polys = [safe_path(first_poly), safe_path(second_poly)]
    outputs = [safe_path(first_out, exists=False), safe_path(second_out, exists=False)]
    roots = [source, *outputs]
    for i, root in enumerate(roots):
        for other in roots[i + 1:]:
            require(not root.is_relative_to(other) and not other.is_relative_to(root), "Graph roots overlap")
    geometries = [polygon_geometry(parse_poly(p.read_text()), bindings["polygon"], bindings["union"])
                  for p in polys]
    tiles = enumerate_tiles(source, bindings["graph_id"])
    groups = classify(tiles, *geometries, bindings["base"], bindings["box"])
    link_packs(source, *outputs, groups)
    return {"schemaVersion": 1, "scope": "whole-tile-partition-not-routing-proof",
            "source": str(source), "outputs": [str(p) for p in outputs],
            "polygonSha256": [hashlib.sha256(p.read_bytes()).hexdigest() for p in polys],
            "counts": {key: len(value) for key, value in groups.items()}, **groups}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("source", "first-poly", "second-poly", "first-out", "second-out"):
        parser.add_argument(f"--{key}", required=True)
    args = parser.parse_args()
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union
    from valhalla.utils import GraphId, get_tile_base_lon_lat
    result = partition(args.source, args.first_poly, args.second_poly, args.first_out, args.second_out,
                       {"polygon": Polygon, "union": unary_union, "box": box,
                        "graph_id": GraphId, "base": get_tile_base_lon_lat})
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Partition failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
