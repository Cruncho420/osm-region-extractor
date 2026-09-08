#!/usr/bin/env python3
"""PURPOSE: Select an actually routed two-pack fixture from exclusive local tiles.
RESPONSIBILITY: Bounded local candidate search; write coordinates only to artifacts.
DEPENDENCIES: stdlib, reviewed proof helpers; native Valhalla/Shapely in worker.
CONSUMERS: Build-only connected proof and test_select_valhalla_crossing.py.
"""
import argparse
import importlib.util
import itertools
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proof = load("verify-valhalla-crossing")
partition = load("partition-valhalla-connected")
require = proof.require


def metres(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlon = math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))


def candidates(paths, country, neighbour, bindings, limit):
    ranked = []
    for relative in sorted(paths):
        gid = partition.tile_identity(relative, bindings["graph_id"])
        require(gid.level() == 2, "Exclusive candidate tiles must be L2")
        x, y = bindings["base"](gid)
        tile = bindings["box"](x, y, x + partition.LOCAL_TILE_DEGREES, y + partition.LOCAL_TILE_DEGREES)
        clipped = tile.intersection(country)
        if not clipped.is_empty:
            ranked.append((clipped.distance(neighbour), relative, clipped, x, y))
    result = []
    # Nearest exclusive tile first; country clipping handles actual outer/hole geometry.
    for _, relative, clipped, x, y in sorted(ranked, key=lambda row: (row[0], row[1])):
        sample = [clipped.representative_point()]
        sample += [bindings["point"](x + partition.LOCAL_TILE_DEGREES * i / 8,
                                     y + partition.LOCAL_TILE_DEGREES * j / 8)
                   for i in range(1, 8) for j in range(1, 8)]
        sample.sort(key=lambda point: (point.distance(neighbour), point.x, point.y))
        for point in sample:
            if clipped.contains(point):
                result.append({"lat": point.y, "lon": point.x, "tile": relative})
                if len(result) == limit:
                    return result
    return result


def locate_candidates(actor, samples, country, bindings, max_snap):
    result, seen = [], set()
    for sample in samples:
        request = {"costing": "auto", "locations": [{"lat": sample["lat"], "lon": sample["lon"],
                                                      "search_cutoff": max_snap}]}
        try:
            located = actor.locate(request)
        except RuntimeError as error:
            if str(error) in proof.NO_ROUTE:
                continue
            raise
        require(isinstance(located, list) and len(located) == 1, "Unexpected locate response")
        require(isinstance(located[0], dict) and "edges" in located[0], "Missing locate edges field")
        edges = located[0]["edges"]
        # Pinned locate_serializer.cc emits edges:null for a valid location
        # with no correlated road. Continue the bounded search in that case.
        if edges is None:
            continue
        require(isinstance(edges, list), "Invalid locate edges field")
        for edge in edges:
            require(isinstance(edge, dict), "Invalid locate edge")
            snap = {"lat": edge.get("correlated_lat"), "lon": edge.get("correlated_lon")}
            require(all(type(value) in (int, float) and math.isfinite(value) for value in snap.values()),
                    "Invalid native correlation")
            point = bindings["point"](snap["lon"], snap["lat"])
            tile = Path(bindings["at"](2, (snap["lon"], snap["lat"]))).as_posix()
            key = (snap["lat"], snap["lon"])
            if metres(sample, snap) <= max_snap and country.contains(point) and tile == sample["tile"] and key not in seen:
                result.append({**snap, "search_cutoff": max_snap})
                seen.add(key)
                break
    return result


def choose_route(actor, first, second, groups, graph_id, max_pairs):
    pairs = sorted(itertools.product(first, second), key=lambda pair: metres(*pair))[:max_pairs]
    for index, pair in enumerate(pairs, 1):
        request = {"costing": "auto", "shape_format": "polyline6", "locations": list(pair)}
        proof.check_request(request)
        try:
            captured = proof.snapshot(actor, request, graph_id)
        except RuntimeError as error:
            if str(error) in proof.NO_ROUTE:
                continue
            raise
        used = {tile for leg in captured["legs"] for tile in leg["tilePaths"]}
        require(used <= set().union(*groups.values()), "Route outside partition receipt")
        ownership = {key: sorted(used & values) for key, values in groups.items()}
        if all(ownership.values()):
            return {"request": request, "routeEvidence": captured, "usedOwnership": ownership,
                    "pairsAttempted": index, "scope": "native-host-pack-crossing-only-not-national-border"}
    raise ValueError("Bounded candidate pairs exhausted without a two-pack crossing")


def execute(payload):
    from shapely.geometry import Polygon, Point, box
    from shapely.ops import unary_union
    from valhalla import Actor, __version__
    from valhalla.utils import GraphId, get_tile_base_lon_lat, get_tile_id_from_lon_lat
    config, receipt = proof.read_json(payload["config"]), proof.read_json(payload["receipt"])
    root = proof.local_config(config)
    require(receipt.get("scope") == "unchanged-tile-union-only", "Integrity receipt required")
    require(proof.inspect_tiles(root) == receipt["unsplit"]["tiles"], "Actual unsplit differs from receipt")
    source = {tile["path"] for tile in receipt["unsplit"]["tiles"]}
    first = {tile["path"] for tile in receipt["first"]["tiles"]}
    second = {tile["path"] for tile in receipt["second"]["tiles"]}
    groups = {"firstOnly": first - second, "secondOnly": second - first, "shared": first & second}
    require(first | second == source and all(groups.values()), "Invalid pack inventories")
    for key, group in groups.items():
        require(group == set(receipt[key]), "Receipt ownership mismatch")
    countries = [partition.polygon_geometry(partition.parse_poly(partition.safe_path(payload[key]).read_text()),
                                            Polygon, unary_union) for key in ("first_poly", "second_poly")]
    bindings = {"graph_id": GraphId, "base": get_tile_base_lon_lat, "at": get_tile_id_from_lon_lat,
                "box": box, "point": Point}
    actor = Actor(config)
    located = []
    for index, key in enumerate(("firstOnly", "secondOnly")):
        samples = candidates(groups[key], countries[index], countries[1-index], bindings, payload["candidates"])
        located.append(locate_candidates(actor, samples, countries[index], bindings, payload["max_snap"]))
    result = choose_route(actor, *located, groups, GraphId, payload["pairs"])
    require(proof.inspect_tiles(root) == receipt["unsplit"]["tiles"], "Graph changed during selection")
    return {**result, "bindingVersionReported": __version__, "candidateCounts": [len(p) for p in located],
            "networkIsolation": "external requirement; local graph config checked"}


def run_worker(payload, timeout, runner=subprocess.run):
    with tempfile.TemporaryDirectory(prefix="crossing-selection-") as directory:
        evidence = Path(directory) / "result.json"
        result = runner([sys.executable, str(Path(__file__).resolve()), "--worker"],
                        input=json.dumps({**payload, "result": str(evidence)}), text=True,
                        capture_output=True, timeout=timeout)
        require(result.returncode == 0, "Native selector failed; no fixture accepted")
        require(evidence.is_file(), "Selector produced no evidence")
        return proof.read_json(evidence)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("config", "receipt", "first-poly", "second-poly", "output"):
        parser.add_argument(f"--{key}", required=True)
    parser.add_argument("--candidates", type=int, default=100)
    parser.add_argument("--pairs", type=int, default=32)
    parser.add_argument("--max-snap", type=int, default=500)
    parser.add_argument("--timeout", type=float, default=120)
    args = vars(parser.parse_args())
    require(1 <= args["candidates"] <= 200 and 1 <= args["pairs"] <= 64, "Search bounds exceeded")
    require(1 <= args["max_snap"] <= 1000 and 0 < args["timeout"] <= 600, "Snap/timeout bounds exceeded")
    output = partition.safe_path(args["output"], exists=False)
    result = run_worker(args, args["timeout"])
    with output.open("x") as stream:
        json.dump(result, stream, sort_keys=True)
    print(json.dumps({"artifact": str(output), "scope": result["scope"]}))


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--worker"]:
            payload = json.load(sys.stdin)
            with Path(payload["result"]).open("x") as stream:
                json.dump(execute(payload), stream, sort_keys=True)
        else:
            main()
    except Exception as error:
        # Native diagnostic text may contain fixture coordinates; keep console
        # output coordinate-free, including subprocess failures.
        print(f"Fixture selection failed ({type(error).__name__}); no fixture accepted", file=sys.stderr)
        sys.exit(1)
