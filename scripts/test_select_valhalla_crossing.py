"""PURPOSE: Exercise bounded selection logic without native graph execution.
RESPONSIBILITY: Geometry/correlation filtering, evidence acceptance and timeouts.
DEPENDENCIES: stdlib, optional real Shapely; native bindings are fakes.
CONSUMERS: unittest discovery.
"""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("selector", Path(__file__).with_name("select-valhalla-crossing.py"))
selector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(selector)
PATHS = ["2/000/001.gph", "2/000/002.gph", "0/000/003.gph"]
GROUPS = {"firstOnly": {PATHS[0]}, "secondOnly": {PATHS[1]}, "shared": {PATHS[2]}}
POINTS = [{"lat": 0.1, "lon": 0.1, "search_cutoff": 100},
          {"lat": 0.1, "lon": 1.1, "search_cutoff": 100}]


class GraphId:
    def __init__(self, tile, level=2, index=0):
        self.tile, self._level = tile, level

    def is_valid(self):
        return True

    def level(self):
        return self._level

    def __fspath__(self):
        return f"{self._level}/000/{self.tile:03}.gph"


def geometry(test):
    try:
        from shapely.geometry import Point, box
        return Point, box
    except ImportError:
        test.skipTest("Real Shapely unavailable; no geometry acceptance claimed")


class SelectorTests(unittest.TestCase):
    def test_candidates_are_bounded_exclusive_and_country_clipped(self):
        point, box = geometry(self)
        country = box(0, 0, 0.2, 0.2).difference(box(0.05, 0.05, 0.15, 0.15))
        bindings = {"graph_id": GraphId, "base": lambda gid: (0, 0), "point": point, "box": box}
        result = selector.candidates([PATHS[0]], country, box(1, 0, 2, 1), bindings, 5)
        self.assertEqual(len(result), 5)
        self.assertTrue(all(p["tile"] == PATHS[0] and country.contains(point(p["lon"], p["lat"])) for p in result))

    def test_closer_border_tile_is_prioritized(self):
        point, box = geometry(self)
        bindings = {"graph_id": GraphId, "base": lambda gid: (gid.tile - 1, 0), "point": point, "box": box}
        result = selector.candidates(PATHS[:2], box(0, 0, 2, 1), box(2, 0, 3, 1), bindings, 1)
        self.assertEqual(result[0]["tile"], PATHS[1])

    def test_only_close_correlations_in_same_tile_and_country_survive(self):
        point, box = geometry(self)
        class Actor:
            def locate(self, request):
                return [{"edges": [{"correlated_lat": 0.1, "correlated_lon": 0.10001}]}]
        sample = {**POINTS[0], "tile": PATHS[0]}
        bindings = {"point": point, "at": lambda level, coord: GraphId(1)}
        result = selector.locate_candidates(Actor(), [sample], box(0, 0, 1, 1), bindings, 100)
        self.assertEqual(len(result), 1)
        self.assertEqual(selector.locate_candidates(Actor(), [sample], box(2, 2, 3, 3), bindings, 100), [])
        bindings["at"] = lambda level, coord: GraphId(2)
        self.assertEqual(selector.locate_candidates(Actor(), [sample], box(0, 0, 1, 1), bindings, 100), [])
        bindings["at"] = lambda level, coord: GraphId(1)
        sample["lat"] = 0.2
        self.assertEqual(selector.locate_candidates(Actor(), [sample], box(0, 0, 1, 1), bindings, 100), [])

    def test_native_path_ownership_required_and_request_frozen(self):
        evidence = {"legs": [{"tilePaths": PATHS}], "routeMs": 3}
        with patch.object(selector.proof, "snapshot", return_value=evidence) as capture:
            result = selector.choose_route(object(), POINTS[:1], POINTS[1:], GROUPS, GraphId, 1)
        self.assertEqual(result["request"]["locations"], POINTS)
        self.assertEqual(result["pairsAttempted"], 1)
        self.assertEqual(capture.call_count, 1)

    def test_native_null_edges_contract_continues_candidate_search(self):
        point, box = geometry(self)
        class Actor:
            calls = 0
            def locate(self, request):
                self.calls += 1
                if self.calls == 1:
                    return [{"edges": None, "nodes": None}]
                return [{"edges": [{"correlated_lat": 0.1, "correlated_lon": 0.10001}]}]
        sample = {**POINTS[0], "tile": PATHS[0]}
        bindings = {"point": point, "at": lambda level, coord: GraphId(1)}
        actor = Actor()
        result = selector.locate_candidates(actor, [sample, sample], box(0, 0, 1, 1), bindings, 100)
        self.assertEqual(actor.calls, 2)
        self.assertEqual(len(result), 1)

    def test_malformed_locate_edges_still_fail_closed(self):
        point, box = geometry(self)
        for response in ([{}], [{"edges": "not-a-list"}], [{"edges": [None]}]):
            class Actor:
                def locate(self, request):
                    return response
            with self.assertRaises(ValueError):
                selector.locate_candidates(Actor(), [{**POINTS[0], "tile": PATHS[0]}],
                                           box(0, 0, 1, 1), {"point": point}, 100)

    def test_missing_exclusive_exhausts_and_foreign_path_fails(self):
        for paths, message in ((PATHS[:1], "exhausted"), (["2/000/099.gph"], "outside")):
            with patch.object(selector.proof, "snapshot", return_value={"legs": [{"tilePaths": paths}]}):
                with self.assertRaisesRegex(ValueError, message):
                    selector.choose_route(object(), POINTS[:1], POINTS[1:], GROUPS, GraphId, 1)

    def test_only_known_native_route_errors_allow_another_pair(self):
        for error, expected in ((RuntimeError("No suitable edges near location"), ValueError),
                                (RuntimeError("native failure"), RuntimeError),
                                (ValueError("shape mismatch"), ValueError)):
            with patch.object(selector.proof, "snapshot", side_effect=error):
                with self.assertRaises(expected):
                    selector.choose_route(object(), POINTS[:1], POINTS[1:], GROUPS, GraphId, 1)

    def test_pair_limit_and_empty_candidates_fail(self):
        with patch.object(selector.proof, "snapshot", return_value={"legs": [{"tilePaths": PATHS[:1]}]}) as capture:
            with self.assertRaises(ValueError):
                selector.choose_route(object(), POINTS, POINTS, GROUPS, GraphId, 2)
            self.assertEqual(capture.call_count, 2)
        with self.assertRaisesRegex(ValueError, "exhausted"):
            selector.choose_route(object(), [], POINTS, GROUPS, GraphId, 2)

    def test_worker_timeout_does_not_accept_a_fixture(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])
        with self.assertRaises(subprocess.TimeoutExpired):
            selector.run_worker({}, 0.01, timeout)


if __name__ == "__main__":
    unittest.main()
