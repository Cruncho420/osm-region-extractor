#!/usr/bin/env bash
set -euo pipefail
# Ordinary Ubuntu signed repositories. Exact versions/archives are recorded, not locked.
export DEBIAN_FRONTEND=noninteractive
mkdir -p /build/deb-cache/partial
apt-get update
apt-get -o Dir::Cache::archives=/build/deb-cache -y --no-install-recommends install \
  build-essential cmake pkg-config git ca-certificates libboost-all-dev \
  libcurl4-openssl-dev liblz4-dev libprotobuf-dev protobuf-compiler libsqlite3-dev \
  libspatialite-dev libluajit-5.1-dev libgeos-dev libssl-dev zlib1g-dev python3 python3-shapely \
  python3-requests osmium-tool curl unzip jq spatialite-bin
exec python3 /job/scripts/valhalla-edge-census.py build --root /job
