# Plan section: what the routing tiles need for the six presence avoids (Rods FEAT-185)

Status 2026-11-24: plan only. No routing-tile build, no engine patch, nothing published. Scope: speed bumps, chicanes,
narrowings, islands, dips, railway level crossings: the six avoid buttons the routing cannot act on today
(Rods `doc/specs/custom-routing/PROJECT-PLAN.md` §4.1, §4.2). Read against Valhalla 3.6.3 (the fork's base).

## Why they do nothing today

- `lua/graph.lua` `nodes_proc` returns the node's tags with additions; it drops neither `traffic_calming` nor `railway`.
- `src/mjolnir/pbfgraphparser.cc` `node()` (around line 2120) then reads only the keys it knows: `highway` →
  signal / stop / give-way bits, gates, bollards, tolls, names. **No branch reads `traffic_calming` or
  `railway=level_crossing`**, so both are lost at parse time. The S1 development patch accepts the six avoid ids
  and they are inert.
- Room exists everywhere on the way: `OSMNode` has `spare_ : 11` (`osmnode.h`); the graph builder's
  `Edge::EdgeAttributes` has `spare : 21` (`node_expander.h`); `DirectedEdgeExt` is one unused 64-bit word
  (`directededge.h`), where the plan's §4.2 allocates one presence bit each for the six.

## What the tiles need, step by step

1. **One shared tag table.** The app's packs map `traffic_calming` values in `extract-single.ts`
   (`TRAFFIC_CALMING_TYPES`, `mapTrafficCalmingType`): `bump, mini_bumps, hump, table, cushion, dynamic_bump` →
   speed bump; `dip, double_dip` → dip; `chicane`; `choker` → narrowing; `island`; semicolon lists split.
   The parser must use exactly this table, so move it to one checked-in file both read (§4.2: "one checked-in
   OSM-tag → type table is used by both"). Values outside it (`yes`, `rumble_strip`, `painted_table`, …) are
   neither shown nor avoided. Level crossing = `railway=level_crossing` only (`railway=crossing` is foot,
   `railway=tram_level_crossing` is tram).
2. **Parser:** in `node()`, for way nodes, set five new `OSMNode` bits from the table and a sixth from
   `railway=level_crossing` (6 of the 11 spare). A level crossing on a `railway=tram` way cannot be told at node
   time; accept it (Lithuania has none) and let the count gate below catch a region where it matters.
3. **Graph builder (`graphbuilder.cc`, edge loop near line 270):** a feature on a shape point (not a graph node)
   sets the matching bit on the edge's attributes (6 of the 21 spare). It must be its own `if`, not part of the
   existing `else if` chain for signal / stop / yield, because one node can be a signal and a raised table.
   A feature on a graph node (a junction) marks every directed edge that ENDS at that node, never the edges
   leaving it, and never splits an edge into a new node (§4.2: new nodes would move Fastest lines through
   shortcut topology). That matches what the app does for callouts: a route through the junction meets it.
4. **Ext word:** the directed edges of both directions get the bits (none of the six is directional: presence is
   enough, §4.2). Every later stage must carry the ext array with a matching count, or the tile writer drops the
   whole array (`graphtilebuilder.cc:302`): enhancer, hierarchy, the shortcut stage (copies the first edge's
   word unchanged; Rods requests never take shortcuts, §4.8) and the filter stage.
5. **Costing:** the S1 patch already parses the six ids; with bits present they become strict rejects in rods mode
   by presence, both search directions (A1). Nothing per request changes.
6. **Old tiles:** the pack manifest's `extWordVersion` (§4.2) tells the app a tile set without the word; the six
   pills grey with the "needs a newer map" line there (owner question 1 in the S7 status, R32).
7. **Same snapshot:** the routing tiles and the app's region pack must come from one OSM snapshot, so what is
   avoided and what is drawn agree.

## Release gate for these six (the §4.2 rule, with Lithuania's inputs)

Per feature, distinct base-level directed edges marked in the tiles vs the number the same assignment rule gives
on the app's own extract of the same snapshot, within 15 %. Lithuania, Geofabrik 2026-11-23, points on roads the
app knows (motorway … service, no tracks, driveways or parking aisles):

| Feature | Points on those roads | In the pack's `traffic_calming` (any way) |
|---|---:|---:|
| Speed bump | 3,599 | 3,783 (183 on footways, driveways and other ways, 1 on none) |
| Island | 49 | 49 |
| Chicane | 6 | 6 |
| Narrowing | 3 | 4 |
| Dip | 0 | 0 |
| Level crossing | 1,015 (`railway_crossings`, new table) | — |

Expected marked directed edges ≈ 2 per shape-point feature (both directions), plus every inbound edge for a
feature on a junction node. The gate must compare like with like: `traffic_calming` in the pack is not road-gated,
the tiles are (a bump on a footway marks a foot edge no car takes), so the expected side counts only the
road-gated points above. Small counts (chicane, narrowing) make 15 % meaningless; use an absolute ± 2 under 20.

## Cost

Six bits inside the word §4.2 already budgets (8 bytes per directed edge, paid once for all Rods fields); parser
and builder work is one table lookup per tagged node. No new graph nodes, so Fastest lines do not move (the
§4.2 stock-vs-patched Fastest identity check still applies).

## Not in the tiles

Speed cameras and danger zones stay per-request costs (§4.1). Traffic lights, stop and give-way already have tile
flags; their counters are §4.2's other 10 bits.
