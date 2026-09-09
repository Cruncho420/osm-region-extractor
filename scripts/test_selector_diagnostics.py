"""PURPOSE: Preserve selector failure stages without retaining native coordinates.
RESPONSIBILITY: Worker errors, timeouts, crashes and success remain distinguishable.
DEPENDENCIES: stdlib; actual selector worker orchestration, no native graph execution.
CONSUMERS: unittest discovery and connected proof CI.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("selector_diagnostics", Path(__file__).with_name("select-valhalla-crossing.py"))
selector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(selector)


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "diagnostics.json"

    def test_native_fault_keeps_stage_and_counts_but_not_exception_text(self):
        def operation(payload, report):
            report("locate", pack=1, sample=7, located=2)
            raise RuntimeError("sensitive native coordinates 51.234567,-1.234567")

        def runner(command, **kwargs):
            payload = json.loads(kwargs["input"])
            with self.assertRaises(RuntimeError):
                selector.native_worker(payload, operation)
            return subprocess.CompletedProcess(command, 1, "private stdout", "private stderr")

        with self.assertRaises(ValueError):
            selector.run_worker({}, 1, runner, self.output)
        text = self.output.read_text()
        report = json.loads(text)
        self.assertEqual(report["stage"], "locate")
        self.assertEqual(report["counts"], {"pack": 1, "sample": 7, "located": 2})
        self.assertEqual(report["errorType"], "RuntimeError")
        self.assertEqual(report["returnCode"], 1)
        self.assertEqual(report["status"], "failed")
        self.assertNotIn("51.234567", text)
        self.assertNotIn("private", text)
        self.assertTrue(all(set(frame) == {"file", "line"} for frame in report["frames"]))

    def test_exhaustion_is_distinct_from_native_fault(self):
        def operation(payload, report):
            report("route-pairs", firstCandidates=0, secondCandidates=4, pairs=0)
            return selector.choose_route(object(), [], [object()], {}, object, 1)

        def runner(command, **kwargs):
            with self.assertRaises(ValueError):
                selector.native_worker(json.loads(kwargs["input"]), operation)
            return subprocess.CompletedProcess(command, 1, "", "")

        with self.assertRaises(ValueError):
            selector.run_worker({}, 1, runner, self.output)
        self.assertEqual(json.loads(self.output.read_text())["code"], "candidate-exhausted")

    def test_timeout_retains_last_progress_without_worker_completion(self):
        def runner(command, **kwargs):
            payload = json.loads(kwargs["input"])
            _, report = selector.worker_diagnostics(Path(payload["diagnostic"]))
            report("route-pairs", pair=9, pairs=32)
            raise subprocess.TimeoutExpired(command, kwargs["timeout"], output="private")

        with self.assertRaises(subprocess.TimeoutExpired):
            selector.run_worker({}, 2, runner, self.output)
        report = json.loads(self.output.read_text())
        self.assertEqual(report["status"], "timeout")
        self.assertEqual(report["stage"], "route-pairs")
        self.assertEqual(report["counts"]["pair"], 9)
        self.assertEqual(report["timeoutSeconds"], 2)

    def test_native_crash_never_leaves_status_running(self):
        def runner(command, **kwargs):
            payload = json.loads(kwargs["input"])
            _, report = selector.worker_diagnostics(Path(payload["diagnostic"]))
            report("actor-init")
            return subprocess.CompletedProcess(command, -11, "", "")

        with self.assertRaises(ValueError):
            selector.run_worker({}, 1, runner, self.output)
        report = json.loads(self.output.read_text())
        self.assertEqual((report["status"], report["stage"], report["returnCode"]),
                         ("failed", "actor-init", -11))

    def test_success_retains_real_result_and_success_receipt(self):
        expected = {"scope": "unit-worker", "request": {"locations": []}}
        def runner(command, **kwargs):
            selector.native_worker(json.loads(kwargs["input"]), lambda payload, report: expected)
            return subprocess.CompletedProcess(command, 0, "", "")

        self.assertEqual(selector.run_worker({}, 1, runner, self.output), expected)
        self.assertEqual(json.loads(self.output.read_text())["status"], "success")

    def test_missing_result_cannot_borrow_worker_success(self):
        def runner(command, **kwargs):
            payload = json.loads(kwargs["input"])
            state, report = selector.worker_diagnostics(Path(payload["diagnostic"]))
            state["status"] = "success"
            report("inventory-recheck")
            return subprocess.CompletedProcess(command, 0, "", "")

        with self.assertRaises(ValueError):
            selector.run_worker({}, 1, runner, self.output)
        self.assertEqual(json.loads(self.output.read_text())["status"], "failed")


if __name__ == "__main__":
    unittest.main()
