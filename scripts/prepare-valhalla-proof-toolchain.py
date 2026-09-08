#!/usr/bin/env python3
"""PURPOSE: Bind a build-only Docker toolchain to the mobile engine source.
RESPONSIBILITY: Refuse dirty/wrong source, pin prime_server and base image, retain recipe diff.
DEPENDENCIES: Python stdlib and git; caller resolves Ubuntu 24.04 digest.
CONSUMERS: Connected graph proof workflow; never modifies the mobile engine sources.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

CORE_SHA = "e2f017b16080f49203de245a211b09efab09cf72"
PRIME_SHA = "0d41876997760e22396075aeb7873bffcffd8786"


def require(value, message):
    if not value:
        raise ValueError(message)


def replace_once(text, old, new):
    require(text.count(old) == 1, "Pinned recipe preimage differs")
    return text.replace(old, new, 1)


def patch_recipe(docker, deps, ubuntu):
    require(re.fullmatch(r"(?:docker.io/library/)?ubuntu@sha256:[a-f0-9]{64}", ubuntu),
            "Immutable Ubuntu image digest required")
    require(docker.count("FROM ubuntu:24.04 AS ") == 2, "Expected pinned Ubuntu 24.04 stages")
    docker = docker.replace("FROM ubuntu:24.04 AS ", f"FROM {ubuntu} AS ")
    docker = replace_once(docker, "RUN bash ./scripts/install-linux-deps.sh",
                          "ARG CONCURRENCY=2\nRUN CONCURRENCY=${CONCURRENCY:-2} bash ./scripts/install-linux-deps.sh")
    old = "git clone --recurse-submodules https://github.com/kevinkreiser/prime_server $primeserver_dir"
    new = "\n".join([
        "git clone --no-checkout https://github.com/kevinkreiser/prime_server $primeserver_dir",
        f"git -C $primeserver_dir checkout --detach {PRIME_SHA}",
        "git -C $primeserver_dir submodule update --init --recursive",
        f'test "$(git -C $primeserver_dir rev-parse HEAD)" = "{PRIME_SHA}"',
        "git -C $primeserver_dir rev-parse HEAD > /usr/local/valhalla-proof-prime-sha.txt",
        "git -C $primeserver_dir submodule status --recursive > /usr/local/valhalla-proof-prime-submodules.txt",
    ])
    deps = replace_once(deps, old, new)
    deps += "\ndpkg-query -W > /usr/local/valhalla-proof-build-packages.txt\n"
    return docker, deps


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True)


def prepare(source, ubuntu, receipt):
    source = Path(source).absolute()
    require(source.resolve() == source, "Real source directory required")
    require(git(source, "rev-parse", "HEAD").strip() == CORE_SHA, "Wrong engine source revision")
    require(not git(source, "status", "--porcelain").strip(), "Engine checkout must be clean")
    submodules = git(source, "submodule", "status", "--recursive")
    require(all(line.startswith(" ") for line in submodules.splitlines()),
            "Source submodules are absent or changed")
    docker = source / "docker/Dockerfile"
    deps = source / "scripts/install-linux-deps.sh"
    original = [docker.read_text(), deps.read_text()]
    patched = patch_recipe(*original, ubuntu)
    # Open receipt first so an existing receipt cannot be overwritten after mutation.
    with Path(receipt).open("x") as output:
        for path, content in zip((docker, deps), patched):
            path.write_text(content)
        changed = git(source, "diff", "--name-only").splitlines()
        require(sorted(changed) == ["docker/Dockerfile", "scripts/install-linux-deps.sh"],
                "Unexpected source mutation")
        result = {"schemaVersion": 1, "coreSha": CORE_SHA, "primeSha": PRIME_SHA,
                  "ubuntuRef": ubuntu, "coreSubmodules": submodules,
                  "recipeDiff": git(source, "diff"),
                  "recipeFiles": {str(path.relative_to(source)): {
                      "beforeSha256": hashlib.sha256(before.encode()).hexdigest(),
                      "afterSha256": hashlib.sha256(after.encode()).hexdigest()}
                      for path, before, after in zip((docker, deps), original, patched)},
                  "scope": "source-and-recipe-provenance-not-bit-reproducible",
                  "aptLimitation": "Repository packages remain time-dependent; record installed package versions."}
        output.write(json.dumps(result, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("source", "ubuntu-ref", "receipt"):
        parser.add_argument(f"--{key}", required=True)
    args = parser.parse_args()
    prepare(args.source, args.ubuntu_ref, args.receipt)
    print("Pinned engine and dependency recipe verified; source receipt retained")


if __name__ == "__main__":
    main()
