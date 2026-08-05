# Valhalla pack → manifest integration (P1.6 fields DONE; rollout owner-gated)

The smoke workflow (`.github/workflows/valhalla-tiles.yml`) is deliberately standalone:
it publishes to its own `valhalla-smoke-*` **prerelease** and never touches the
production `manifest.json` or the monthly pipeline. This note tracks what is already
implemented for the FEAT-033 P1.6 app contract and the exact remaining steps for
wiring Valhalla packs into the production manifest when the all-regions rollout is
approved.

## P1.6 app contract (IMPLEMENTED)

- Release asset per region named EXACTLY `{regionId}-valhalla.tar.gz` — a gzip of the
  SINGLE tar produced by `valhalla_build_extract` (index.bin + graph tiles) that
  `mjolnir.tile_extract` memory-maps. Never a hand-rolled `tar cf` of the tile dir.
  Engine and extract tool run from ONE digest-pinned valhalla image per CI run.
- `scripts/generate-manifest.ts` now emits, per region, when
  `{regionId}-valhalla.tar.gz` sits in its input dir (additive, optional):
  ```ts
  valhallaSize?: number;      // {regionId}-valhalla.tar.gz size in bytes
  valhallaChecksum?: string;  // SHA256 of the tar.gz, first 16 hex chars (computeChecksum)
  ```
  The core-file scan filters `*.json.gz`, so `-valhalla.tar.gz` can never become a
  phantom core region.
- CI sanity gate runs `valhalla_service` in TILE_EXTRACT mode against the tar
  gunzipped from the shipped asset — a pack that routes in tile_dir mode but not
  tile_extract mode fails the job.
- P1.8 support: each region also ships `{regionId}-corridors.json` — an array of
  `{name, request, response}` with the full valhalla route response captured during
  CI verification.
- Smoke prereleases ship their own `manifest.json` (+ legacy `valhalla-manifest.json`
  copy) carrying only the valhalla fields — safe because a prerelease can never
  become `releases/latest`.

App side (Rods repo): the manifest interface in `services/osm/types.ts` carries the
same two optional fields. Additive-only — existing consumers ignore unknown JSON keys.

## HARD CONSTRAINT: the 1000-asset release cap

GitHub releases cap at **1000 assets** and the monthly release already sits at ~937
(4 files x 233 regions + manifest; see the `-builtup.json.gz` note in
`osm-extract.yml` — the cap has been hit before). 233 tars + 233 `.sha256` files can
NEVER ride the monthly `osm-YYYY-MM-DD` release.

Rollout shape that fits:
- The monthly run builds valhalla packs and uploads them to a **separate release**
  tagged `valhalla-<YYYY-MM-DD>` (same date as the monthly tag = same `dataVersion`
  stamp for all artifacts of the run, matching the existing version convention).
- `manifest.json` (still on the monthly release) carries `valhallaSize`/
  `valhallaChecksum`; clients derive the download URL from the shared date:
  `releases/download/valhalla-<version>/<regionId>-valhalla.tar.gz`.
- To generate those fields, download/copy the tars into the manifest input dir
  before `generate-manifest` runs (the same-directory scan is already implemented).
- Consider dropping the per-region `.sha256` sidecars at rollout (the manifest is the
  checksum source of truth) to halve the new release's asset count.

## Known gaps to close at rollout (do NOT enable before fixing)

1. **`regenerate-manifest.yml` would silently DROP the valhalla fields**: it rebuilds
   the manifest only from the target release's assets, and the tars live on a
   different release. Fix: also `gh release download valhalla-<version>` into the
   input dir (or carry the `valhalla*` fields over from the pre-repair manifest).
   Add `valhallaSize`/`valhallaChecksum` to its field-diff list too.
2. **`verify-manifest.yml`** HEAD-checks only `sqliteSize` today — extend it to
   `valhallaSize` against the `valhalla-<version>` release URLs.
3. **Sanity routes**: the smoke workflow refuses to build a region without a
   hardcoded in-region route pair (`SANITY_ROUTES` env). 233 regions need a
   generalized source (e.g. a `sanityRoute` city pair per region in
   `scripts/regions.json`) — a pack must never ship unverified.
4. **Runner budget**: sequential-ish tile builds are CPU-heavy; with 233 regions at
   ~5-90 min each, keep `max-parallel` and the delete-old-releases interplay in mind
   (`delete-older-releases` counts ALL releases toward `keep_latest`, including the
   `valhalla-*` tags — bump `keep_latest` or filter by tag prefix when integrating).

The all-regions rollout stays OWNER-gated: nothing in this repo builds valhalla packs
for any region outside the explicit `regions` input of the smoke workflow.
