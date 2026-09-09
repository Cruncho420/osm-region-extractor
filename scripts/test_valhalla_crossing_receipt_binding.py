"""PURPOSE: Pin the exact graph receipt consumed by the native proof coordinator.
RESPONSIBILITY: Output digest and refusal of changed receipt bytes.
DEPENDENCIES: Mock native process results; exercises real coordinator main.
CONSUMERS: Producer unittest gate, not native crossing acceptance.
"""
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_verify_valhalla_crossing import proof


class ReceiptBindingTests(unittest.TestCase):
    def run_main(self, mutate=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, receipt = root / 'config.json', root / 'receipt.json'
            config.write_text('{}')
            raw = b'{ "graph": "exact-byte-proof" }\n'
            receipt.write_bytes(raw)
            argv = ['verify', '--request', str(config), '--partition-receipt', str(receipt)]
            for mode in ('first', 'second', 'union', 'unsplit'):
                argv.extend([f'--{mode}', str(config)])
            def launch(*_):
                if mutate:
                    receipt.write_text('{"graph":"substituted"}')
                return {'result': 'synthetic native result'}
            output = io.StringIO()
            with patch('sys.argv', argv), patch.object(proof, 'check_request'), \
                 patch.object(proof, 'check_receipt', return_value={}), \
                 patch.object(proof, 'launch', side_effect=launch), redirect_stdout(output):
                proof.main()
            return raw, json.loads(output.getvalue())

    def test_receipt_digest_covers_original_raw_bytes_not_reserialization(self):
        raw, result = self.run_main()
        self.assertEqual(result['partitionReceiptSha256'], hashlib.sha256(raw).hexdigest())

    def test_receipt_mutation_during_native_workers_prevents_proof_output(self):
        with self.assertRaisesRegex(ValueError, 'changed during native proof'):
            self.run_main(mutate=True)


if __name__ == '__main__':
    unittest.main()
