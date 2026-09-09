"""PURPOSE: Verify descriptor bytes, archive pins and refusal of inconsistent proof inputs.
RESPONSIBILITY: Contract tests with synthetic receipts; not native crossing evidence.
DEPENDENCIES: Standard library and existing real gzip/tar fixture writer.
CONSUMERS: Producer unittest gate.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from test_reconstruct_valhalla_proof_packs import write_archive, regular, proof as reconstruct

SPEC = importlib.util.spec_from_file_location('descriptor', Path(__file__).with_name('build-valhalla-install-descriptor.py'))
descriptor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(descriptor)


class DescriptorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir()
        self.output = self.root / 'out'
        self.first, self.second = self.root / 'first.tar.gz', self.root / 'second.tar.gz'
        write_archive(self.first, [regular('index.bin'), regular('2/000/001.gph'), regular('0/000/003.gph')])
        write_archive(self.second, [regular('index.bin'), regular('2/000/002.gph'), regular('0/000/003.gph')])
        receipt = reconstruct.reconstruct(self.first, self.second, self.root / 'reconstructed')
        union = receipt['union']['tiles']
        graph = descriptor.inventory_digest(descriptor.records(union))
        self.receipts = {
            'reconstruction.json': receipt,
            'partition-integrity.json': {'schemaVersion': 1, 'scope': 'unchanged-tile-union-only',
                'unsplit': {'tiles': union, 'sha256': graph}, 'union': {'tiles': union},
                'first': {'tiles': receipt['first']['tiles']}, 'second': {'tiles': receipt['second']['tiles']}},
            'toolchain-source.json': {'coreSha': descriptor.CORE},
            'input-provenance.json': {'downloads': {}},
            'offline-crossing.json': {'schemaVersion': 1,
                'scope': 'host-local-pack-crossing-not-national-border-or-device-proof',
                'evidence': {'positive': {'result': {'actorsConstructed': 2, 'rounds': {'cold': {}, 'warm': {}},
                    'usedOwnership': {'firstOnly': ['2/000/001.gph'], 'secondOnly': ['2/000/002.gph'], 'shared': ['0/000/003.gph']}}},
                    'first': {'result': {'rejected': True, 'codeFromPinnedMessage': 171}},
                    'second': {'result': {'rejected': True, 'codeFromPinnedMessage': 442}}}},
        }
        legs = [{'tilePaths': ['2/000/001.gph', '2/000/002.gph', '0/000/003.gph']}]
        self.receipts['offline-crossing.json']['evidence']['positive']['result']['rounds'] = {
            phase: {mode: {'legs': copy.deepcopy(legs)} for mode in ('unsplit', 'union')}
            for phase in ('cold', 'warm')}
        self.receipts['offline-crossing.json']['partitionReceiptSha256'] = descriptor.pin(
            descriptor.encode(self.receipts['partition-integrity.json']))['sha256']
        for country in ('lithuania', 'latvia'):
            raw = f'{country}\n1\n0 0\n1 0\n1 1\n0 0\nEND\nEND\n'.encode()
            (self.evidence / f'{country}.poly').write_bytes(raw)
            self.receipts['input-provenance.json']['downloads'][country] = {'polygon': descriptor.pin(raw)}

    def build(self):
        for name, value in self.receipts.items():
            (self.evidence / name).write_bytes(descriptor.encode(value))
        return descriptor.build(self.evidence, self.root, self.output)

    def test_exact_raw_sidecar_pins_and_no_local_archive_paths(self):
        pin = self.build()
        raw = (self.output / 'install-descriptor.json').read_bytes()
        self.assertEqual(pin, descriptor.pin(raw))
        value = json.loads(raw)
        self.assertNotIn(str(self.root), raw.decode())
        self.assertEqual([r['regionId'] for r in value['regions']], ['europe-lithuania', 'europe-latvia'])
        for region in value['regions']:
            for key in ('inventory', 'coverage'):
                asset = region[key]
                self.assertEqual(descriptor.pin((self.output / asset['file']).read_bytes()), {k: asset[k] for k in ('bytes', 'sha256')})
            inventory = json.loads((self.output / region['inventory']['file']).read_bytes())
            self.assertIn('index.bin', inventory)
            self.assertEqual(region['tar']['bytes'] % 512, 0)
        for name, expected in value['provenance'].items():
            self.assertEqual(descriptor.pin((self.output / name).read_bytes()), expected)

    def test_identical_inputs_emit_identical_descriptor(self):
        first = self.build()
        self.output = self.root / 'again'
        self.assertEqual(self.build(), first)

    def test_changed_archive_rejected_before_output(self):
        self.first.write_bytes(self.first.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'Archive pin mismatch'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_substituted_inventory_rejected(self):
        self.receipts['reconstruction.json']['first']['tiles'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_missing_or_failed_native_proof_rejected(self):
        for mode in ('first', 'second'):
            with self.subTest(mode=mode):
                self.receipts['offline-crossing.json']['evidence'][mode]['result']['rejected'] = False
                with self.assertRaises(ValueError):
                    self.build()
                self.receipts['offline-crossing.json']['evidence'][mode]['result']['rejected'] = True
        self.receipts['offline-crossing.json']['evidence']['positive']['result']['usedOwnership']['firstOnly'] = []
        with self.assertRaises(ValueError):
            self.build()

    def test_unsupported_core_and_changed_graph_digest_rejected(self):
        self.receipts['toolchain-source.json']['coreSha'] = '0' * 40
        with self.assertRaises(ValueError):
            self.build()
        self.receipts['toolchain-source.json']['coreSha'] = descriptor.CORE
        self.receipts['partition-integrity.json']['unsplit']['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.build()

    def test_polygon_substitution_rejected(self):
        (self.evidence / 'latvia.poly').write_text('substituted')
        with self.assertRaisesRegex(ValueError, 'Polygon provenance mismatch'):
            self.build()

    def test_native_mismatch_and_wrong_ownership_refused(self):
        positive = self.receipts['offline-crossing.json']['evidence']['positive']['result']
        positive['rounds']['warm']['union']['legs'] = []
        with self.assertRaisesRegex(ValueError, 'Native route mismatch'):
            self.build()
        positive['rounds']['warm']['union']['legs'] = positive['rounds']['cold']['union']['legs']
        positive['usedOwnership']['firstOnly'] = ['2/999/999.gph']
        with self.assertRaisesRegex(ValueError, 'Native ownership mismatch'):
            self.build()

    def test_old_native_proof_with_same_tile_paths_cannot_certify_changed_graph_bytes(self):
        self.receipts['partition-integrity.json']['unsplit']['tiles'][0]['sha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'different partition receipt'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_output_is_exclusive_and_preserves_existing_files(self):
        self.output.mkdir()
        sentinel = self.output / 'keep'
        sentinel.write_text('owned')
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(sentinel.read_text(), 'owned')

    def test_archive_and_receipt_symlinks_rejected(self):
        original = self.root / 'original.gz'
        self.first.rename(original)
        self.first.symlink_to(original)
        with self.assertRaises(ValueError):
            self.build()

    def test_duplicate_or_unsafe_tile_members_rejected(self):
        for path in ('../escape', 'index.bin', '2/000/001.gph'):
            with self.subTest(path=path):
                values = copy.deepcopy(self.receipts['reconstruction.json']['first']['tiles'])
                values.append({'path': path, 'bytes': 1, 'sha256': 'a' * 64})
                with self.assertRaises(ValueError):
                    descriptor.records(values)


if __name__ == '__main__':
    unittest.main()
