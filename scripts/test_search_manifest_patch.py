"""search_manifest_patch.py: adds only searchSize/searchChecksum, refuses anything else.
Run: python3 -m unittest discover -s scripts -p 'test_search_manifest_patch.py'"""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('smp', Path(__file__).with_name('search_manifest_patch.py'))
smp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smp)

LIVE = {'version': '2026-09-02', 'generatedAt': '2026-09-02T16:07:25.205Z', 'valhallaPackTag': 'valhalla-2026-09-02',
        'regions': {'europe-malta': {'name': 'Malta', 'size': 1, 'checksum': 'a' * 16, 'sqliteSize': 2, 'sqliteChecksum': 'b' * 16},
                    'europe-estonia': {'name': 'Estonia', 'size': 3, 'checksum': 'c' * 16, 'sqliteSize': 4, 'sqliteChecksum': 'd' * 16,
                                       'searchSize': 9, 'searchChecksum': 'e' * 16}}}


class Patch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def file(self, region, data=b'gz bytes'):
        p = self.dir / f'{region}-search.sqlite.gz'
        p.write_bytes(data)
        return p

    def test_adds_fields_and_keeps_everything_else(self):
        out, done = smp.patch(LIVE, {'europe-malta': self.file('europe-malta')})
        self.assertEqual(done, {'europe-malta'})
        self.assertEqual(out['regions']['europe-malta']['searchSize'], 8)
        self.assertEqual(out['regions']['europe-malta']['searchChecksum'], hashlib.sha256(b'gz bytes').hexdigest()[:16])
        # untouched: top level, other fields, and a region the run did not rebuild keeps its old entry
        for k in ('version', 'generatedAt', 'valhallaPackTag'):
            self.assertEqual(out[k], LIVE[k])
        self.assertEqual(out['regions']['europe-estonia'], LIVE['regions']['europe-estonia'])
        self.assertEqual(smp.without_search(out), smp.without_search(LIVE))
        self.assertNotIn('searchSize', LIVE['regions']['europe-malta'])  # input not mutated

    def test_refuses_unknown_region(self):
        with self.assertRaises(ValueError):
            smp.patch(LIVE, {'europe-nowhere': self.file('europe-nowhere')})

    def test_refuses_empty_file(self):
        with self.assertRaises(ValueError):
            smp.patch(LIVE, {'europe-malta': self.file('europe-malta', b'')})

    def test_cli_writes_manifest(self):
        self.file('europe-malta')
        live = self.dir / 'live.json'
        live.write_text(json.dumps(LIVE))
        smp.main(['--manifest', str(live), '--dir', str(self.dir), '--out', str(self.dir / 'm.json')])
        out = json.loads((self.dir / 'm.json').read_text())
        self.assertEqual(list(out['regions']), list(LIVE['regions']))  # order kept
        self.assertEqual(out['regions']['europe-malta']['searchSize'], 8)


if __name__ == '__main__':
    unittest.main()
