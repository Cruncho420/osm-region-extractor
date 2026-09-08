# OSM Region Extractor

Extract regional OpenStreetMap data from Geofabrik PBF files into compact SQLite databases.

## What It Does

1. **Monthly Extraction**: GitHub Actions extracts data from Geofabrik PBF files on the 1st of each month
2. **GitHub Releases**: Extracted data is published as GitHub Release assets
3. **On-Demand Download**: Clients download region data on-demand via release URLs

## Data Format

Each region produces a SQLite database (`{region-id}.sqlite.gz`) containing:
- Traffic calming features (speed bumps, dips, bridges, tunnels, speed cameras)
- Roundabouts (full and mini)
- Road surfaces (asphalt, gravel, cobblestone, dirt, etc.)
- Road ways (dense road geometry)

## Manual Trigger

To manually run the extraction:
1. Go to Actions → Monthly OSM Data Extraction
2. Click "Run workflow"

## Connected Valhalla partition integrity (build-only)

After reconstructing two packs into separate tile directories, run:

```sh
node scripts/verify-valhalla-partitions.mjs /absolute/unsplit /absolute/pack-a /absolute/pack-b > partition-integrity.json
node --test scripts/verify-valhalla-partitions.test.mjs
```

Use stationary, trusted staging directories with no concurrent writers. The command
streams SHA256 over every actual `.gph` file and requires the two-pack union to
match the unsplit graph at every unchanged relative path. It rejects missing,
extra, changed or conflicting tiles, empty packs, duplicate packs, symlinks,
traversal paths and non-regular members. Both packs must contribute exclusive
tiles and share at least one tile. Numeric directory/file names are checked for
safe layout only; GraphId validity, hierarchy and bounds are not inferred.
Top-level `index.bin` is ignored after checking that it is a regular file; tar
indexes must come from `valhalla_build_extract`, never this verifier.

Success writes deterministic JSON inventories with per-tile byte counts and full
SHA256 hashes, aggregate inventory hashes, and shared/exclusive paths and counts.
Failure exits nonzero without a success receipt. The inventory hash is SHA256 of
the compact JSON tile array, sorted lexically by relative path. Contents are
streamed, but inventories occupy memory proportional to the number of tiles.

This is an unchanged-tile-union gate only. It does not prove input snapshot
provenance, valid native graph contents, offline route equivalence, persistent
actor behavior, individual-pack graph closure or global production scalability.
It does not build, download, publish or modify routing data.

## Native host crossing proof (caller-supplied fixture)

Run inside the pinned Valhalla Python image, with networking disabled externally:

```sh
python3 scripts/verify-valhalla-crossing.py \
  --request /proof/request.json --partition-receipt /proof/partition-integrity.json \
  --unsplit /proof/unsplit-config.json --union /proof/union-config.json \
  --first /proof/first-only-config.json --second /proof/second-only-config.json \
  --timeout 120 > crossing-evidence.json
python3 -m unittest discover -s scripts -p 'test_verify_valhalla_crossing.py'
```

All four config files must specify actual absolute local tile directories and
explicitly disable the global synchronized cache. Extract, remote tile URL,
traffic extract and incident sources are refused. All four configurations must
be identical except for `mjolnir.tile_dir`, checked
before any native worker starts so differing settings cannot imitate missing data.
Keep staging trees immutable; actual tile hashes are checked against the partition receipt before and after
execution. Each supplied auto-costing location must have a finite explicit
`search_cutoff` between 1 and 1000 metres. Requests use JSON/polyline6 without a
date/time. No fixture coordinates are generated or declared verified by this tool.

One child process retains one unsplit actor and one union actor for cold/warm
route comparisons. Leg shape, distance, duration and ordered exact `edge_walk`
edge IDs must agree; native GraphId file paths must include exclusive tiles from
both packs and shared tiles. Each one-pack negative runs in a fresh subprocess.
Only exact pinned native RuntimeError messages for errors 170, 171 and 442 count
as route rejection; construction errors, unknown messages, timeouts, crashes and
unexpected successful routes fail the gate. Error codes are inferred from exact
messages because the Python binding exposes runtime-error text, not typed codes.

Success emits JSON with route shapes, edge/path evidence and timings. Optional
`--source-facts facts.json` is carried as explicitly unverified caller metadata.
This proves a host-side pack crossing, not a national border, mobile integration,
native memory behavior or global scalability. External network isolation and
engine provenance remain separate requirements. Python unit tests use fake
bindings and prove checker logic only; they are not native graph acceptance.

## Whole-tile connected graph partition

In the pinned Python Valhalla image (which includes Shapely), run:

```sh
python3 scripts/partition-valhalla-connected.py --source /proof/unsplit \
  --first-poly /proof/lithuania.poly --second-poly /proof/latvia.poly \
  --first-out /proof/staged-first --second-out /proof/staged-second > partition.json
python3 -B -m unittest discover -s scripts -p 'test_partition_valhalla_connected.py'
```

The helper parses outer rings and holes from both real `.poly` files and checks
whole native-identified L2 tile boxes against those polygons. L2 boxes use the
0.25-degree constant from the pinned core revision; native bindings supply their
origins and canonical paths. Coarse L0/L1 tiles, overlapping tiles and explicitly
reported polygon-exterior leftovers are shared. Both exclusive L2 sets must be
nonempty before any output is created. Transit or noncanonical tiles are refused.

Outputs must not exist and must be outside the source, with existing real parent
directories on the same filesystem. All tile data is hardlinked unchanged; there
is no copying fallback. Keep inputs and outputs immutable because they share
inodes. A filesystem failure leaves partial output for inspection and fails the
command; nothing existing is overwritten or cleaned up. Package these staging
directories with pinned `valhalla_build_extract`, reconstruct actual compressed
artifacts, and run the separate integrity/crossing gates. This partition receipt
does not establish graph connectivity or any verified route coordinates. Tests
use rectangle geometry and native-binding fakes, plus a real-Shapely island-inside-hole
regression when Shapely is installed (otherwise explicitly skipped); no native graph
is exercised. Holes are attached to their owning outer component before union,
so a separate outer island inside a hole remains included.
Each hole must have exactly one containing outer ring; deeper or ambiguous
nesting, such as a hole inside that nested island, is refused before outputs.

## License

The extracted data is derived from OpenStreetMap and is available under the [ODbL](https://www.openstreetmap.org/copyright).
