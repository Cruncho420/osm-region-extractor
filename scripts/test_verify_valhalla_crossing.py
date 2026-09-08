"""PURPOSE: Test proof-checker logic without claiming native graph execution.
RESPONSIBILITY: Fake-binding refusals, persistence, timeouts and filesystem receipts.
DEPENDENCIES: Python standard library only.
CONSUMERS: python3 -m unittest discover -s scripts -p 'test_verify_valhalla_crossing.py'.
"""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location("crossing", Path(__file__).with_name("verify-valhalla-crossing.py"))
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)
PATHS = ["2/001/001.gph", "2/002/002.gph", "0/003.gph"]
GROUPS = dict(zip(("firstOnly", "secondOnly", "shared"), ([p] for p in PATHS)))
REQUEST = {"costing": "auto", "locations": [{"lat": 1, "lon": 2, "search_cutoff": 100},
                                                {"lat": 3, "lon": 4, "search_cutoff": 100}]}


class FakeGraphId:
    def __init__(self, value):
        self.value = value

    def tile_base(self):
        return self

    def __fspath__(self):
        return PATHS[self.value]


class FakeActor:
    def __init__(self, config):
        self.config = config
        self.calls = 0

    def route(self, request):
        self.calls += 1
        return {"trip": {"status": 0, "legs": [{"shape": "polyline", "summary": {"length": 12, "time": 20}}]}}

    def trace_attributes(self, request):
        assert request["shape_match"] == "edge_walk"
        return {"shape": "polyline", "edges": [{"id": i} for i in range(3)]}


class CrossingTests(unittest.TestCase):
    def test_same_actors_reused_and_ownership_proven(self):
        actors = []

        def factory(config):
            actor = FakeActor(config)
            actors.append(actor)
            return actor

        result = proof.positive({"unsplit": {}, "union": {}}, REQUEST, GROUPS, factory, FakeGraphId)
        self.assertEqual([a.calls for a in actors], [2, 2])
        self.assertEqual(result["usedOwnership"], GROUPS)

    def test_shape_mismatch_refused(self):
        class Bad(FakeActor):
            def trace_attributes(self, request):
                return {"shape": "different", "edges": [{"id": 0}]}
        with self.assertRaisesRegex(ValueError, "shape differs"):
            proof.snapshot(Bad({}), REQUEST, FakeGraphId)

    def test_warm_route_drift_refused(self):
        class Bad(FakeActor):
            def route(self, request):
                result = super().route(request)
                result["trip"]["legs"][0]["summary"]["time"] += self.calls
                return result
        with self.assertRaisesRegex(ValueError, "mismatch"):
            proof.positive({"unsplit": {}, "union": {}}, REQUEST, GROUPS, Bad, FakeGraphId)

    def test_ordered_edge_mismatch_refused(self):
        class Bad(FakeActor):
            def trace_attributes(self, request):
                result = super().trace_attributes(request)
                if self.config.get("reverse"):
                    result["edges"].reverse()
                return result
        with self.assertRaisesRegex(ValueError, "mismatch"):
            proof.positive({"unsplit": {}, "union": {"reverse": True}}, REQUEST, GROUPS, Bad, FakeGraphId)

    def test_missing_exclusive_or_foreign_paths_refused(self):
        for replacement, message in (([], "exclusive"), (["2/009.gph"], "outside")):
            groups = copy.deepcopy(GROUPS)
            groups["firstOnly"] = replacement
            with self.assertRaisesRegex(ValueError, "outside|exclusive"):
                proof.positive({"unsplit": {}, "union": {}}, REQUEST, groups, FakeActor, FakeGraphId)

    def test_strict_known_route_errors_only(self):
        for message, code in proof.NO_ROUTE.items():
            class Missing(FakeActor):
                def route(self, request):
                    raise RuntimeError(message)
            self.assertEqual(proof.negative({}, REQUEST, Missing)["codeFromPinnedMessage"], code)
        for text in ("segmentation failure", "No path could be found for input EXTRA"):
            class Unknown(FakeActor):
                def route(self, request):
                    raise RuntimeError(text)
            with self.assertRaisesRegex(ValueError, "Unknown"):
                proof.negative({}, REQUEST, Unknown)

    def test_route_skipping_one_exclusive_pack_fails(self):
        class Missing(FakeActor):
            def trace_attributes(self, request):
                return {"shape": "polyline", "edges": [{"id": 0}, {"id": 2}]}
        with self.assertRaisesRegex(ValueError, "exclusive"):
            proof.positive({"unsplit": {}, "union": {}}, REQUEST, GROUPS, Missing, FakeGraphId)

    def test_constructor_errors_and_success_are_not_missing_pack_proof(self):
        def failed(config):
            raise RuntimeError("No suitable edges near location")
        with self.assertRaises(RuntimeError):
            proof.negative({}, REQUEST, failed)
        with self.assertRaisesRegex(ValueError, "unexpectedly succeeded"):
            proof.negative({}, REQUEST, FakeActor)

    def test_worker_timeout_crash_and_missing_receipt_fail(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])
        with self.assertRaises(subprocess.TimeoutExpired):
            proof.launch({}, 0.1, timeout)
        for code, output in ((1, ""), (0, "no receipt")):
            with self.assertRaises(ValueError):
                proof.launch({}, 1, lambda *a, **kw: SimpleNamespace(returncode=code, stdout=output, stderr="crash"))

    def test_worker_protocol_starts_new_process_for_every_call(self):
        calls = []
        def runner(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(returncode=0, stdout='CROSSING_RECEIPT={"result":{}}\n', stderr="")
        for mode in ("first", "second"):
            proof.launch({"mode": mode}, 1, runner)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(command[-1] == "--worker" for command in calls))

    def test_config_and_request_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = str(Path(directory).resolve())
            config = {"mjolnir": {"tile_dir": root, "global_synchronized_cache": False}}
            proof.local_config(config)
            for key, value in (("tile_url", "https://tiles"), ("tile_extract", "/tiles.tar"),
                               ("global_synchronized_cache", True)):
                bad = copy.deepcopy(config)
                bad["mjolnir"][key] = value
                with self.assertRaises(ValueError):
                    proof.local_config(bad)
        proof.check_request(REQUEST)
        bad = copy.deepcopy(REQUEST)
        del bad["locations"][0]["search_cutoff"]
        with self.assertRaises(ValueError):
            proof.check_request(bad)

    def test_non_path_configuration_mismatch_refused_before_graph_inspection(self):
        configs = {key: {"mjolnir": {"tile_dir": f"/unread/{key}", "global_synchronized_cache": False},
                         "loki": {"use_connectivity": True}}
                   for key in ("unsplit", "union", "first", "second")}
        original = copy.deepcopy(configs)
        proof.check_config_equivalence(configs)
        self.assertEqual(configs, original)
        for value in (False, 1):
            bad = copy.deepcopy(configs)
            bad["first"]["loki"]["use_connectivity"] = value
            with self.assertRaisesRegex(ValueError, "Non-path configuration mismatch: first"):
                proof.check_receipt({}, bad)

    def test_actual_inventory_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            configs, receipt = {}, {"scope": "unchanged-tile-union-only", **GROUPS}
            for key, names in (("unsplit", PATHS), ("union", PATHS),
                               ("first", [PATHS[0], PATHS[2]]), ("second", [PATHS[1], PATHS[2]])):
                root = Path(directory).resolve() / key
                for name in names:
                    member = root / name
                    member.parent.mkdir(parents=True, exist_ok=True)
                    member.write_bytes(name.encode())
                configs[key] = {"mjolnir": {"tile_dir": str(root), "global_synchronized_cache": False}}
                receipt[key] = {"tiles": proof.inspect_tiles(root)}
            proof.check_receipt(receipt, configs)
            (Path(configs["union"]["mjolnir"]["tile_dir"]) / PATHS[0]).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Actual union"):
                proof.check_receipt(receipt, configs)


if __name__ == "__main__":
    unittest.main()
