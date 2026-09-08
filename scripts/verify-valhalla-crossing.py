#!/usr/bin/env python3
"""PURPOSE: Verify a supplied route across reconstructed connected graph packs.
RESPONSIBILITY: Native actor equivalence, used tile ownership and fresh-process negatives.
DEPENDENCIES: Python stdlib; pinned Valhalla bindings only in worker processes.
CONSUMERS: Build-only proof runner; test_verify_valhalla_crossing.py.
"""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time


# e2f017b exceptions.h what() returns message only; route_action.cc throws
# 170/171 without suffixes. Unknown text is NEVER accepted as missing coverage.
NO_ROUTE = {
    "Locations are in unconnected regions. Go check/edit the map at osm.org": 170,
    "No suitable edges near location": 171,
    "No path could be found for input": 442,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(filename):
    return json.loads(Path(filename).read_text())


def local_config(config):
    mjolnir = config.get("mjolnir", {})
    root = mjolnir.get("tile_dir")
    require(isinstance(root, str) and Path(root).is_absolute(), "Absolute local tile_dir required")
    require(Path(root).is_dir() and Path(root).resolve() == Path(root), "Real tile directory required")
    for key in ("tile_extract", "tile_url", "traffic_extract", "incident_log", "incident_dir"):
        require(not mjolnir.get(key), f"Forbidden graph source: {key}")
    require(mjolnir.get("global_synchronized_cache") is False, "Global cache must be explicitly disabled")
    return Path(root)


def check_request(request):
    require(request.get("costing") == "auto", "Proof currently requires auto costing")
    require(request.get("shape_format", "polyline6") == "polyline6", "Polyline6 required")
    require(request.get("format", "json") == "json", "JSON route output required")
    require("date_time" not in request and "time" not in request, "Time-dependent requests unsupported")
    points = request.get("locations", [])
    require(len(points) >= 2, "At least two supplied locations required")
    for point in points:
        for key in ("lat", "lon", "search_cutoff"):
            value = point.get(key)
            require(type(value) in (int, float) and math.isfinite(value), f"Finite {key} required")
        require(0 < point["search_cutoff"] <= 1000, "Explicit search_cutoff must be 1..1000 metres")


def inspect_tiles(root):
    tiles = []
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            member = Path(current) / name
            require(not member.is_symlink(), "Symlink in graph tree")
            require(member.resolve().is_relative_to(root), "Graph path escaped root")
        for name in sorted(files):
            member = Path(current) / name
            relative = member.relative_to(root).as_posix()
            require(member.is_file(), "Non-regular graph member")
            if relative == "index.bin":
                continue
            require(member.suffix == ".gph", "Unexpected graph member")
            digest = hashlib.sha256()
            with member.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            tiles.append({"path": relative, "bytes": member.stat().st_size, "sha256": digest.hexdigest()})
    return sorted(tiles, key=lambda tile: tile["path"])


def check_config_equivalence(configs):
    baseline = None
    for key in ("unsplit", "union", "first", "second"):
        normalized = copy.deepcopy(configs[key])
        normalized["mjolnir"].pop("tile_dir", None)
        # Canonical JSON also distinguishes booleans from numbers (True == 1
        # in Python), so only the graph-directory value may differ.
        canonical = json.dumps(normalized, sort_keys=True, allow_nan=False)
        if baseline is None:
            baseline = canonical
        require(canonical == baseline, f"Non-path configuration mismatch: {key}")


def check_receipt(receipt, configs):
    check_config_equivalence(configs)
    require(receipt.get("scope") == "unchanged-tile-union-only", "Partition integrity receipt required")
    for key in ("unsplit", "union", "first", "second"):
        expected = receipt[key]["tiles"]
        require(expected and inspect_tiles(local_config(configs[key])) == expected,
                f"Actual {key} graph does not match receipt")
    require(receipt["unsplit"]["tiles"] == receipt["union"]["tiles"], "Receipt union differs")
    source = {item["path"]: item for item in receipt["unsplit"]["tiles"]}
    members = {}
    for key in ("first", "second"):
        for tile in receipt[key]["tiles"]:
            require(source.get(tile["path"]) == tile, "Pack tile differs from source")
            members[tile["path"]] = tile
    require(members == source, "Pack union misses source tiles")
    first = {item["path"] for item in receipt["first"]["tiles"]}
    second = {item["path"] for item in receipt["second"]["tiles"]}
    groups = {"firstOnly": first - second, "secondOnly": second - first, "shared": first & second}
    for key, group in groups.items():
        require(group and group == set(receipt[key]), f"Invalid ownership group: {key}")
    return groups


def snapshot(actor, request, graph_id):
    started = time.monotonic()
    result = actor.route(copy.deepcopy(request))
    route_ms = (time.monotonic() - started) * 1000
    legs = result.get("trip", {}).get("legs", [])
    require(result.get("trip", {}).get("status") == 0 and legs, "Route must succeed with legs")
    captured = []
    for leg in legs:
        shape = leg.get("shape")
        require(isinstance(shape, str) and shape, "Missing route shape")
        summary = leg.get("summary", {})
        for key in ("length", "time"):
            require(type(summary.get(key)) in (int, float) and math.isfinite(summary[key])
                    and summary[key] > 0, f"Invalid leg {key}")
        trace_request = {"encoded_polyline": shape, "shape_match": "edge_walk", "costing": "auto",
                         "filters": {"action": "include", "attributes": ["edge.id", "shape"]}}
        if "costing_options" in request:
            trace_request["costing_options"] = copy.deepcopy(request["costing_options"])
        trace = actor.trace_attributes(trace_request)
        require(trace.get("shape") == shape, "Edge-walk shape differs from route")
        edges = [edge.get("id") for edge in trace.get("edges", [])]
        require(edges and all(type(edge) is int and edge >= 0 for edge in edges), "Missing edge IDs")
        paths = [Path(graph_id(edge).tile_base()).as_posix() for edge in edges]
        captured.append({"shape": shape, "length": summary["length"], "time": summary["time"],
                         "edges": edges, "tilePaths": paths})
    return {"legs": captured, "routeMs": route_ms}


def positive(configs, request, groups, actor_factory, graph_id):
    actors = {key: actor_factory(configs[key]) for key in ("unsplit", "union")}
    rounds = {}
    baseline = None
    for phase in ("cold", "warm"):
        rounds[phase] = {}
        for key, actor in actors.items():
            result = snapshot(actor, request, graph_id)
            if baseline is None:
                baseline = result["legs"]
            require(result["legs"] == baseline, f"Route/edge mismatch: {key} {phase}")
            rounds[phase][key] = result
    used = {tile for leg in baseline for tile in leg["tilePaths"]}
    allowed = set().union(*(set(group) for group in groups.values()))
    require(used <= allowed, "Route uses tile outside partition receipt")
    membership = {key: sorted(used & set(group)) for key, group in groups.items()}
    require(all(membership.values()), "Route must use exclusive tiles from both packs and shared tiles")
    return {"rounds": rounds, "usedOwnership": membership, "actorsConstructed": 2}


def negative(config, request, actor_factory):
    # Constructor errors are never missing-pack evidence.
    actor = actor_factory(config)
    try:
        actor.route(copy.deepcopy(request))
    except RuntimeError as error:
        code = NO_ROUTE.get(str(error))
        require(code is not None, f"Unknown native error: {error}")
        return {"rejected": True, "message": str(error), "codeFromPinnedMessage": code}
    raise ValueError("Missing-pack route unexpectedly succeeded")


def worker(payload):
    from valhalla import Actor, __version__
    from valhalla.utils import GraphId
    for config in payload["configs"].values():
        local_config(config)
    check_request(payload["request"])
    if payload["mode"] == "positive":
        result = positive(payload["configs"], payload["request"], payload["groups"], Actor, GraphId)
    else:
        result = negative(payload["configs"][payload["mode"]], payload["request"], Actor)
    return {"pid": os.getpid(), "bindingVersionReported": __version__, "result": result}


def launch(payload, timeout, runner=subprocess.run):
    process = runner([sys.executable, str(Path(__file__).resolve()), "--worker"],
                     input=json.dumps(payload), text=True, capture_output=True, timeout=timeout)
    require(process.returncode == 0, f"Native worker failed: {process.stderr[-4000:]}")
    receipts = [line.removeprefix("CROSSING_RECEIPT=") for line in process.stdout.splitlines()
                if line.startswith("CROSSING_RECEIPT=")]
    require(len(receipts) == 1, "Missing or ambiguous worker receipt")
    return json.loads(receipts[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("request", "partition-receipt", "unsplit", "union", "first", "second"):
        parser.add_argument(f"--{key}", required=True)
    parser.add_argument("--source-facts", help="Optional caller-supplied JSON; not independently verified")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    require(math.isfinite(args.timeout) and args.timeout > 0, "Positive finite timeout required")
    configs = {key: read_json(getattr(args, key)) for key in ("unsplit", "union", "first", "second")}
    request, receipt = read_json(args.request), read_json(args.partition_receipt)
    check_request(request)
    groups = check_receipt(receipt, configs)
    payload = {"configs": configs, "request": request, "groups": {k: sorted(v) for k, v in groups.items()}}
    evidence = {}
    for mode in ("positive", "first", "second"):
        evidence[mode] = launch({**payload, "mode": mode}, args.timeout)
    # Recheck immutable staging after native calls as well as before them.
    check_receipt(receipt, configs)
    print(json.dumps({"schemaVersion": 1, "scope": "host-local-pack-crossing-not-national-border-or-device-proof",
                      "inputs": vars(args), "evidence": evidence,
                      "sourceFactsUnverified": read_json(args.source_facts) if args.source_facts else None,
                      "networkIsolation": "must be enforced externally; local graph config checked"}, sort_keys=True))


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--worker"]:
            print("CROSSING_RECEIPT=" + json.dumps(worker(json.load(sys.stdin))))
        else:
            main()
    except Exception as error:
        print(f"Crossing verification failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
