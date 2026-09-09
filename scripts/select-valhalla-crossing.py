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
import traceback


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


def locate_candidates(actor, samples, country, bindings, max_snap, report=lambda **counts: None):
    result, seen = [], set()
    for sample_index, sample in enumerate(samples, 1):
        report(sample=sample_index, samples=len(samples), located=len(result))
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


def choose_route(actor, first, second, groups, graph_id, max_pairs, report=lambda **counts: None):
    pairs = sorted(itertools.product(first, second), key=lambda pair: metres(*pair))[:max_pairs]
    report(firstCandidates=len(first), secondCandidates=len(second), pairs=len(pairs))
    for index, pair in enumerate(pairs, 1):
        report(pair=index)
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


def execute(payload, report=lambda stage=None, **counts: None):
    report("imports")
    from shapely.geometry import Polygon, Point, box
    from shapely.ops import unary_union
    from valhalla import Actor, __version__
    from valhalla.utils import GraphId, get_tile_base_lon_lat, get_tile_id_from_lon_lat
    report("inputs")
    config, receipt = proof.read_json(payload["config"]), proof.read_json(payload["receipt"])
    root = proof.local_config(config)
    require(receipt.get("scope") == "unchanged-tile-union-only", "Integrity receipt required")
    report("inventory")
    require(proof.inspect_tiles(root) == receipt["unsplit"]["tiles"], "Actual unsplit differs from receipt")
    source = {tile["path"] for tile in receipt["unsplit"]["tiles"]}
    first = {tile["path"] for tile in receipt["first"]["tiles"]}
    second = {tile["path"] for tile in receipt["second"]["tiles"]}
    groups = {"firstOnly": first - second, "secondOnly": second - first, "shared": first & second}
    require(first | second == source and all(groups.values()), "Invalid pack inventories")
    for key, group in groups.items():
        require(group == set(receipt[key]), "Receipt ownership mismatch")
    report("polygons")
    countries = [partition.polygon_geometry(partition.parse_poly(partition.safe_path(payload[key]).read_text()),
                                            Polygon, unary_union) for key in ("first_poly", "second_poly")]
    bindings = {"graph_id": GraphId, "base": get_tile_base_lon_lat, "at": get_tile_id_from_lon_lat,
                "box": box, "point": Point}
    report("actor-init")
    actor = Actor(config)
    located = []
    for index, key in enumerate(("firstOnly", "secondOnly")):
        report("sampling", pack=index)
        samples = candidates(groups[key], countries[index], countries[1-index], bindings, payload["candidates"])
        report("locate", pack=index)
        located.append(locate_candidates(actor, samples, countries[index], bindings, payload["max_snap"], report))
    report("route-pairs")
    result = choose_route(actor, *located, groups, GraphId, payload["pairs"], report)
    report("inventory-recheck")
    require(proof.inspect_tiles(root) == receipt["unsplit"]["tiles"], "Graph changed during selection")
    return {**result, "bindingVersionReported": __version__, "candidateCounts": [len(p) for p in located],
            "networkIsolation": "external requirement; local graph config checked"}


def worker_diagnostics(path):
    state = {"schemaVersion": 1, "stage": "worker-start", "status": "running", "counts": {}}

    def report(stage=None, **counts):
        if stage is not None:
            state["stage"], state["counts"] = stage, {}
        state["counts"].update(counts)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, sort_keys=True))
        temporary.replace(path)

    return state, report


def native_worker(payload, operation=execute):
    state, report = worker_diagnostics(Path(payload["diagnostic"]))
    report()
    try:
        result = operation(payload, report)
        with Path(payload["result"]).open("x") as stream:
            json.dump(result, stream, sort_keys=True)
        state["status"] = "success"
    except Exception as error:
        # Never retain arbitrary exception messages: native text may contain coordinates.
        state["status"] = "failed"
        state["errorType"] = type(error).__name__ if type(error).__module__ == "builtins" else "OtherError"
        state["code"] = "candidate-exhausted" if str(error) == "Bounded candidate pairs exhausted without a two-pack crossing" else "stage-failed"
        allowed = {"select-valhalla-crossing.py", "verify-valhalla-crossing.py",
                   "partition-valhalla-connected.py", "actor.py", "config.py", "graph_utils.py"}
        state["frames"] = [{"file": Path(frame.filename).name, "line": frame.lineno}
                           for frame in traceback.extract_tb(error.__traceback__)
                           if Path(frame.filename).name in allowed]
        raise
    finally:
        report()


def run_worker(payload, timeout, runner=subprocess.run, diagnostic_output=None):
    with tempfile.TemporaryDirectory(prefix="crossing-selection-") as directory:
        evidence = Path(directory) / "result.json"
        diagnostic = Path(directory) / "diagnostic.json"
        outcome = {"schemaVersion": 1, "stage": "worker-start", "status": "failed"}
        try:
            result = runner([sys.executable, str(Path(__file__).resolve()), "--worker"],
                            input=json.dumps({**payload, "result": str(evidence), "diagnostic": str(diagnostic)}),
                            text=True, capture_output=True, timeout=timeout)
            outcome["returnCode"] = result.returncode
            require(result.returncode == 0, "Native selector failed; no fixture accepted")
            require(evidence.is_file(), "Selector produced no evidence")
            accepted = proof.read_json(evidence)
            outcome["status"] = "success"
            return accepted
        except subprocess.TimeoutExpired:
            outcome.update(status="timeout", timeoutSeconds=timeout)
            raise
        finally:
            if diagnostic_output is not None:
                progress = proof.read_json(diagnostic) if diagnostic.is_file() else {}
                # Parent status wins for process timeout/crash, while preserving the last stage.
                merged = {**outcome, **progress, "status": outcome["status"]}
                with Path(diagnostic_output).open("x") as stream:
                    json.dump(merged, stream, sort_keys=True)


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
    diagnostic_output = partition.safe_path(str(output) + ".diagnostics.json", exists=False)
    result = run_worker(args, args["timeout"], diagnostic_output=diagnostic_output)
    with output.open("x") as stream:
        json.dump(result, stream, sort_keys=True)
    print(json.dumps({"artifact": str(output), "scope": result["scope"]}))


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--worker"]:
            payload = json.load(sys.stdin)
            native_worker(payload)
        else:
            main()
    except Exception as error:
        # Native diagnostic text may contain fixture coordinates; keep console
        # output coordinate-free, including subprocess failures.
        print(f"Fixture selection failed ({type(error).__name__}); no fixture accepted", file=sys.stderr)
        sys.exit(1)
