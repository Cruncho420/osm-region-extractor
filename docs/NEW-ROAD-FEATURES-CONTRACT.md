# New road features in the region pack: reader contract (Rods FEAT-264 / FEAT-185 S9a)

Version 1, 2026-11-24. Producer: `scripts/newRoadFeatures.mjs` (rules) → `extract-single.ts` writes
`{region}-roadfeatures.json.gz` (never uploaded) → `build-sqlite.ts` writes four tables into the one file the app
downloads, `{region}.sqlite.gz`. Tests: `scripts/newRoadFeatures.test.mjs`.

## Is this a pack with the four tables? (old-pack test)

```sql
SELECT value FROM metadata WHERE key = 'newRoadFeaturesVersion';
```

- **No row = old pack** (built before this change, or the region's road-feature pass failed, which is non-fatal by
  design). The reader returns no features and no error, and never creates or writes these tables.
- **A row = the four tables exist and are complete for the region** (a table may legitimately have 0 rows: a region
  with no mapped railway crossings).
- Decide on the KEY, not on table existence: if the app ever adds these tables to its own `SCHEMA_SQL`
  (`CREATE TABLE IF NOT EXISTS` at open, as it does for `toll_points`), an old pack would then show empty tables.
- `rows:<table>` (e.g. `rows:stop_signs`) carries each table's row count, for diagnostics.
- **Never a download gate.** These tables must not join `road_surfaces` / `road_ways` in the missing-data check:
  a gate on data the current release does not carry re-downloads every region forever (ARCH-04 in the Rods
  `docs/OSM_DATA_PIPELINE.md`).

**Versioning.** `newRoadFeaturesVersion` is an integer. A column is never removed and never changes meaning; a
change of meaning gets a new column or table and a higher version. So a reader built for version N reads any pack
with version ≥ N, selecting **named columns only** (never `SELECT *`). Old app builds never `SELECT` from these
tables, so a new pack is invisible to them (the `toll_points` precedent).

## Units and conventions (all tables)

| Thing | Unit |
|---|---|
| `lat`, `lon`, `centre_lat`, `centre_lon` | WGS84 degrees, the OSM node position (7 decimals; NOT rounded to the 6 decimals of `road_ways.coords`, a difference under 0.1 m) |
| `approach_bearing_deg` | degrees clockwise from true north, [0, 360): the direction of **travel** of the driver the feature applies to, measured on the road arriving at the node |
| `node_id` | OSM node id of the feature |
| `way_id` | OSM way id of the road the row's approach is on; joins `road_ways.osm_id` |
| booleans | INTEGER 0 / 1 |
| distances in the rules | metres, great-circle |

Only roads the pack itself carries count: `highway` motorway … service (the `road_ways` set without `track`,
driveways and parking aisles). A feature on no such road is not written.

## Tables

### `traffic_lights` — one row per signal node; rows sharing `junction_id` are ONE place

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | row id (per build, not stable) |
| `node_id` | INTEGER | the signal node |
| `lat`, `lon` | REAL | the node |
| `junction_id` | INTEGER | the place: the smallest `node_id` among its members. One pin per place (R36, R47) |
| `centre_lat`, `centre_lon` | REAL | mean of the place's members: where the pin goes |
| `junction_node` | INTEGER | 1 = this member IS the junction node (≥ 3 road arms meet): it applies to every approach |
| `way_id` | INTEGER | a road the node is on (for a junction node, one of them) |
| `approach_bearing_deg` | REAL NULL | the travel direction this member faces; NULL = applies both ways / unknown (always NULL on a junction node) |
| `direction_source` | TEXT NULL | `tag` (`traffic_signals:direction` / `direction` = forward / backward), `position` (the member stands before a junction on one side only, within 60 m), `oneway` (one-way road), NULL |
| `layer` | INTEGER | effective layer of its road (`layer`, else bridge 1 / tunnel −1 / 0); places never mix layers |
| `kind` | TEXT NULL | `traffic_signals=*` value (`signal`, `pedestrian_crossing`, …), `crossing` for a `crossing=traffic_signals` node on the carriageway, NULL untagged |

Kept: `highway=traffic_signals`, and `crossing=traffic_signals` on a road (R47: pedestrian signals on the carriageway
count; R56: signals on footways, cycleways, paths and tram-only track never reach this table, because they have no
road). Place rule: members are within **60 m of every other member** at the same layer (complete linkage, FEAT-264
spec §11.2), so a street of lights never chains into one place. Callout use (R103): the place is relevant to a route
that travels a member's road in its `approach_bearing_deg`, or passes a `junction_node` member; a reader that wants
tagged directions only filters `direction_source = 'tag'`.

### `stop_signs` and `give_way_signs` — one row per sign APPROACH (same columns)

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | row id |
| `node_id` | INTEGER | the sign node (one node can give more than one row: an all-way stop, or an untagged sign on a junction node with two minor arms) |
| `lat`, `lon` | REAL | the node |
| `way_id` | INTEGER | the road of this approach |
| `approach_bearing_deg` | REAL NOT NULL | travel direction of the drivers the sign applies to. A sign without a usable direction is **not written** (R69 / Q-Y) |
| `direction_source` | TEXT NOT NULL | `tag` (`direction=forward/backward`, or a compass value = the way the sign faces, travel = opposite, matched to a road arm within 45°), `oneway`, `geometry` (R69: the sign's road is the clearly minor one at a junction within 30 m; or on a junction node, the arms of lower class than the main road), `all_way` (`stop=all`) |
| `at_intersection` | INTEGER | 1 = ≥ 3 road arms meet within 30 m ahead (service roads and roundabout nodes excluded) — "intersection with stop sign" (R106) |
| `roundabout_entrance` | INTEGER | 1 = a roundabout ring or mini-roundabout within 25 m ahead — silent in speech, pin shows (R104) |

### `railway_crossings` — one row per road-over-rail level crossing node

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | row id |
| `node_id` | INTEGER | the `railway=level_crossing` node |
| `lat`, `lon` | REAL | the node |
| `way_id` | INTEGER | the road |
| `barrier` | TEXT NULL | `crossing:barrier` as tagged (`no`, `half`, `double_half`, `full`, …) |
| `light` | TEXT NULL | `crossing:light` as tagged |

`railway=crossing` (foot) and `railway=tram_level_crossing` are other tags and never selected; a `level_crossing`
node on a `railway=tram` way is excluded. A double track gives two nodes a few metres apart: the callout's 50 m join
(R115) makes them one call.

## Relation to the callout lane's proposed rows (Rods `.feature-review/FEAT-264/HANDOFF-callout-logic.md`)

Every field it proposes is here under its name: `lat`, `lon`, `approach_bearing_deg`, `at_intersection`,
`roundabout_entrance`, `junction_id`, `centre_lat` / `centre_lon`; its `id` is `node_id`. Differences: `junction_node`
is a 0 / 1 flag on each member (the junction node's id is that member's `node_id`); a light's `approach_bearing_deg`
is also filled from position and one-way roads, told apart by `direction_source`; places are joined by distance at
the same layer (60 m, every pair), not by graph topology. Extra columns: `way_id`, `direction_source`, `layer`, `kind`,
`barrier`, `light`.

## Where the tables are defined, and what moving them would take

`NEW_ROAD_FEATURES_SCHEMA_SQL` in `build-sqlite.ts`, deliberately outside `SCHEMA_SQL`: the Rods app runs its own
`SCHEMA_SQL` on every pack it opens, and a Rods test (`osmSchemaAndBbox.test.ts`) requires the two `SCHEMA_SQL`s to be
identical. Moving the tables into `SCHEMA_SQL` is one coordinated change in both repos, landed app side first.

## Lithuania, 2026-11-23 snapshot (first local build)

Geofabrik `lithuania-latest` of 2026-11-23, built locally (never published). 75,062 km of road in the pack's road set.
Every run prints the same figures on the `[road features 1/1]` line of `extract-single.ts`.

| | Traffic lights | Stop | Give-way | Railway crossing |
|---|---:|---:|---:|---:|
| Nodes in OSM | 3,927 | 1,208 | 7,150 | 1,769 |
| Not on a road the app knows (footway, track, driveway, none) | 84 | 101 | 420 | 754 (333 on driveways, 83 on tracks) |
| Rows written | 3,843 | 1,091 | 6,727 | 1,015 |
| Places (lights) / signs with a usable direction | 1,013 places at 60 m (1,271 at 40 m) | 1,090 of 1,107 (98.5 %) | 6,727 of 6,730 (99.96 %) | — |
| Per 100 km of road | 1.35 places | 1.45 | 8.96 | 1.35 |
| Direction from | tag 424, position 1,630, one-way 708, junction node (all approaches) 644, none 437 | tag 1,008, one-way 79, geometry 4 | tag 5,951, one-way 775, geometry 1 | — |
| At an intersection / roundabout entrance | — | 830 / 0 | 5,848 / 811 | — |
| Same-kind nodes within 2 m | 4 pairs | 1 | 0 | 2 (double track) |

Lights: members per place 1 to 14 (217 single-node places), place span median 25 m; 182 places have another place
centre within 80 m, the candidates for one big junction split in two (the clutter test of R36).
Pack: `europe-lithuania.sqlite.gz` 79,461,171 → 80,165,291 bytes (+0.9 %); every pre-existing table byte-identical.
Time: the road-feature pass takes 6–11 s; the region's extract 41.7 → 43.3 s, SQLite build 45.5 → 50.5 s (same load).
