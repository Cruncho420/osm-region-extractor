#!/usr/bin/env python3
"""PURPOSE: Reconstruct compressed proof packs without changing graph tile bytes.
RESPONSIBILITY: Bounded safe extraction, identical-overlap union, provenance receipt.
DEPENDENCIES: Python standard library only.
CONSUMERS: Build-only proof workflow; separate exact-union and native crossing gates.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile

CHUNK = 1024 * 1024
MAX_MEMBER_BYTES = 1024 ** 3
MAX_ARCHIVE_BYTES = 256 * 1024 ** 3
MAX_MEMBERS = 2_000_000
MAX_MTIME_HEADER_BYTES = 1024
TILE = re.compile(r"[012]/(?:[0-9]{3}/){1,2}[0-9]{3}\.gph")
DIRECTORY = re.compile(r"[012](?:/[0-9]{3}){0,2}/?")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def checked_path(value, output=False):
    path = Path(value).absolute()
    require(".." not in Path(value).parts and path.resolve() == path, "Unsafe root path")
    if output:
        require(not path.exists() and not path.is_symlink(), "Output already exists")
        require(path.parent.is_dir(), "Output parent missing")
    else:
        require(path.is_file(), "Archive must be a regular file")
    return path


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def extract_member(source, member, root):
    target = root / member.name
    target.parent.mkdir(parents=True, exist_ok=True)
    digest, count = hashlib.sha256(), 0
    with target.open("xb") as output:
        while count < member.size:
            chunk = source.read(min(CHUNK, member.size - count))
            require(chunk, "Truncated member")
            output.write(chunk)
            digest.update(chunk)
            count += len(chunk)
    require(count == member.size, "Truncated member")
    return {"path": member.name, "bytes": count, "sha256": digest.hexdigest()}


def consume_mtime_header(source, member):
    # Pinned e2f017b valhalla_build_extract uses Python tar.add(), which adds
    # this local PAX record for fractional filesystem mtime. Ignore timestamps;
    # never apply PAX path, size, link or sparse overrides to validated headers.
    require(member.name == "././@PaxHeader" and 0 < member.size <= MAX_MTIME_HEADER_BYTES,
            "Other extended headers forbidden")
    payload = source.read(member.size)
    match = re.fullmatch(rb"([1-9][0-9]{0,3}) mtime=-?[0-9]{1,20}(?:\.[0-9]{1,20})?\n", payload)
    require(match is not None and int(match[1]) == member.size, "Invalid or unsupported local PAX record")
    padding = (-member.size) % 512
    require(source.read(padding) == bytes(padding), "Invalid PAX padding")


def tar_members(source):
    # Parse fixed headers ourselves: tarfile's iterator eagerly allocates PAX/GNU
    # extension payloads before callers can reject them or enforce size limits.
    pending_mtime = False
    while True:
        header = source.read(512)
        require(len(header) == 512, "Missing tar end marker")
        if header == bytes(512):
            require(not pending_mtime, "Orphan local PAX record")
            require(source.read(512) == bytes(512), "Missing second tar end marker")
            break
        member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        if member.type == tarfile.XHDTYPE:
            require(not pending_mtime, "Repeated local PAX record")
            consume_mtime_header(source, member)
            pending_mtime = True
            continue
        require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE),
                "Links, special files and extended headers forbidden")
        require(not pending_mtime or member.isreg(), "Local PAX requires a regular member")
        pending_mtime = False
        yield member
        padding = (-member.size) % 512
        require(source.read(padding) == bytes(padding), "Invalid tar member padding")
    trailing = 0
    while chunk := source.read(CHUNK):
        trailing += len(chunk)
        require(trailing <= MAX_MEMBER_BYTES and not any(chunk), "Unexpected tar trailer")


def extract_archive(path, root):
    tiles, names, index, total = [], set(), None, 0
    with path.open("rb") as raw:
        before = fingerprint(os.fstat(raw.fileno()))
        digest = hashlib.sha256()
        while chunk := raw.read(CHUNK):
            digest.update(chunk)
        raw.seek(0)
        with gzip.GzipFile(fileobj=raw, mode="rb") as compressed:
            for member in tar_members(compressed):
                name = member.name
                require(name not in names and len(names) < MAX_MEMBERS, "Duplicate or excessive members")
                names.add(name)
                require(not member.pax_headers and member.sparse is None, "Extended/sparse member forbidden")
                if member.isdir():
                    require(DIRECTORY.fullmatch(name) and member.size == 0, "Unexpected directory")
                else:
                    require(member.isreg() and (name == "index.bin" or TILE.fullmatch(name)),
                            "Unsafe or unexpected member")
                    require(0 < member.size <= MAX_MEMBER_BYTES, "Empty or oversized member")
                    total += member.size
                    require(total <= MAX_ARCHIVE_BYTES, "Archive exceeds extraction budget")
                    item = extract_member(compressed, member, root)
                    if name == "index.bin":
                        index = item
                    else:
                        tiles.append(item)
        require(before == fingerprint(os.fstat(raw.fileno())), "Archive changed during reconstruction")
    require(index is not None and tiles, "Archive requires index.bin and nonempty tiles")
    return {"archive": str(path), "archiveSha256": digest.hexdigest(),
            "archiveBytes": before[2], "extractedBytes": total, "index": index,
            "tiles": sorted(tiles, key=lambda tile: tile["path"])}


def reconstruct(first, second, output):
    archives = [checked_path(first), checked_path(second)]
    root = checked_path(output, output=True)
    root.mkdir()
    for name in ("first", "second", "union"):
        (root / name).mkdir()
    packs = {name: extract_archive(path, root / name)
             for name, path in zip(("first", "second"), archives)}
    union = {}
    for name, pack in packs.items():
        for tile in pack["tiles"]:
            previous = union.get(tile["path"])
            require(previous is None or previous == tile, "Conflicting duplicate tile")
            if previous is not None:
                continue
            target = root / "union" / tile["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(root / name / tile["path"], target, follow_symlinks=False)
            union[tile["path"]] = tile
    # index.bin offsets belong to each original tar; directory-mode union must
    # never borrow or synthesize that index. Partial failures remain for inspection.
    receipt = {"schemaVersion": 1, "scope": "archive-reconstruction-not-native-proof",
               **packs, "union": {"tiles": sorted(union.values(), key=lambda tile: tile["path"]),
                                  "count": len(union), "bytes": sum(t["bytes"] for t in union.values())}}
    with (root / "receipt.json").open("x") as stream:
        json.dump(receipt, stream, sort_keys=True)
        stream.write("\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("first", "second", "output"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    reconstruct(args.first, args.second, args.output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Reconstruction failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
