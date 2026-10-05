#!/usr/bin/env bash
# PURPOSE: ONE Valhalla graph build per release, cut into every routing pack of that release
#   (Rods FEAT-090, owner/PM decision 2026-09-25). Packs are tile subsets of one build, so any
#   packs of the same release share byte-identical tiles and the phone installs them into one
#   connected generation. The same script runs on a GitHub runner (trial) or the Scaleway build
#   box (planet); nothing here is runner-specific.
# RESPONSIBILITY: download -> admins -> driving-side repair -> tiles -> release-wide cut -> one
#   valhalla_build_extract per pack -> N-pack install descriptor; plus a measurement report
#   (peak disk, peak RAM, build time, per-pack sizes). Publishes NOTHING: callers upload.
# USAGE:
#   scripts/build-release-graph.sh --pbf-url URL [--pbf-url URL ...] --packs packs.json --release ID --work DIR \
#       --image VALHALLA_REF --bbox minLon,minLat,maxLon,maxLat [--concurrency 1] [--drop-orphans]
#       [--resume-from cut]
#   Several --pbf-url inputs are merged with osmium into ONE build (a multi-country trial).
#   --resume-from cut: --work already holds a FINISHED tile build (tiles/ + tiles-done.json, the receipt
#     the tile step writes). Skips download, admins and tiles; redoes the cut, every pack, the
#     descriptor and the report from those tiles. For a run that died after the tiles (2026-09-30: the
#     planet cut overflowed the slicer after a 4 h tile build). It never rebuilds or edits a tile.
#   packs.json: [{"id": "europe-lithuania", "poly": "https://download.geofabrik.de/europe/lithuania.poly"}]
#   (a "poly" of the form "file:<path>" uses a stored outline, e.g. scripts/polys/<id>.poly).
# DEPENDENCIES: docker, node 20, python3, jq, curl, gzip, tar, sha256sum.
# CONSUMERS: .github/workflows/release-graph-trial.yml (trial); Rods server/valhalla-online/graph/monthly-build.sh
#   (the monthly release, on the routing box).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CONCURRENCY=1; DROP_ORPHANS=""; PBF_URLS=(); RESUME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pbf-url) PBF_URLS+=("$2"); shift 2;;
    --packs) PACKS=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2;;
    --release) RELEASE=$2; shift 2;;
    --work) WORK=$2; shift 2;;
    --image) REF=$2; shift 2;;
    --bbox) BBOX=$2; shift 2;;
    --bbox=*) BBOX=${1#--bbox=}; shift;;
    --concurrency) CONCURRENCY=$2; shift 2;;
    --drop-orphans) DROP_ORPHANS=--drop-orphans; shift;;
    --resume-from) RESUME=$2; shift 2;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
[ -z "$RESUME" ] || [ "$RESUME" = cut ] || { echo "--resume-from takes only: cut" >&2; exit 2; }
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
D() { docker run --rm -v "$WORK:/data" "$REF" "$@"; }
say() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ---- measurement: peak used disk on the work volume and peak used RAM, sampled every 10 s ----
if [ -z "$RESUME" ] || [ ! -s "$WORK/peak-disk" ] || [ ! -s "$WORK/peak-mem" ]; then echo 0 > "$WORK/peak-disk"; echo 0 > "$WORK/peak-mem"; fi
( while :; do
    DISK=$(df -B1 --output=used "$WORK" | tail -1 | tr -d ' ')
    MEM=$(free -b | awk '/^Mem:/ {print $3}')
    [ "$DISK" -gt "$(cat "$WORK/peak-disk")" ] && echo "$DISK" > "$WORK/peak-disk"
    [ "$MEM" -gt "$(cat "$WORK/peak-mem")" ] && echo "$MEM" > "$WORK/peak-mem"
    sleep 10
  done ) & SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT
DISK0=$(df -B1 --output=used "$WORK" | tail -1 | tr -d ' ')
T_START=$(date +%s)

PBF_URL=$(IFS=,; echo "${PBF_URLS[*]}")
STATE="$WORK/tiles-done.json"
tile_census() {  # "<tile count> <bytes>" of every .gph under tiles/
  find "$WORK/tiles" -name '*.gph' -printf '%s\n' | awk '{n++; b+=$1} END {print n+0, b+0}'
}
if [ "$RESUME" = cut ]; then
  # Trust only a tile build that finished: its receipt, the builder's own end-of-build line, no
  # failure marker, all three levels, no empty tile, and exactly the tiles the receipt counted.
  fail() { echo "::error::--resume-from cut: $*"; exit 1; }
  [ -s "$STATE" ] || fail "no $STATE (the tile step's receipt) in $WORK"
  [ "$(jq -r .pbfUrl "$STATE")" = "$PBF_URL" ] || fail "these tiles were built from $(jq -r .pbfUrl "$STATE"), not $PBF_URL"
  grep -q "build_tile_set took" "$WORK/build.log" || fail "build.log has no end-of-build line"
  ! grep -qE "Mismatch in end offset|terminate called" "$WORK/build.log" || fail "build.log reports a failed tile build"
  [ -s "$WORK/valhalla.json" ] || fail "valhalla.json (the build's config) is missing"
  for L in 0 1 2; do [ -d "$WORK/tiles/$L" ] || fail "tiles/$L is missing"; done
  [ -z "$(find "$WORK/tiles" -name '*.gph' -size 0 -print -quit)" ] || fail "an empty tile exists"
  read -r TILE_COUNT TILE_BYTES_NOW < <(tile_census)
  [ "$TILE_COUNT" = "$(jq -r .tileCount "$STATE")" ] && [ "$TILE_BYTES_NOW" = "$(jq -r .tileBytes "$STATE")" ] \
    || fail "tiles/ holds $TILE_COUNT tiles, $TILE_BYTES_NOW bytes; the receipt says $(jq -r .tileCount "$STATE"), $(jq -r .tileBytes "$STATE")"
  # The graph builder logs how many level-2 tiles it builds; binning only ever adds more.
  BUILT=$(sed -E 's/\x1b\[[0-9;]*m//g' "$WORK/build.log" | sed -nE 's/.*Building ([0-9]+) tiles with .*/\1/p' | tail -1)
  L2=$(find "$WORK/tiles/2" -name '*.gph' | wc -l)
  [ -n "$BUILT" ] && [ "$L2" -ge "$BUILT" ] || fail "tiles/2 holds $L2 tiles, the builder built ${BUILT:-?}"
  PBF_BYTES=$(jq -r .pbfBytes "$STATE"); SNAPSHOT=$(jq -r .osmSnapshot "$STATE")
  DOWNLOAD_S=$(jq -r .seconds.download "$STATE"); ADMINS_S=$(jq -r .seconds.admins "$STATE"); TILES_S=$(jq -r .seconds.tiles "$STATE")
  DISK0=$(jq -r .diskUsedBeforeBytes "$STATE"); T_START=$(( $(date +%s) - DOWNLOAD_S - ADMINS_S - TILES_S ))
  say "resume from the cut: $TILE_COUNT tiles ($L2 at level 2, builder built $BUILT), $TILE_BYTES_NOW bytes, snapshot $SNAPSHOT"
  # Whatever the failed attempt left of the cut and the packs. pieces/ holds hard links only.
  rm -rf "$WORK/pieces" "$WORK/out" "$WORK/assets" "$WORK/slice.json" "$WORK"/*.tar
else
T0=$(date +%s)
if [ "${#PBF_URLS[@]}" -eq 1 ]; then
  say "download $PBF_URL"
  curl -fL -b /dev/null --max-redirs 10 --retry 3 --retry-delay 30 -o "$WORK/input.osm.pbf" "${PBF_URLS[0]}"
else
  PARTS=()
  for i in "${!PBF_URLS[@]}"; do
    say "download ${PBF_URLS[$i]}"
    curl -fL -b /dev/null --max-redirs 10 --retry 3 --retry-delay 30 -o "$WORK/part-$i.osm.pbf" "${PBF_URLS[$i]}"
    PARTS+=("$WORK/part-$i.osm.pbf")
  done
  say "merge ${#PARTS[@]} extracts"
  osmium merge --overwrite -o "$WORK/input.osm.pbf" "${PARTS[@]}"
  rm -f "${PARTS[@]}"
fi
DOWNLOAD_S=$(( $(date +%s) - T0 ))
PBF_BYTES=$(stat -c%s "$WORK/input.osm.pbf")
SNAPSHOT=$(python3 "$HERE/pbf_snapshot.py" "$WORK/input.osm.pbf" || echo unknown)

say "timezones, config, admins"
[ -s "$WORK/tz_world.sqlite" ] || D valhalla_build_timezones > "$WORK/tz_world.sqlite"
D valhalla_build_config --mjolnir-tile-dir /data/tiles --mjolnir-tile-extract /data/unused.tar \
  --mjolnir-timezone /data/tz_world.sqlite --mjolnir-admin /data/admins.sqlite > "$WORK/base.json"
jq --argjson c "$CONCURRENCY" '.mjolnir.concurrency = $c | .mjolnir.max_cache_size = 262144000' "$WORK/base.json" > "$WORK/valhalla.json"
T0=$(date +%s); D valhalla_build_admins -c /data/valhalla.json /data/input.osm.pbf; ADMINS_S=$(( $(date +%s) - T0 ))
sudo chown -R "$(id -u):$(id -g)" "$WORK" 2>/dev/null || true
"$HERE/repair-driving-side.sh" "$WORK" "$REF" "$BBOX" ""

say "tiles (concurrency $CONCURRENCY)"
T0=$(date +%s)
D valhalla_build_tiles -c /data/valhalla.json /data/input.osm.pbf 2>&1 | tee "$WORK/build.log" | tail -5
if grep -qE "Mismatch in end offset|terminate called" "$WORK/build.log" || [ ! -d "$WORK/tiles/2" ]; then
  echo "::error::tile build failed or corrupt"; exit 1
fi
TILES_S=$(( $(date +%s) - T0 ))
sudo chown -R "$(id -u):$(id -g)" "$WORK" 2>/dev/null || true
rm -f "$WORK/input.osm.pbf"
# The tile step's receipt: what --resume-from cut needs once the input is gone.
read -r TILE_COUNT TILE_BYTES_NOW < <(tile_census)
jq -n --arg url "$PBF_URL" --arg snap "$SNAPSHOT" --argjson pbf "$PBF_BYTES" --argjson download "$DOWNLOAD_S" \
  --argjson admins "$ADMINS_S" --argjson tiles "$TILES_S" --argjson disk0 "$DISK0" --argjson count "$TILE_COUNT" \
  --argjson bytes "$TILE_BYTES_NOW" '{pbfUrl: $url, osmSnapshot: $snap, pbfBytes: $pbf, tileCount: $count, tileBytes: $bytes,
    seconds: {download: $download, admins: $admins, tiles: $tiles}, diskUsedBeforeBytes: $disk0}' > "$STATE"
fi
TILE_BYTES=$(du -sb "$WORK/tiles" | cut -f1)

say "outlines + release-wide cut"
mkdir -p "$WORK/polys"
jq -r '.[] | "\(.id) \(.poly)"' "$PACKS" | while read -r ID SRC; do
  case "$SRC" in
    file:*) cp "${SRC#file:}" "$WORK/polys/$ID.poly";;
    *) curl -fsSL -b /dev/null --max-redirs 10 --retry 3 -o "$WORK/polys/$ID.poly" "$SRC";;
  esac
done
node "$HERE/slice-valhalla-graph.mjs" --packs "$PACKS" --polys "$WORK/polys" --tiles "$WORK/tiles" \
  --out "$WORK/pieces" $DROP_ORPHANS > "$WORK/slice.json"

say "extract + pin every pack"
mkdir -p "$WORK/out" "$WORK/assets"; echo '{}' > "$WORK/packs.json"
for ID in $(jq -r '.pieces | keys[]' "$WORK/slice.json"); do
  jq --arg d "/data/pieces/$ID" --arg t "/data/$ID.tar" '.mjolnir.tile_dir = $d | .mjolnir.tile_extract = $t' "$WORK/valhalla.json" > "$WORK/extract.json"
  D valhalla_build_extract -c /data/extract.json > /dev/null
  sudo chown "$(id -u):$(id -g)" "$WORK/$ID.tar" 2>/dev/null || true
  TB=$(stat -c%s "$WORK/$ID.tar"); TS=$(sha256sum "$WORK/$ID.tar" | cut -d' ' -f1)
  MEMBER=$(tar -tf "$WORK/$ID.tar" | grep -E '(^|/)index\.bin$' | head -1)
  INDEX=$(tar -xOf "$WORK/$ID.tar" "$MEMBER" | sha256sum | cut -d' ' -f1); IB=$(tar -xOf "$WORK/$ID.tar" "$MEMBER" | wc -c)
  gzip -f "$WORK/$ID.tar"; mv "$WORK/$ID.tar.gz" "$WORK/out/$ID-valhalla.tar.gz"
  GZ=$(stat -c%s "$WORK/out/$ID-valhalla.tar.gz"); GS=$(sha256sum "$WORK/out/$ID-valhalla.tar.gz" | cut -d' ' -f1)
  jq -c --arg s "$INDEX" --argjson b "$IB" '. + {"index.bin": {bytes: $b, sha256: $s}}' "$WORK/pieces/$ID.tiles.json" > "$WORK/assets/$ID.inventory.json"
  node "$HERE/generate-valhalla-coverage.mjs" --input "$WORK/polys/$ID.poly" --output "$WORK/assets/$ID-valhalla-coverage.json"
  jq --arg id "$ID" --argjson gz "$GZ" --arg sha "$GS" --argjson tb "$TB" --arg ts "$TS" \
    '.[$id] = {archive: {bytes: $gz, sha256: $sha}, tar: {bytes: $tb, sha256: $ts}}' "$WORK/packs.json" > "$WORK/p.tmp"
  mv "$WORK/p.tmp" "$WORK/packs.json"
done

say "N-pack install descriptor"
jq -n --arg image "$REF" --arg url "$PBF_URL" --arg snap "$SNAPSHOT" \
  '{toolchain: {valhallaImage: $image}, inputs: {releasePbf: $url, osmSnapshot: $snap}}' > "$WORK/inputs.json"
echo '[]' > "$WORK/routes.json"  # release-wide engine comparisons: owed with the Scaleway builder
if [ -z "$DROP_ORPHANS" ]; then
  node "$HERE/build-slice-install-descriptor.mjs" --work "$WORK" --assets "$WORK/assets" --country "$RELEASE" \
    --inputs "$WORK/inputs.json" --out "$WORK/out" | tee "$WORK/descriptor-pin.json"
else
  echo '{"skipped": "trial cut drops orphans; union is not the whole graph"}' > "$WORK/descriptor-pin.json"
fi

kill $SAMPLER 2>/dev/null || true
jq -n --arg release "$RELEASE" --arg url "$PBF_URL" --arg snap "$SNAPSHOT" --argjson pbf "$PBF_BYTES" \
  --argjson download "$DOWNLOAD_S" --argjson admins "$ADMINS_S" --argjson tiles "$TILES_S" --argjson total "$(( $(date +%s) - T_START ))" \
  --argjson tileBytes "$TILE_BYTES" --argjson disk0 "$DISK0" --argjson peakDisk "$(cat "$WORK/peak-disk")" \
  --argjson peakMem "$(cat "$WORK/peak-mem")" --argjson conc "$CONCURRENCY" \
  --slurpfile slice "$WORK/slice.json" --slurpfile packs "$WORK/packs.json" --slurpfile desc "$WORK/descriptor-pin.json" \
  '{release: $release, pbfUrl: $url, osmSnapshot: $snap, pbfBytes: $pbf, concurrency: $conc,
    seconds: {download: $download, admins: $admins, tiles: $tiles, total: $total}, tileDirBytes: $tileBytes,
    peakDiskUsedBytes: ($peakDisk - $disk0), diskUsedBeforeBytes: $disk0, peakMemUsedBytes: $peakMem,
    slice: ($slice[0] | {tileCount, orphanTiles: (.orphanTiles | length), pieces}), packs: $packs[0], descriptor: $desc[0]}' \
  > "$WORK/out/$RELEASE-release-report.json"
say "done: $WORK/out/$RELEASE-release-report.json"
