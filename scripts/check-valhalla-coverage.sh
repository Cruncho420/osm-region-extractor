#!/usr/bin/env bash
# PURPOSE: Refuse a valhalla release manifest that lists a pack without its exact coverage file.
# RESPONSIBILITY: Every region in the manifest must carry valhallaCoverageSize/Checksum AND the
#   release must serve <region>-valhalla-coverage.json at exactly that size.
# DEPENDENCIES: gh, jq. Needs GH_TOKEN.
# CONSUMERS: valhalla-tiles.yml (finalize), valhalla-coverage-backfill.yml.
#
# WHY: the Rods app refuses to route on a pack without coverage (valhallaCoverage.ts). On
# 2026-09-24 231 of 234 packs on valhalla-2026-09-02 had none, and every check reported green.
#
# Usage: check-valhalla-coverage.sh <tag> <manifest.json>
set -euo pipefail
TAG="$1"
MANIFEST="$2"

NOCOV=$(jq -r '.regions | to_entries[]
  | select((.value.valhallaCoverageSize // 0) <= 0
           or ((.value.valhallaCoverageChecksum // "") | test("^[a-f0-9]{16}$") | not))
  | .key' "$MANIFEST")
if [ -n "$NOCOV" ]; then
  echo "::error::$(echo "$NOCOV" | wc -l | tr -d ' ') region(s) have no coverage pin, the app cannot route on them. Run valhalla-coverage-backfill.yml against $TAG: $(echo $NOCOV)"
  exit 1
fi

ASSETS=$(mktemp)
gh release view "$TAG" --json assets -q '.assets[] | "\(.name) \(.size)"' | sort > "$ASSETS"
MISSING=$(jq -r '.regions | to_entries[] | "\(.key)-valhalla-coverage.json \(.value.valhallaCoverageSize)"' "$MANIFEST" \
  | sort | comm -23 - "$ASSETS")
if [ -n "$MISSING" ]; then
  echo "::error::coverage pinned but not served on $TAG at that size: $(echo $MISSING)"
  exit 1
fi
echo "Coverage gate: all $(jq '.regions | length' "$MANIFEST") regions have their coverage file on $TAG."
