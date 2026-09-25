#!/usr/bin/env bash
# PURPOSE: Correct and prove the driving side of every country row in a Valhalla admins.sqlite before
#   tiles are built. Missing country rows get their REAL (Natural Earth 1:10m, buffered ~2 km) outline;
#   every row is then checked against scripts/country-driving-side.json (wrong side corrected, unknown
#   ISO = failure). Replaces the padded-bbox repair (see scripts/driving-side-repair.py header).
# USAGE: scripts/repair-driving-side.sh <work dir holding admins.sqlite> <valhalla image ref> \
#          <minLon,minLat,maxLon,maxLat of the build input> [comma ISOs that must end with a row]
# DEPENDENCIES: docker (the pinned Valhalla image ships spatialite), python3, curl, sha256sum.
# CONSUMERS: valhalla-tiles.yml, region-slices-pilot.yml, scripts/build-release-graph.sh.
set -euo pipefail
WORK=$1; REF=$2; BBOX=$3; REQUIRE=${4:-}
HERE=$(cd "$(dirname "$0")" && pwd)
NE_URL=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson
NE_SHA=239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255
NE="$WORK/ne_10m_admin_0_countries.geojson"
if [ ! -s "$NE" ] || [ "$(sha256sum "$NE" | cut -d' ' -f1)" != "$NE_SHA" ]; then
  curl -fsSL --retry 3 -o "$NE" "$NE_URL"
  [ "$(sha256sum "$NE" | cut -d' ' -f1)" = "$NE_SHA" ] || { echo "::error::Natural Earth outline pin mismatch"; exit 1; }
fi
SPATIALITE() { docker run --rm -v "$WORK:/data" "$REF" spatialite /data/admins.sqlite "$@"; }
rows() { SPATIALITE "SELECT IFNULL(iso_code,''), drive_on_right FROM admins WHERE admin_level=2;" > "$WORK/admin-rows.txt"; }

rows
python3 "$HERE/driving-side-repair.py" plan --rows "$WORK/admin-rows.txt" --table "$HERE/country-driving-side.json" \
  --ne "$NE" --bbox "$BBOX" --require "$REQUIRE" > "$WORK/admin-plan.sql"
if [ -s "$WORK/admin-plan.sql" ]; then
  docker run --rm -i -v "$WORK:/data" "$REF" spatialite /data/admins.sqlite < "$WORK/admin-plan.sql"
fi
rows
python3 "$HERE/driving-side-repair.py" check --rows "$WORK/admin-rows.txt" --table "$HERE/country-driving-side.json" \
  > "$WORK/admin-fix.sql"
if [ -s "$WORK/admin-fix.sql" ]; then
  cat "$WORK/admin-fix.sql"
  docker run --rm -i -v "$WORK:/data" "$REF" spatialite /data/admins.sqlite < "$WORK/admin-fix.sql"
  rows
  python3 "$HERE/driving-side-repair.py" check --rows "$WORK/admin-rows.txt" --table "$HERE/country-driving-side.json" > "$WORK/admin-fix.sql"
  [ ! -s "$WORK/admin-fix.sql" ] || { echo "::error::driving side still wrong after correction"; exit 1; }
fi
echo "Driving side verified for every country row ($(wc -l < "$WORK/admin-rows.txt") rows)"
