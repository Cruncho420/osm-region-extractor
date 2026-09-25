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
#   scripts/build-release-graph.sh --pbf-url URL --packs packs.json --release ID --work DIR \
#       --image VALHALLA_REF --bbox minLon,minLat,maxLon,maxLat [--concurrency 1] [--drop-orphans]
#   packs.json: [{"id": "europe-lithuania", "poly": "https://download.geofabrik.de/europe/lithuania.poly"}]
#   (a "poly" of the form "file:<path>" uses a stored outline, e.g. scripts/polys/<id>.poly).
# DEPENDENCIES: docker, node 20, python3, jq, curl, gzip, tar, sha256sum.
# CONSUMERS: .github/workflows/release-graph-trial.yml (trial); the Scaleway monthly builder (owed).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CONCURRENCY=1; DROP_ORPHANS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pbf-url) PBF_URL=$2; shift 2;;
    --packs) PACKS=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2;;
    --release) RELEASE=$2; shift 2;;
    --work) WORK=$2; shift 2;;
    --image) REF=$2; shift 2;;
    --bbox) BBOX=$2; shift 2;;
    --concurrency) CONCURRENCY=$2; shift 2;;
    --drop-orphans) DROP_ORPHANS=--drop-orphans; shift;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
D() { docker run --rm -v "$WORK:/data" "$REF" "$@"; }
say() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ---- measurement: peak used disk on the work volume and peak used RAM, sampled every 10 s ----
echo 0 > "$WORK/peak-disk"; echo 0 > "$WORK/peak-mem"
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

say "download $PBF_URL"
curl -fL --retry 3 --retry-delay 30 -o "$WORK/input.osm.pbf" "$PBF_URL"
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
TILE_BYTES=$(du -sb "$WORK/tiles" | cut -f1)

say "outlines + release-wide cut"
mkdir -p "$WORK/polys"
jq -r '.[] | "\(.id) \(.poly)"' "$PACKS" | while read -r ID SRC; do
  case "$SRC" in
    file:*) cp "${SRC#file:}" "$WORK/polys/$ID.poly";;
    *) curl -fsSL --retry 3 -o "$WORK/polys/$ID.poly" "$SRC";;
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
  --argjson admins "$ADMINS_S" --argjson tiles "$TILES_S" --argjson total "$(( $(date +%s) - T_START ))" \
  --argjson tileBytes "$TILE_BYTES" --argjson disk0 "$DISK0" --argjson peakDisk "$(cat "$WORK/peak-disk")" \
  --argjson peakMem "$(cat "$WORK/peak-mem")" --argjson conc "$CONCURRENCY" \
  --slurpfile slice "$WORK/slice.json" --slurpfile packs "$WORK/packs.json" --slurpfile desc "$WORK/descriptor-pin.json" \
  '{release: $release, pbfUrl: $url, osmSnapshot: $snap, pbfBytes: $pbf, concurrency: $conc,
    seconds: {admins: $admins, tiles: $tiles, total: $total}, tileDirBytes: $tileBytes,
    peakDiskUsedBytes: ($peakDisk - $disk0), peakMemUsedBytes: $peakMem,
    slice: ($slice[0] | {tileCount, orphanTiles: (.orphanTiles | length), pieces}), packs: $packs[0], descriptor: $desc[0]}' \
  > "$WORK/out/$RELEASE-release-report.json"
say "done: $WORK/out/$RELEASE-release-report.json"
