#!/usr/bin/env bash
# PURPOSE: build, verify and publish ONE offline map file (a region, or a piece of a split
#   country) for basemap-tiles.yml (FEAT-090 ME-13 + L4).
# RESPONSIBILITY: clip polygon → reuse-or-extract → size cap + checksum report → GitHub upload
#   (served bytes re-hashed) → R2 upload when the bucket-scoped secrets exist. Writes
#   report/basemap-report-<id>.json. Exits non-zero on any failure; a copy that does not verify
#   is deleted so it can never sit on an immutable production tag.
# DEPENDENCIES: pmtiles, gh, jq, curl, node, python3 (scripts/r2.py), scripts/poly-to-geojson.mjs.
# CONSUMERS: .github/workflows/basemap-tiles.yml (build job, one call per unit of its batch).
#
# Args: $1 = unit JSON from scripts/basemap-units.mjs ({id, poly, maxZoom, country}).
# Env:  TAG CHANNEL VERSION PLANET MAXZOOM UPLOAD REPO GH_TOKEN MAX_ASSET_BYTES REBUILD_PIECES
#       R2_ACCOUNT_ID R2_MAPS_ACCESS_KEY_ID R2_MAPS_SECRET_ACCESS_KEY (optional)
set -euo pipefail
UNIT="$1"
ID=$(jq -r .id <<< "$UNIT")
POLY=$(jq -r .poly <<< "$UNIT")
PIECE_OF=$(jq -r '.country // ""' <<< "$UNIT")
Z=$(jq -r --arg z "$MAXZOOM" '.maxZoom // ($z | tonumber)' <<< "$UNIT")
F="${ID}-basemap.pmtiles"
W="work-$ID"
rm -rf "$W" && mkdir -p "$W" report
echo "::group::$ID (${PIECE_OF:+piece of $PIECE_OF, }z$Z)"

# ── clip polygon: a piece uses its stored outline (the one its road data + routing pack use)
case "$POLY" in
  stored:*) cp "scripts/polys/${POLY#stored:}.poly" "$W/region.poly" ;;
  *) curl -sfL --retry 3 "https://download.geofabrik.de/$POLY.poly" -o "$W/region.poly" ;;
esac
node scripts/poly-to-geojson.mjs "$W/region.poly" "$W/region.geojson"

# ── reuse: a production resume where GitHub has the file but R2 does not. The R2 copy must be
#    the SAME bytes the app pinned, so it is downloaded, never rebuilt.
REUSE=false
# rebuild_pieces (outline change): a piece is rebuilt and its published file replaced.
REPLACE=false; [ "${REBUILD_PIECES:-false}" = true ] && [ -n "$PIECE_OF" ] && REPLACE=true
if [ "$REPLACE" = false ] && [ "$CHANNEL" = production ] && gh release view "$TAG" -R "$REPO" --json assets -q '.assets[].name' | grep -qx "$F" \
   && gh release download "$TAG" -R "$REPO" -D "$W/prev" --pattern manifest-staging.json 2>/dev/null \
   && jq -e --arg r "$ID" '.regions[$r]' "$W/prev/manifest-staging.json" > /dev/null; then
  gh release download "$TAG" -R "$REPO" -D "$W" --pattern "$F"
  mv "$W/$F" "$F"
  jq --arg r "$ID" '.regions[$r] + {region:$r}' "$W/prev/manifest-staging.json" > "$W/staged.json"
  REUSE=true
fi

R="report/basemap-report-${ID}.json"
if [ "$REUSE" = true ]; then
  [ "$(stat -c %s "$F")" = "$(jq -r .basemapSize "$W/staged.json")" ] || { echo "::error::published $F differs from its staging entry"; exit 1; }
  [ "$(sha256sum "$F" | cut -d' ' -f1)" = "$(jq -r .basemapChecksum "$W/staged.json")" ] || { echo "::error::published $F sha256 differs from its staging entry"; exit 1; }
  cp "$W/staged.json" "$R"
else
  # ── extract (HTTP range reads from the planet build). A whole region over 2 GiB drops a zoom
  #    (never below 12, reported as a D8 deviation). A PIECE never drops: pieces exist so every
  #    file keeps its zoom, so a piece over the cap fails the run — split it further.
  START=$(date +%s)
  while :; do
    rm -f "$F"
    pmtiles extract "https://build.protomaps.com/${PLANET}.pmtiles" "$F" \
      --region="$W/region.geojson" --maxzoom="$Z" --download-threads=8 2>&1 | tee "$W/extract.log"
    [ "$(stat -c %s "$F")" -le "$MAX_ASSET_BYTES" ] && break
    [ -z "$PIECE_OF" ] || { echo "::error::piece $ID is $(stat -c %s "$F") bytes at z$Z — over 2 GiB; split $PIECE_OF further"; exit 1; }
    [ "$Z" -gt 12 ] || { echo "::error::$F is over 2 GiB even at z12 — the region must be split"; exit 1; }
    echo "::warning::$ID is $(stat -c %s "$F") bytes at z$Z (over 2 GiB); rebuilding at z$((Z-1))"
    Z=$((Z-1))
  done
  SECONDS_EXTRACT=$(( $(date +%s) - START ))
  pmtiles verify "$F"
  pmtiles show "$F" | tee "$W/show.txt"
  grep -q '^tile type: mvt' "$W/show.txt" || { echo "::error::not a vector archive"; exit 1; }
  grep -qE "^max zoom: $Z\$" "$W/show.txt" || { echo "::error::archive max zoom is not $Z"; exit 1; }
  BYTES=$(stat -c %s "$F")
  SHA=$(sha256sum "$F" | cut -d' ' -f1)
  TILES=$(grep -oE 'Region tiles [0-9]+, result tile entries [0-9]+' "$W/extract.log" | grep -oE '[0-9]+$' || echo 0)
  REQS=$(grep -oE 'Extract required [0-9]+ total requests' "$W/extract.log" | grep -oE '[0-9]+' || echo 0)
  jq -n --arg r "$ID" --argjson b "$BYTES" --arg s "$SHA" --argjson z "$Z" --arg p "$PLANET" --arg c "$PIECE_OF" \
    --argjson t "${TILES:-0}" --argjson q "${REQS:-0}" --argjson sec "$SECONDS_EXTRACT" \
    '{region:$r, basemapSize:$b, basemapChecksum:$s, basemapMaxZoom:$z, basemapPlanet:$p, tiles:$t, requests:$q, seconds:$sec}
     + (if $c == "" then {} else {pieceOf:$c} end)' > "$R"
  cat "$R"

  # ── GitHub upload (production assets are immutable)
  if [ "$UPLOAD" = true ]; then
    if [ "$CHANNEL" = production ]; then
      if [ "$REPLACE" = true ]; then
        gh release upload "$TAG" -R "$REPO" "$F" --clobber
      elif gh release view "$TAG" -R "$REPO" --json assets -q '.assets[].name' | grep -qx "$F"; then
        echo "::error::$F already published on $TAG but not in its staging manifest — delete the asset and re-run"; exit 1
      else
        gh release upload "$TAG" -R "$REPO" "$F"
      fi
    else
      gh release upload "$TAG" -R "$REPO" "$F" --clobber
    fi
    # What GitHub serves must be what we built, byte for byte.
    URL="https://github.com/$REPO/releases/download/$TAG/$F"
    SERVED=$(curl -sfL --retry 3 "$URL" | sha256sum | cut -d' ' -f1)
    if [ "$SERVED" != "$SHA" ]; then
      gh release delete-asset "$TAG" "$F" -R "$REPO" -y || true
      echo "::error::GitHub serves sha256 $SERVED, built $SHA"; exit 1
    fi
  fi
fi

# ── R2 (production, only when ALL THREE bucket-scoped secrets exist; otherwise GitHub only)
if [ "$UPLOAD" = true ] && [ "$CHANNEL" = production ]; then
  if [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${R2_MAPS_ACCESS_KEY_ID:-}" ] && [ -n "${R2_MAPS_SECRET_ACCESS_KEY:-}" ]; then
    KEY="releases/${VERSION}/${ID}/${F}"
    python3 scripts/r2.py put "$F" "$KEY" | tee "$W/r2.out"
    GOT=$(tail -1 "$W/r2.out")
    [ "$(echo "$GOT" | jq -r .sha256)" = "$(jq -r .basemapChecksum "$R")" ] || { echo "::error::R2 copy hash differs"; exit 1; }
    jq --arg k "$KEY" --arg g "https://github.com/$REPO/releases/download/$TAG/$F" '. + {r2Key:$k, github:$g}' "$R" > "$W/r.tmp" && mv "$W/r.tmp" "$R"
  else
    echo "R2 secrets not configured — GitHub only"
  fi
fi
rm -rf "$W" "$F"  # the runner disk holds one unit at a time
echo "::endgroup::"
