# TODO(P1.1-manifest): Valhalla pack → manifest integration (owner-gated rollout)

The smoke workflow (`.github/workflows/valhalla-tiles.yml`) is deliberately standalone:
it publishes to its own `valhalla-smoke-<run_number>` **prerelease** and never touches
`manifest.json` or the monthly pipeline. This note is the exact recipe for wiring
Valhalla packs into the production manifest when the all-regions rollout is approved.

## Fields to add (additive only — never change existing fields)

`scripts/generate-manifest.ts`:

1. `ManifestRegion` interface: add
   ```ts
   valhallaSize?: number;      // {regionId}.valhalla.tar.gz size in bytes
   valhallaChecksum?: string;  // SHA256 of the tar.gz, first 16 hex chars (computeChecksum)
   ```
2. In the per-region loop, after the `.sqlite.gz` block, add the same
   `statSync`/`computeChecksum` try/catch pattern keyed on `${regionId}.valhalla.tar.gz`.
   Populate the two fields **only when the file exists** — regions without a pack keep
   an unchanged manifest entry.
3. No change needed to the core-file scan: it filters `*.json.gz`, so `.valhalla.tar.gz`
   can never become a phantom core region.

App side (Rods repo): add the same two optional fields to the manifest interface in
`services/osm/types.ts`. Additive-only — existing consumers ignore unknown JSON keys.
Smoke releases already ship a `valhalla-manifest.json` using these exact field names,
so app-side code can be tested against real assets before rollout.

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
  `releases/download/valhalla-<version>/<regionId>.valhalla.tar.gz`.
- To generate those fields, download/copy the tars into the manifest input dir
  before `generate-manifest` runs (the same-directory scan from step 2 then works).
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
