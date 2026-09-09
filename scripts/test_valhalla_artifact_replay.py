"""PURPOSE: Verify pinned artifact replay orchestration with real tiny archives.
RESPONSIBILITY: Source authentication, exact reconstruction, strict fresh/prior binding.
DEPENDENCIES: stdlib, synthetic descriptor fixtures; no native execution claimed.
CONSUMERS: Fixed artifact replay workflow gate.
"""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_build_valhalla_install_descriptor as descriptor_fixtures

spec = importlib.util.spec_from_file_location('replay', Path(__file__).with_name('replay-valhalla-connected-artifacts.py'))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class ArtifactReplayTests(unittest.TestCase):
    def setUp(self):
        fixture = descriptor_fixtures.DescriptorTests('test_identical_inputs_emit_identical_descriptor')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.prior, self.receipts = fixture.root, fixture.evidence, fixture.receipts
        self.output = self.root / 'replay'
        self.run = {'id': 1, 'head_sha': 'a' * 40, 'conclusion': 'success', 'event': 'workflow_dispatch'}
        raw = {name: replay.descriptor.encode(data) for name, data in self.receipts.items()}
        raw.update({f'{country}.poly': (self.prior / f'{country}.poly').read_bytes() for country in ('lithuania', 'latvia')})
        raw['workflow-source.txt'] = (self.run['head_sha'] + '\n').encode()
        raw['crossing-request.json'] = b'{"costing":"auto"}\n'
        raw['configs/unsplit.json'] = b'{"mjolnir":{"tile_dir":"/proof/source","tile_extract":"","global_synchronized_cache":false}}\n'
        for name, data in raw.items():
            path = self.prior / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
        self.pins = {'runId': 1, 'sourceSha': self.run['head_sha'],
                     'files': {name: replay.descriptor.pin(data) for name, data in raw.items()}}

    def prepare(self):
        return replay.prepare(self.prior, self.root, self.output, self.run, self.pins)

    def fresh(self):
        self.prepare()
        evidence = self.output / 'evidence'
        current = copy.deepcopy(self.receipts['offline-crossing.json'])
        current['partitionReceiptSha256'] = self.pins['files']['partition-integrity.json']['sha256']
        (evidence / 'offline-crossing.json').write_bytes(replay.descriptor.encode(current))
        (evidence / 'replay-toolchain-source.json').write_bytes(replay.descriptor.encode({'coreSha': replay.descriptor.CORE}))
        (evidence / 'replay-native-sha256.txt').write_text('recorded-test-native-pin\n')
        return evidence

    def test_exact_graph_and_original_proof_are_retained_with_honest_scope(self):
        report = self.prepare()
        evidence = self.output / 'evidence'
        self.assertEqual(report['scope'], replay.SCOPE)
        self.assertEqual((evidence / 'prior-offline-crossing.json').read_bytes(), (self.prior / 'offline-crossing.json').read_bytes())
        for mode in ('unsplit', 'union'):
            config = json.loads((self.output / 'configs' / f'{mode}.json').read_text())
            self.assertEqual(config['mjolnir']['tile_dir'], '/proof/reconstructed/union')
        receipt = json.loads((evidence / 'reconstruction.json').read_text())
        self.assertEqual(receipt['union']['tiles'], self.receipts['partition-integrity.json']['unsplit']['tiles'])

    def test_source_identity_mismatch_fails_before_output(self):
        for key, value in [('id', 2), ('head_sha', 'b' * 40), ('conclusion', 'failure'), ('event', 'push')]:
            run = {**self.run, key: value}
            with self.assertRaisesRegex(ValueError, 'Wrong source'):
                replay.prepare(self.prior, self.root, self.output, run, self.pins)
            self.assertFalse(self.output.exists())

    def test_raw_prior_substitution_fails_before_output(self):
        (self.prior / 'offline-crossing.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'pin mismatch'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_changed_archive_fails_before_output(self):
        archive = self.root / 'first.tar.gz'
        raw = bytearray(archive.read_bytes()); raw[-1] ^= 1; archive.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, 'Archive pin mismatch'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_overwritten(self):
        self.output.mkdir(); (self.output / 'sentinel').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'Output must be new'):
            self.prepare()
        self.assertEqual((self.output / 'sentinel').read_text(), 'keep')

    def test_substituted_reconstruction_cannot_become_source(self):
        bad = json.loads(json.dumps(self.receipts['reconstruction.json']))
        bad['union']['tiles'][0]['sha256'] = '0' * 64
        with patch.object(replay.reconstruct, 'reconstruct', return_value=bad):
            with self.assertRaisesRegex(ValueError, 'Union differs'):
                self.prepare()

    def test_fresh_proof_and_prior_proof_both_enter_descriptor_provenance(self):
        evidence = self.fresh()
        output = self.root / 'contract'
        pin = replay.finish(evidence, self.root, output, self.pins)
        raw = (output / 'install-descriptor.json').read_bytes()
        self.assertEqual(pin, replay.descriptor.pin(raw))
        provenance = json.loads(raw)['provenance']
        for name in ('prior-offline-crossing.json', 'offline-crossing.json', 'artifact-replay.json',
                     'replay-toolchain-source.json', 'replay-native-sha256.txt'):
            self.assertEqual(provenance[name], replay.descriptor.pin((evidence / name).read_bytes()))

    def test_unbound_fresh_receipt_is_rejected(self):
        evidence = self.fresh()
        current = json.loads((evidence / 'offline-crossing.json').read_text())
        current.pop('partitionReceiptSha256')
        (evidence / 'offline-crossing.json').write_bytes(replay.descriptor.encode(current))
        with self.assertRaisesRegex(ValueError, 'unbound'):
            replay.finish(evidence, self.root, self.root / 'contract', self.pins)
        self.assertFalse((self.root / 'contract').exists())

    def test_consistent_fresh_route_drift_from_original_is_rejected(self):
        evidence = self.fresh()
        current = json.loads((evidence / 'offline-crossing.json').read_text())
        for modes in current['evidence']['positive']['result']['rounds'].values():
            for result in modes.values():
                result['legs'][0]['shape'] = 'different-from-original'
        (evidence / 'offline-crossing.json').write_bytes(replay.descriptor.encode(current))
        with self.assertRaisesRegex(ValueError, 'prior independent unsplit'):
            replay.finish(evidence, self.root, self.root / 'contract', self.pins)
        self.assertFalse((self.root / 'contract').exists())

    def test_wrong_replay_core_is_rejected(self):
        evidence = self.fresh()
        (evidence / 'replay-toolchain-source.json').write_text('{"coreSha":"wrong"}')
        with self.assertRaisesRegex(ValueError, 'Replay core differs'):
            replay.finish(evidence, self.root, self.root / 'contract', self.pins)

    def test_metadata_change_after_native_replay_is_rejected(self):
        evidence = self.fresh()
        (evidence / 'lithuania.poly').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Original metadata changed'):
            replay.finish(evidence, self.root, self.root / 'contract', self.pins)
        self.assertFalse((self.root / 'contract').exists())

    def test_same_nonpath_change_to_all_configs_is_rejected(self):
        evidence = self.fresh()
        for mode in ('unsplit', 'union', 'first', 'second'):
            path = evidence.parent / 'configs' / f'{mode}.json'
            value = json.loads(path.read_text())
            value['mjolnir']['new-setting'] = True
            path.write_bytes(replay.descriptor.encode(value))
        with self.assertRaisesRegex(ValueError, 'Replay configuration changed'):
            replay.finish(evidence, self.root, self.root / 'contract', self.pins)
        self.assertFalse((self.root / 'contract').exists())
