#!/usr/bin/env python3
"""Add offline search files to an ALREADY PUBLISHED release's manifest.json, changing nothing else.

PURPOSE: the owner moved the offline search publish forward from the 1 Nov monthly release
  (Tadas 2026-10-10, "Publish the offline results now"). The search files go onto the CURRENT
  release, so the manifest must gain searchSize/searchChecksum per region WITHOUT a new version,
  date or pack tag: a new `version` marks every installed region, routing pack and map stale, and
  new valhallaPackTag/basemapTag values point phones at releases that may not exist.
RESPONSIBILITY: read the live manifest + a directory of <region>-search.sqlite.gz files, compute
  each file's size and sha256[0:16] (the generate-manifest.ts format) from the bytes, set the two
  fields on that region, and REFUSE unless everything except those two fields is identical.
  Regions without a file keep the search entry they already had (partial re-runs merge).
DEPENDENCIES: python3 stdlib.
CONSUMERS: .github/workflows/search-index-publish.yml, test_search_manifest_patch.py.

USAGE: search_manifest_patch.py --manifest live.json --dir search/ --out manifest.json
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

SUFFIX = '-search.sqlite.gz'
FIELDS = ('searchSize', 'searchChecksum')


def without_search(manifest):
    out = json.loads(json.dumps(manifest))
    for r in out.get('regions', {}).values():
        for f in FIELDS:
            r.pop(f, None)
    return out


def checksum(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()[:16]


def patch(manifest, files):
    """files: {region: Path}. Returns (new manifest, regions set). Raises ValueError on any problem."""
    out = json.loads(json.dumps(manifest))
    regions = out.get('regions')
    if not isinstance(regions, dict) or not regions:
        raise ValueError('manifest has no regions')
    unknown = sorted(set(files) - set(regions))
    if unknown:
        raise ValueError(f'search files for regions not in the manifest: {unknown}')
    for region, path in sorted(files.items()):
        size = Path(path).stat().st_size
        if size <= 0:
            raise ValueError(f'{path} is empty')
        regions[region]['searchSize'] = size
        regions[region]['searchChecksum'] = checksum(path)
    if without_search(out) != without_search(manifest):
        raise ValueError('patch would change something other than searchSize/searchChecksum')
    return out, set(files)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    manifest = json.loads(Path(a.manifest).read_text())
    files = {p.name[:-len(SUFFIX)]: p for p in Path(a.dir).glob(f'*{SUFFIX}')}
    try:
        out, done = patch(manifest, files)
    except ValueError as e:
        sys.exit(f'search_manifest_patch: {e}')
    Path(a.out).write_text(json.dumps(out, indent=2))
    have = sum(1 for r in out['regions'].values() if 'searchSize' in r)
    print(f'patched {len(done)} regions; {have}/{len(out["regions"])} now list a search file; '
          f'version {out.get("version")} unchanged')


if __name__ == '__main__':
    main()
