#!/usr/bin/env python3
"""PURPOSE: Replay a fixed successful proof's exact graph bytes without rebuilding its graph.
RESPONSIBILITY: Authenticate prior raw artifacts, reconstruct, bind fresh native evidence to prior proof.
DEPENDENCIES: stdlib, existing strict archive/checker/descriptor helpers.
CONSUMERS: valhalla-connected-replay.yml; never a release publisher.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


descriptor = load('build-valhalla-install-descriptor')
reconstruct = load('reconstruct-valhalla-proof-packs')
proof = load('verify-valhalla-crossing')
require = descriptor.require
PINS = json.loads(Path(__file__).with_name('valhalla-connected-replay-pins.json').read_text())
SCOPE = 'authenticated-reconstructed-union-replay-with-prior-independent-unsplit-proof'


def pinned_inputs(prior, run, pins=PINS):
    require(run['id'] == pins['runId'] and run['head_sha'] == pins['sourceSha']
            and run['conclusion'] == 'success' and run['event'] == 'workflow_dispatch', 'Wrong source run')
    raw = {name: descriptor.read(prior / name) for name in pins['files']}
    require(all(descriptor.pin(raw[name]) == expected for name, expected in pins['files'].items()),
            'Prior artifact pin mismatch')
    require(raw['workflow-source.txt'].decode().strip() == pins['sourceSha'], 'Wrong source workflow')
    integrity = json.loads(raw['partition-integrity.json'])
    descriptor.check_crossing(json.loads(raw['offline-crossing.json']), integrity)
    descriptor.checked_graph(integrity, json.loads(raw['reconstruction.json']))
    return raw


def prepare(prior, packs, output, run, pins=PINS):
    raw = pinned_inputs(prior, run, pins)
    require(not output.exists() and output.parent.resolve() == output.parent, 'Output must be new and real')
    original = json.loads(raw['reconstruction.json'])
    # Authenticate both compressed archives before creating or expanding anything.
    for slot in ('first', 'second'):
        descriptor.archive_pins(packs / f'{slot}.tar.gz', original[slot])
    output.mkdir()
    receipt = reconstruct.reconstruct(packs / 'first.tar.gz', packs / 'second.tar.gz', output / 'reconstructed')
    integrity = json.loads(raw['partition-integrity.json'])
    descriptor.checked_graph(integrity, receipt)
    evidence = output / 'evidence'
    evidence.mkdir()
    for name in ('partition-integrity.json', 'input-provenance.json', 'toolchain-source.json',
                 'lithuania.poly', 'latvia.poly', 'crossing-request.json'):
        (evidence / name).write_bytes(raw[name])
    (evidence / 'prior-offline-crossing.json').write_bytes(raw['offline-crossing.json'])
    (evidence / 'prior-unsplit-config.json').write_bytes(raw['configs/unsplit.json'])
    (evidence / 'reconstruction.json').write_bytes(descriptor.encode(receipt))
    source = {'schemaVersion': 1, 'scope': SCOPE, 'sourceRunId': pins['runId'],
              'sourceSha': pins['sourceSha'], 'sourcePins': pins['files'],
              'unsplitModeMeaning': 'reconstructed union; prior independent unsplit proof retained separately'}
    (evidence / 'artifact-replay-source.json').write_bytes(descriptor.encode(source))
    configs = output / 'configs'
    configs.mkdir()
    for mode in ('unsplit', 'union', 'first', 'second'):
        config = copy.deepcopy(json.loads(raw['configs/unsplit.json']))
        config['mjolnir']['tile_dir'] = '/proof/reconstructed/' + ('union' if mode == 'unsplit' else mode)
        (configs / f'{mode}.json').write_bytes(descriptor.encode(config))
    return source


def check_replay_configs(evidence, pins):
    raw = descriptor.read(evidence / 'prior-unsplit-config.json')
    require(descriptor.pin(raw) == pins['files']['configs/unsplit.json'], 'Original configuration changed')
    for mode in ('unsplit', 'union', 'first', 'second'):
        expected = json.loads(raw)
        expected['mjolnir']['tile_dir'] = '/proof/reconstructed/' + ('union' if mode == 'unsplit' else mode)
        actual = json.loads(descriptor.read(evidence.parent / 'configs' / f'{mode}.json'))
        require(descriptor.encode(actual) == descriptor.encode(expected), 'Replay configuration changed')


def finish(evidence, packs, output, pins=PINS):
    check_replay_configs(evidence, pins)
    # Metadata stays pinned across the native subprocess, not merely at initial
    # reconstruction. Never let a later paired polygon/provenance edit self-consist.
    for name in ('input-provenance.json', 'toolchain-source.json', 'lithuania.poly',
                 'latvia.poly', 'crossing-request.json'):
        require(descriptor.pin(descriptor.read(evidence / name)) == pins['files'][name],
                'Original metadata changed')
    raw_prior = descriptor.read(evidence / 'prior-offline-crossing.json')
    require(descriptor.pin(raw_prior) == pins['files']['offline-crossing.json'], 'Prior proof changed')
    raw_partition = descriptor.read(evidence / 'partition-integrity.json')
    require(descriptor.pin(raw_partition) == pins['files']['partition-integrity.json'], 'Original inventory changed')
    current = json.loads(descriptor.read(evidence / 'offline-crossing.json'))
    require(current.get('partitionReceiptSha256') == descriptor.pin(raw_partition)['sha256'], 'Fresh native receipt unbound')
    integrity = json.loads(raw_partition)
    descriptor.check_crossing(current, integrity)
    prior = json.loads(raw_prior)
    descriptor.check_crossing(prior, integrity)
    legs = lambda value: value['evidence']['positive']['result']['rounds']['cold']['unsplit']['legs']
    require(legs(current) == legs(prior), 'Replay differs from prior independent unsplit route')
    source = json.loads(descriptor.read(evidence / 'artifact-replay-source.json'))
    require(source['scope'] == SCOPE and source['sourcePins'] == pins['files']
            and source['sourceRunId'] == pins['runId'] and source['sourceSha'] == pins['sourceSha'], 'Replay provenance changed')
    toolchain = json.loads(descriptor.read(evidence / 'replay-toolchain-source.json'))
    require(toolchain['coreSha'] == descriptor.CORE, 'Replay core differs')
    source['freshProofPin'] = descriptor.pin(descriptor.read(evidence / 'offline-crossing.json'))
    source['replayToolchainPin'] = descriptor.pin(descriptor.read(evidence / 'replay-toolchain-source.json'))
    source['replayNativePin'] = descriptor.pin(descriptor.read(evidence / 'replay-native-sha256.txt'))
    (evidence / 'artifact-replay.json').write_bytes(descriptor.encode(source))
    return descriptor.build(evidence, packs, output, replay=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'finish'))
    for name in ('prior', 'run', 'packs', 'output', 'evidence'):
        parser.add_argument('--' + name, type=Path)
    args = parser.parse_args()
    if args.mode == 'prepare':
        result = prepare(args.prior, args.packs, args.output, json.loads(args.run.read_text()))
    else:
        result = finish(args.evidence, args.packs, args.output)
    print(json.dumps(result, sort_keys=True))
