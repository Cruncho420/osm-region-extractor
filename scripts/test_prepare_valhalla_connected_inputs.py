"""PURPOSE: Exercise actual osmium input/merge failures on tiny road fixtures.
RESPONSIBILITY: Snapshot, ordering, version and missing-reference refusal.
DEPENDENCIES: stdlib and real osmium CLI; no Valhalla bindings or graph claims.
CONSUMERS: unittest discovery and connected-proof CI.
"""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("inputs", Path(__file__).with_name("prepare-valhalla-connected-inputs.py"))
inputs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inputs)
STAMP = "2026-09-07T20:21:20Z"


@unittest.skipUnless(shutil.which("osmium"), "Real osmium CLI required")
class InputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def pbf(self, name, ids=(1, 2), stamp=STAMP, missing=False, versions=False):
        nodes = "".join(f'<node id="{n}" version="1" lat="55" lon="24"/>' for n in ids)
        if versions:
            nodes += f'<node id="{ids[-1]}" version="2" lat="55" lon="24"/>'
        xml = '<osm version="0.6">' + nodes
        xml += f'<way id="{10 + ids[-1]}" version="1"><nd ref="{ids[0]}"/>'
        xml += f'<nd ref="{999 if missing else ids[-1]}"/><tag k="highway" v="residential"/></way></osm>'
        source, result = self.root / f"{name}.osm", self.root / f"{name}.pbf"
        source.write_text(xml)
        subprocess.run(["osmium", "cat", str(source), "-o", str(result),
                        f"--output-header=osmosis_replication_timestamp={stamp}"], check=True,
                       capture_output=True)
        return result

    def merge(self, a, b):
        return inputs.validate_and_merge(a, b, self.root / "merged.pbf", self.root)

    def test_real_merge_deduplicates_shared_objects_and_preserves_snapshot(self):
        result = self.merge(self.pbf("a"), self.pbf("b", ids=(1, 3)))
        self.assertEqual(result["merged"]["data"]["count"]["nodes"], 3)
        self.assertEqual(result["replicationTimestamp"], STAMP)
        self.assertEqual(result["referenceChecks"]["wayNodes"]["exitCode"], 0)
        self.assertEqual(len(result["mergedSha256"]), 64)

    def test_different_snapshots_refused_before_merge(self):
        with self.assertRaisesRegex(ValueError, "timestamps differ"):
            self.merge(self.pbf("a"), self.pbf("b", stamp="2026-09-06T20:21:20Z"))
        self.assertFalse((self.root / "merged.pbf").exists())

    def test_missing_way_node_refused(self):
        with self.assertRaisesRegex(ValueError, "missing nodes"):
            self.merge(self.pbf("a", missing=True), self.pbf("b", ids=(1, 3)))
        self.assertTrue((self.root / "check-refs-wayNodes.txt").is_file())

    def test_unordered_input_refused(self):
        with self.assertRaisesRegex(ValueError, "not ordered"):
            inputs.file_info(self.pbf("a", ids=(2, 1)))

    def test_multiple_input_versions_refused(self):
        with self.assertRaisesRegex(ValueError, "Multiple object versions"):
            inputs.file_info(self.pbf("a", versions=True))

    def test_conflicting_versions_between_inputs_refused_after_merge(self):
        a = self.pbf("a")
        source = self.root / "b.osm"
        source.write_text((self.root / "a.osm").read_text().replace('version="1"', 'version="2"'))
        b = self.root / "b.pbf"
        subprocess.run(["osmium", "cat", str(source), "-o", str(b),
                        f"--output-header=osmosis_replication_timestamp={STAMP}"], check=True,
                       capture_output=True)
        with self.assertRaisesRegex(ValueError, "Multiple object versions"):
            self.merge(a, b)

    def test_existing_output_not_overwritten(self):
        target = self.root / "merged.pbf"
        target.write_bytes(b"retained")
        with self.assertRaises(subprocess.CalledProcessError):
            self.merge(self.pbf("a"), self.pbf("b", ids=(1, 3)))
        self.assertEqual(target.read_bytes(), b"retained")


if __name__ == "__main__":
    unittest.main()
