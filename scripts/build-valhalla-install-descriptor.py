#!/usr/bin/env python3
"""PURPOSE: Bind the connected proof packs to exact app-install sidecar bytes.
RESPONSIBILITY: Verify receipt consistency and archive bytes; emit pinned inventories and coverage.
DEPENDENCIES: Python stdlib and existing polygon parser; immutable producer inputs required.
CONSUMERS: Build-only proof workflow after native crossing success, never a release publisher.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

CORE = 'e2f017b16080f49203de245a211b09efab09cf72'
MAX_BYTES = 256 * 1024 ** 3
MAX_JSON = 512 * 1024 ** 2
MAX_RECORDS = 2_000_000
SPEC = importlib.util.spec_from_file_location('partition', Path(__file__).with_name('partition-valhalla-connected.py'))
partition = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(partition)


def require(value, message):
    if not value:
        raise ValueError(message)


def encode(value):
    return (json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def pin(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def read(path):
    path = Path(path).absolute()
    require(path.resolve() == path and path.is_file(), 'Input must be a regular non-symlink file')
    require(path.stat().st_size <= MAX_JSON, 'Oversized receipt')
    return path.read_bytes()


def records(values):
    require(isinstance(values, list) and 0 < len(values) < MAX_RECORDS, 'Invalid tile count')
    result = {}
    for item in values:
        name = item['path']
        require(re.fullmatch(r'[012]/(?:[0-9]{3}/){1,2}[0-9]{3}\.gph', name), 'Invalid tile path')
        require(name not in result, 'Duplicate tile path')
        require(type(item['bytes']) is int and 0 < item['bytes'] <= 1024 ** 3, 'Invalid tile size')
        require(re.fullmatch('[a-f0-9]{64}', item['sha256']), 'Invalid tile hash')
        result[name] = {'bytes': item['bytes'], 'sha256': item['sha256']}
    require(sum(t['bytes'] for t in result.values()) <= MAX_BYTES, 'Tile budget exceeded')
    return result


def inventory_digest(tiles):
    # Matches verify-valhalla-partitions.mjs's explicit path/bytes/sha256 order.
    ordered = [{'path': name, **tiles[name]} for name in sorted(tiles)]
    raw = json.dumps(ordered, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()


def checked_graph(integrity, reconstruction):
    require(integrity['schemaVersion'] == 1 and integrity['scope'] == 'unchanged-tile-union-only', 'Invalid graph receipt')
    require(reconstruction['schemaVersion'] == 1 and reconstruction['scope'] == 'archive-reconstruction-not-native-proof', 'Invalid reconstruction receipt')
    source = records(integrity['unsplit']['tiles'])
    graph = inventory_digest(source)
    require(graph == integrity['unsplit']['sha256'], 'Graph digest mismatch')
    union = {}
    for name in ('first', 'second'):
        tiles = records(reconstruction[name]['tiles'])
        require(tiles == records(integrity[name]['tiles']), 'Substituted pack inventory')
        for path, item in tiles.items():
            require(path not in union or union[path] == item, 'Conflicting overlap')
            union[path] = item
    require(union == source == records(integrity['union']['tiles']) == records(reconstruction['union']['tiles']), 'Union differs from connected graph')
    return graph


def check_crossing(value, integrity):
    require(value['schemaVersion'] == 1 and value['scope'] == 'host-local-pack-crossing-not-national-border-or-device-proof', 'Native crossing receipt required')
    evidence = value['evidence']
    positive = evidence['positive']['result']
    require(positive['actorsConstructed'] == 2 and set(positive['rounds']) == {'cold', 'warm'}, 'Missing warm/cold crossing evidence')
    require(all(positive['usedOwnership'][key] for key in ('firstOnly', 'secondOnly', 'shared')), 'Missing two-pack ownership evidence')
    baseline = positive['rounds']['cold']['unsplit']['legs']
    require(isinstance(baseline, list) and baseline, 'Missing native route legs')
    for phase in ('cold', 'warm'):
        for mode in ('unsplit', 'union'):
            require(positive['rounds'][phase][mode]['legs'] == baseline, 'Native route mismatch')
    used = {path for leg in baseline for path in leg['tilePaths']}
    first, second = (set(records(integrity[name]['tiles'])) for name in ('first', 'second'))
    groups = {'firstOnly': first - second, 'secondOnly': second - first, 'shared': first & second}
    require(used <= first | second, 'Native route uses foreign graph tile')
    require(all(set(positive['usedOwnership'][key]) == used & paths for key, paths in groups.items()), 'Native ownership mismatch')
    for name in ('first', 'second'):
        require(evidence[name]['result']['rejected'] is True, 'Missing-pack rejection evidence required')
        require(evidence[name]['result']['codeFromPinnedMessage'] in (170, 171, 442), 'Unknown missing-pack error')


def hash_stream(stream):
    digest, count = hashlib.sha256(), 0
    while chunk := stream.read(1024 * 1024):
        count += len(chunk)
        require(count <= MAX_BYTES, 'Archive exceeds budget')
        digest.update(chunk)
    require(count > 0, 'Empty archive')
    return {'bytes': count, 'sha256': digest.hexdigest()}


def archive_pins(path, expected):
    path = Path(path).absolute()
    require(path.resolve() == path and path.is_file(), 'Unsafe archive path')
    with path.open('rb') as raw:
        before = os.fstat(raw.fileno())
        compressed = hash_stream(raw)
        require(compressed == {'bytes': expected['archiveBytes'], 'sha256': expected['archiveSha256']}, 'Archive pin mismatch')
        raw.seek(0)
        with gzip.GzipFile(fileobj=raw) as uncompressed:
            tar = hash_stream(uncompressed)
        after = os.fstat(raw.fileno())
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(all(getattr(before, k) == getattr(after, k) for k in fields), 'Archive changed')
    return compressed, tar


def coverage(data, expected):
    require(pin(data) == {k: expected[k] for k in ('bytes', 'sha256')}, 'Polygon provenance mismatch')
    rings = partition.parse_poly(data.decode('utf8'))
    return {'schemaVersion': 1, 'source': 'geofabrik-poly-v1',
            'sourceChecksum': pin(data)['sha256'][:16], 'safetyMarginMeters': 1000,
            'rings': [{'exclude': excluded, 'coordinates': points} for excluded, points in rings]}


def check_replay(raw, receipts):
    report = receipts['artifact-replay.json']
    require(report['scope'] == 'authenticated-reconstructed-union-replay-with-prior-independent-unsplit-proof', 'Invalid replay scope')
    for report_key, name in (('freshProofPin', 'offline-crossing.json'),
                             ('replayToolchainPin', 'replay-toolchain-source.json'),
                             ('replayNativePin', 'replay-native-sha256.txt')):
        require(report[report_key] == pin(raw[name]), 'Replay receipt pin mismatch')
    require(report['sourcePins']['offline-crossing.json'] == pin(raw['prior-offline-crossing.json']), 'Prior proof pin mismatch')
    require(report['sourcePins']['partition-integrity.json'] == pin(raw['partition-integrity.json']), 'Prior inventory pin mismatch')
    require(receipts['replay-toolchain-source.json']['coreSha'] == CORE, 'Unsupported replay core')
    previous = receipts['prior-offline-crossing.json']
    check_crossing(previous, receipts['partition-integrity.json'])
    legs = lambda value: value['evidence']['positive']['result']['rounds']['cold']['unsplit']['legs']
    require(legs(previous) == legs(receipts['offline-crossing.json']), 'Replay differs from independent unsplit proof')


def build(evidence, packs, output, replay=False):
    evidence, packs, output = map(Path, (evidence, packs, output))
    names = ('reconstruction.json', 'partition-integrity.json', 'toolchain-source.json',
             'input-provenance.json', 'offline-crossing.json')
    if replay:
        names += ('prior-offline-crossing.json', 'artifact-replay.json',
                  'replay-toolchain-source.json', 'replay-native-sha256.txt')
    raw = {name: read(evidence / name) for name in names}
    receipts = {name: json.loads(data) for name, data in raw.items() if name.endswith('.json')}
    if replay:
        check_replay(raw, receipts)
    require(receipts['offline-crossing.json'].get('partitionReceiptSha256') == pin(raw['partition-integrity.json'])['sha256'],
            'Native proof belongs to a different partition receipt')
    check_crossing(receipts['offline-crossing.json'], receipts['partition-integrity.json'])
    require(receipts['toolchain-source.json']['coreSha'] == CORE, 'Unsupported core')
    reconstructed = receipts['reconstruction.json']
    graph = checked_graph(receipts['partition-integrity.json'], reconstructed)
    assets, regions = {}, []
    for slot, country in (('first', 'lithuania'), ('second', 'latvia')):
        region = f'europe-{country}'
        pack = reconstructed[slot]
        compressed, tar = archive_pins(packs / f'{slot}.tar.gz', pack)
        members = records(pack['tiles'])
        index = pack['index']
        require(index['path'] == 'index.bin' and type(index['bytes']) is int and 0 < index['bytes'] <= 1024 ** 3 and re.fullmatch('[a-f0-9]{64}', index['sha256']), 'Invalid archive index')
        members['index.bin'] = {k: index[k] for k in ('bytes', 'sha256')}
        inventory_name, coverage_name = f'{region}.inventory.json', f'{region}.coverage.json'
        assets[inventory_name] = encode(members)
        require(len(assets[inventory_name]) <= 32 * 1024 ** 2, 'Inventory exceeds mobile bridge budget')
        polygon = read(evidence / f'{country}.poly')
        assets[coverage_name] = encode(coverage(polygon, receipts['input-provenance.json']['downloads'][country]['polygon']))
        regions.append({'regionId': region, 'archive': {'file': f'{slot}.tar.gz', **compressed},
                        'tar': tar, 'inventory': {'file': inventory_name, **pin(assets[inventory_name])},
                        'coverage': {'file': coverage_name, 'schemaVersion': 1, **pin(assets[coverage_name])},
                        'sourcePolygon': pin(polygon)})
    assets.update(raw)
    descriptor = {'schemaVersion': 1, 'format': 'valhalla-directory-tiles-v1', 'coreSha': CORE,
                  'connectedGraphSha256': graph, 'regions': regions,
                  'provenance': {name: pin(data) for name, data in raw.items()}}
    assets['install-descriptor.json'] = encode(descriptor)
    require(not output.exists() and output.parent.resolve() == output.parent.absolute(), 'Output must be new and non-symlink')
    output.mkdir()
    for name, data in assets.items():
        with (output / name).open('xb') as stream:
            stream.write(data)
    # Independent trust anchor supplied by release metadata/explicit build pin, never self-trust.
    return pin(assets['install-descriptor.json'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('evidence', 'packs', 'output'):
        parser.add_argument(f'--{name}', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.evidence, args.packs, args.output), sort_keys=True))
