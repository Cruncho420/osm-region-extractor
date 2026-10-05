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
- Every pack also ships `{regionId}-valhalla-coverage.json` (Geofabrik's exact extract
  `.poly`, 10 km boundary-risk margin; `scripts/generate-valhalla-coverage.mjs`), pinned as
  `valhallaCoverageSize` / `valhallaCoverageChecksum`. The app refuses to route without it.
  `valhalla-tiles.yml` builds it per region and its finalize fails if any manifest region
  lacks it; `verify-release.ts` checks it; `valhalla-coverage-backfill.yml` repairs an older
  release. `merge-valhalla-fields.mjs` does NOT carry the coverage fields yet: extend it
  before that merge is ever used.
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

## ⚠️ The four "known gaps" listed here are all CLOSED (2026-08-09)

Kept as history because the closure is what the current design rests on:

1. `regenerate-manifest.yml` downloading the valhalla tars **and** a per-field guard
   that refuses to upload a manifest which DROPPED a previously published field.
2. `verify-release.ts` HEAD-checks `valhallaSize` **and** streams sha256 against
   `valhallaChecksum` — the field the app itself enforces.
3. Sanity routes generalized via `scripts/derive-sanity-route.mjs`; the 21 curated
   pairs remain only for archipelagos and ferry-separated landmasses, where no
   sampler can succeed.
4. Runner budget measured 2026-08-06: the largest region (asia-russia) takes 37 min,
   ~10% of the 6 h job cap. `delete-older-releases` is now scoped with
   `delete_tag_pattern: osm-`, so a monthly run can no longer evict a `valhalla-*`
   release — which it had already done once, destroying the only two packs that
   existed.

## 🔀 The manifest merge is NOT the delivery mechanism (decided 2026-08-09)

**The pins are NOT written into the monthly `manifest.json`.** The app resolves them
from **this release's own `manifest.json`** at runtime (`fetchManifestWithRoutingPins`
/ `resolveRegionPin` in the Rods repo), keyed on the tag
`valhalla-<monthly manifest version>`.

Why, in one paragraph: the app-side feature gate is an `EXPO_PUBLIC_*` variable, and
those are inlined at BUNDLE time. Store builds cut before that gate existed read the
raw variable, and a developer `.env` had it set. Those binaries are in the field
permanently — users who never update keep them — so the moment the shared manifest
carried `valhallaSize`, they would offer real users a routing-pack download for
geometry that never passed the field gate. Delivering the pins on a separate file
makes that impossible by construction: an older binary has no code to fetch it, and
the file it does read never changes. It also means the rollout has **no irreversible
step** — rollback is deleting a prerelease — and keeps the OSM road-data downloads,
which share that manifest, entirely out of the blast radius.

`merge-valhalla-manifest.yml` + `scripts/merge-valhalla-fields.mjs` are built, tested
and reviewed, and are deliberately **unused by the rollout**. They exist for a later
decision to move the pins into the manifest once a gated build is broadly adopted.

## Rollout runbook

```bash
# 1. One region, throwaway tag. Proves the publish path end to end.
gh workflow run valhalla-tiles.yml -f regions=estonia -f upload=true -f prune_old_smoke=false

# 2. Production tag. MUST equal valhalla-<version of the manifest served as latest>
#    or every download 404s. Batches append; re-dispatch just the failed ids.
gh workflow run valhalla-tiles.yml -f regions=<comma list> -f tag=valhalla-YYYY-MM-DD -f upload=true

# 3. Verify what GitHub SERVES against what it CLAIMS (streams sha256, no disk).
cd scripts && npm ci && npm run verify-release -- \
  --manifest-url "https://github.com/Cruncho420/osm-region-extractor/releases/download/valhalla-YYYY-MM-DD/manifest.json"
```

Batches are safe to run concurrently: `prepare-release` tolerates losing the
create race, each build job uploads its own tar and HEAD-checks it, and `finalize`
ACCUMULATES into the release manifest rather than replacing it. There is deliberately
no workflow-level concurrency group — GitHub queues only one pending run per group and
cancels earlier pending ones, which would silently drop a batch.

The all-regions rollout stays OWNER-gated: nothing here builds packs for any region
outside the explicit `regions` input.

## Manifest pointers: which packs and maps phones read (since 5 Oct 2026)

The monthly `manifest.json` carries `valhallaPackTag` and `basemapTag`. Rods builds that read routing
packs / offline maps take them from those releases; a manifest without them (all before Nov 2026) makes
the app derive `valhalla-<version>` / `basemap-<version>`. `generate-manifest.ts --previous` carries both
forward from the last published manifest (`scripts/manifest-pointers.mjs`; the first run after this
change seeds them as `<prefix>-<previous version>`, i.e. what phones already read), so **an ordinary
monthly road-data refresh does not move any phone's routing packs or maps**. Store apps that do not
read the fields are unaffected. Why: Rods `doc/specs/mapbox-exit/results/OPS-monthly-run-1005.md` §6.

To move phones to new packs/maps with a monthly run (the aligned 1 Nov release):

```bash
# 1. Publish BOTH releases first (prereleases): the box's packs + valhalla-manifest.json, and the basemap
#    (dispatch basemap-tiles.yml by hand with that tag). Any tag name works; the date no longer has to match.
# 2. Name them for the next run:
gh variable set MANIFEST_VALHALLA_PACK_TAG -R Cruncho420/osm-region-extractor --body valhalla-2026-11-01
gh variable set MANIFEST_BASEMAP_TAG       -R Cruncho420/osm-region-extractor --body basemap-2026-11-01
# 3. The monthly run (cron or `gh workflow run osm-extract.yml`). Its release REFUSES to publish if a
#    variable names a release that is not published. Set only one variable to move only that product.
# 4. After it publishes, delete both (the next run then carries the new tags forward by itself):
gh variable delete MANIFEST_VALHALLA_PACK_TAG -R Cruncho420/osm-region-extractor
gh variable delete MANIFEST_BASEMAP_TAG       -R Cruncho420/osm-region-extractor
```

`regenerate-manifest.yml` keeps a release's own pointers and refuses to change them. There is no
separate "move the pointers on the live manifest" workflow: moving them between monthly runs means
another extract run with the variables set.

## Arming the monthly chains (since 5 Oct 2026)

`chain-valhalla-after-extract.yml` and `chain-basemap-after-extract.yml` run after every successful
monthly extract, but **only dry-run** unless a repo variable names the exact tag being built. A chain
publishes to `valhalla-<road-data version>` / `basemap-<road-data version>`; phones read those only once
the manifest points at them (above), and the
routing server's planet-built packs must own the valhalla tag (RT-18), so publishing either is a
release decision, never a side effect of a road-data refresh. Why: Rods
`doc/specs/mapbox-exit/results/OPS-monthly-run-1005.md`.

Since the manifest pointers, a chain runs AFTER the manifest is written, so what it publishes reaches
phones only when a later run names it. For the aligned 1 Nov release, publish first and set the
`MANIFEST_*` variables (above); keep the chains disarmed. To arm one month anyway (example: the extract
publishes `osm-2026-11-01`):

```bash
gh variable set CHAIN_BASEMAP_ARMED_TAG  -R Cruncho420/osm-region-extractor --body basemap-2026-11-01
gh variable set CHAIN_VALHALLA_ARMED_TAG -R Cruncho420/osm-region-extractor --body valhalla-2026-11-01  # only if GitHub-built packs are wanted on that tag
```

The tag is the UTC date on which the extract's release step publishes (`date +%Y-%m-%d` after all
regions are built), not the cron date: Aug and Sep 2026 published on the 2nd. If unsure, let the chain
run dry, check `gh release list`, then dispatch the chain by hand with `dry_run=false`; a mismatched
variable fails safe (dry, with a `::notice::`). Disarm afterwards with `gh variable delete <name>`: a
variable left armed stays live for re-runs while `releases/latest` still carries that tag. A manual
dispatch is dry unless `dry_run=false` is passed explicitly.
