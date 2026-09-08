#!/usr/bin/env python3
"""PURPOSE: Freeze and validate two inputs for one connected Valhalla graph.
RESPONSIBILITY: Source hashes, snapshot agreement, ordered merge and way-node closure.
DEPENDENCIES: Python stdlib and osmium CLI.
CONSUMERS: Build-only connected-proof workflow and input integration tests.
"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

COUNTRIES = ("lithuania", "latvia")
MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def download(url, output):
    request = urllib.request.Request(url, headers={"User-Agent": "Valhalla-connected-proof/1"})
    total = 0
    with urllib.request.urlopen(request, timeout=60) as response, Path(output).open("xb") as target:
        require(response.status == 200, "Download must return HTTP 200")
        headers = dict(response.headers.items())
        resolved = response.url
        for block in iter(lambda: response.read(1024 * 1024), b""):
            total += len(block)
            require(total <= MAX_DOWNLOAD_BYTES, "Download exceeds bounded country input size")
            target.write(block)
    require(total > 0, "Empty download")
    return {"url": url, "resolvedUrl": resolved, "httpHeaders": headers,
            "bytes": total, "sha256": digest(output)}


def file_info(path):
    result = subprocess.run(["osmium", "fileinfo", "-e", "-j", str(path)],
                            check=True, capture_output=True, text=True)
    info = json.loads(result.stdout)
    require(info["file"]["format"] == "PBF", "PBF input required")
    data = info["data"]
    require(data["objects_ordered"] is True, "Input objects are not ordered")
    require(data["multiple_versions"] is False, "Multiple object versions are forbidden")
    require(data["count"]["nodes"] > 0 and data["count"]["ways"] > 0, "Empty road input")
    require(info["header"]["with_history"] is False, "History input is forbidden")
    stamp = info["header"]["option"].get("osmosis_replication_timestamp")
    require(isinstance(stamp, str) and stamp.endswith("Z"), "Replication timestamp required")
    require(datetime.fromisoformat(stamp).isoformat().endswith("+00:00"), "UTC snapshot required")
    return info


def validate_and_merge(first, second, output, evidence):
    infos = [file_info(first), file_info(second)]
    stamps = [info["header"]["option"]["osmosis_replication_timestamp"] for info in infos]
    require(stamps[0] == stamps[1], "Input replication timestamps differ")
    # Feed-specific sequence numbers are intentionally not compared.
    subprocess.run(["osmium", "merge", str(first), str(second), "-o", str(output),
                    f"--output-header=osmosis_replication_timestamp={stamps[0]}"], check=True)
    merged = file_info(output)
    require(merged["header"]["option"]["osmosis_replication_timestamp"] == stamps[0],
            "Merged snapshot timestamp changed")
    checks = {}
    for label, args in (("wayNodes", []), ("relations", ["-r"])):
        result = subprocess.run(["osmium", "check-refs", *args, str(output)],
                                capture_output=True, text=True)
        (evidence / f"check-refs-{label}.txt").write_text(result.stdout + result.stderr)
        checks[label] = {"exitCode": result.returncode}
        if label == "wayNodes":
            require(result.returncode == 0, "Merged ways reference missing nodes")
        else:
            require(result.returncode in (0, 1), "Relation check did not complete normally")
    return {"inputs": infos, "merged": merged, "replicationTimestamp": stamps[0],
            "mergedSha256": digest(output), "referenceChecks": checks,
            "relationClosureRequired": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.output).absolute()
    require(root.resolve() == root and ".." not in root.parts, "Real output path required")
    root.mkdir()  # Never overwrite or resume a partial evidence directory.
    downloads = {}
    for country in COUNTRIES:
        base = f"https://download.geofabrik.de/europe/{country}"
        downloads[country] = {
            "pbf": download(base + "-latest.osm.pbf", root / f"{country}.osm.pbf"),
            "polygon": download(base + ".poly", root / f"{country}.poly")}
    # Retain frozen input identities even when a later semantic gate fails.
    (root / "downloads.json").write_text(json.dumps(downloads, indent=2) + "\n")
    result = validate_and_merge(root / "lithuania.osm.pbf", root / "latvia.osm.pbf",
                                root / "combined.osm.pbf", root)
    result.update({"schemaVersion": 1, "scope": "frozen-inputs-not-native-graph-proof",
                   "downloads": downloads,
                   "osmiumVersion": subprocess.check_output(["osmium", "--version"], text=True)})
    (root / "input-provenance.json").write_text(json.dumps(result, indent=2) + "\n")
    print("Frozen matching-snapshot inputs merged; provenance and reference checks retained")


if __name__ == "__main__":
    main()
