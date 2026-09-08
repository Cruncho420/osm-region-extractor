#!/usr/bin/env python3
"""PURPOSE: Catch pinned extractor/archive incompatibility before native builds.
RESPONSIBILITY: Run the actual pinned extractor on synthetic tiles and check bytes.
DEPENDENCIES: Python standard library; supplied pinned valhalla_build_extract script.
CONSUMERS: Connected proof workflow; this is format evidence, not native routing proof.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
CORE_SHA = "e2f017b16080f49203de245a211b09efab09cf72"
EXTRACTOR_SHA256 = "37daac2ff760552c79431b41653be6d457e7e30d051e400c29064208fce65ae4"


def smoke(extractor):
    extractor = Path(extractor).resolve(strict=True)
    digest = hashlib.sha256(extractor.read_bytes()).hexdigest()
    if digest != EXTRACTOR_SHA256:
        raise ValueError("Extractor does not match the pinned core script")
    spec = importlib.util.spec_from_file_location(
        "reconstruction", Path(__file__).with_name("reconstruct-valhalla-proof-packs.py"))
    reconstruction = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reconstruction)
    with tempfile.TemporaryDirectory(prefix="valhalla-extract-format-") as temporary:
        root = Path(temporary).resolve()
        archives, expected = [], {}
        for name, exclusive in (("first", "2/000/001.gph"), ("second", "2/000/002.gph")):
            tiles = {exclusive: b"synthetic exclusive " + name.encode(), "0/000/003.gph": b"synthetic shared"}
            expected[name] = tiles
            source = root / name
            for relative, data in tiles.items():
                tile = source / relative
                tile.parent.mkdir(parents=True, exist_ok=True)
                tile.write_bytes(data)
                # Deterministically exercise the exact fractional-mtime PAX trigger.
                os.utime(tile, ns=(1700000000123456789, 1700000000123456789))
            archive = root / f"{name}.tar"
            config = root / f"{name}.json"
            config.write_text(json.dumps({"mjolnir": {"tile_dir": str(source), "tile_extract": str(archive)}}))
            subprocess.run([sys.executable, "-B", str(extractor), "--config", str(config)], check=True)
            compressed = root / f"{name}.tar.gz"
            with archive.open("rb") as raw, compressed.open("wb") as output:
                with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as zipper:
                    shutil.copyfileobj(raw, zipper, length=1024 * 1024)
            archives.append(compressed)
        output = root / "reconstructed"
        receipt = reconstruction.reconstruct(*archives, output)
        for name, tiles in expected.items():
            actual = receipt[name]["tiles"]
            if {tile["path"] for tile in actual} != set(tiles):
                raise ValueError("Reconstructed inventory differs")
            for relative, data in tiles.items():
                if (output / name / relative).read_bytes() != data or (output / "union" / relative).read_bytes() != data:
                    raise ValueError("Reconstructed tile bytes differ")
            if not (output / name / "index.bin").is_file():
                raise ValueError("Native index missing")
        if (output / "union/index.bin").exists() or receipt["union"]["count"] != 3:
            raise ValueError("Invalid directory-mode union")
    return {"scope": "pinned-extractor-format-not-native-routing", "coreSha": CORE_SHA,
            "extractorSha256": digest, "packs": 2, "unionTiles": 3}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extractor", required=True)
    print(json.dumps(smoke(parser.parse_args().extractor), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Extractor compatibility failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
