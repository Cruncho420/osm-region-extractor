# Directed-edge source census preparation

Status: prepared for independent review; no census build, execution or dispatch yet. This is graph-data evidence, never matcher correctness or a complete label freeze. The historical matrix and matcher responses are untouched.

## Manual opt-in and unchanged default

`valhalla-source-evidence.yml` gains boolean `census_existing_graph`, default false. The existing graph capture steps remain unchanged under `!inputs.census_existing_graph`. True selects a separate census job, using the same registered workflow and existing concurrency exclusion. No production tile workflow, release, tag or container is published. Before dispatch, verify GitHub admits the new input on the exact reviewed branch; default-branch registration alone does not establish that. Do not silently run default capture if input admission fails.

## Immutable existing graph input

The new job downloads only GitHub artifact 10341602724 from successful run 34828738835, maximum 16 MiB. ZIP SHA-256 is `4f15fea95e686b0924fc4e14a113f09101ea3ef562ee34682b6da34c771af6ea`. Only the exact observed graph and Sigstore bundle entries are extracted. Graph SHA-256 is `d69510b46c5d1d2663ea0ac095039b80406ad51edb26db016401e7b80aa18c6c`. `gh attestation verify` requires repository Cruncho420/osm-region-extractor, signer workflow valhalla-source-evidence.yml, source and signer SHA `8d7a40f450e32efdec0c2c41863b768085593579`, exact branch source ref and GitHub-hosted runners. Any expiry, unavailable artifact, digest, signature or source mismatch stops the job; no fallback graph. The access token is provided only to this host-side fetch step, never to the build container.

The graph's original full PBF SHA is `087f397e9fce79b48c66cabfde149c7c9bc36e3d75ff4d4730082744b0523b25`; polygon SHA is `d875d3c72a180a34620bcd5dc92d31ae27dde8f4f28b14acc6dc249792872e83`. Those exact primary inputs and signed original metadata remain in the original artifact. The census does not rebuild graph data. The uncompressed extract must exactly hash to the authenticated gzip's full decompression before and after enumeration.

## Fresh source authority

The census executable compiles against exact core `e2f017b16080f49203de245a211b09efab09cf72` and the existing 21 recursive submodule pins, using the existing digest-pinned Ubuntu base. A small CMake project include adds only the new executable and explicitly requires C++20. All core tracked files remain read-only; the already reviewed timezone-only writable overlay permits exactly its known `leapseconds` generated output. Source identities and generated output hashes are checked before and after the build and enumeration. The receipt records executable, census source, CMake include/cache/compile command hashes, compiler/tool hashes, installed versions and downloaded package archive hashes. Ordinary signed apt installation is **not hermetic or fully reproducible**. Output census plus metadata archive are attested to this new source/workflow/run; original graph attestation and verification result are included.

Exact core APIs were read locally: `GraphReader::GetTileSet`, `GetGraphTile`, `DoesTileExist`, `GetOpposingEdgeId`; `GraphTile::GetAccessRestrictions`, `transition`, `get_node_ll`; node ranges/transitions; `DirectedEdge` access/use/restriction fields; `EdgeInfo::wayid/shape`. No actor, route, trace or matcher APIs are called. CMake integration has been inspected, not compiled locally.

## Completeness and meaning

Enumerate every installed tile, every node and every directed edge, with no hierarchy, road class, mode, length, ferry, unnamed-way or shortcut filter. Preserve numeric use/class codes, all 12 access bits in both directions, graph/way IDs, edge start/end, opposing edge, node access/transitions, full directed geometry and access restriction records/masks. Shortcuts remain identifiable; way ID zero remains zero. Missing end tiles remain explicit and do not become presumed clipping boundaries.

Before enumeration, the authenticated graph's real header counts independently establish required tiles/nodes/edges. Local read-only header verification found 7 tiles, 13,602 nodes and 31,450 directed edges. Validation requires exactly those sets/counts, unique exact encoded IDs, complete nonoverlapping node-owned edge ranges, endpoint/opposing consistency, bounded valid coordinates and a final count footer. False counts, omitted records, invalid masks, malformed geometry, oversized records or incomplete output fail closed. No header sizes or graph-format assumptions are generalized beyond this pinned source and exact graph.

The census is **not a costing engine**: conditional/complex turn restrictions are flagged, access restriction values retained, and original graph remains authoritative, but complex restriction paths/time-zone evaluation and actual auto eligibility still need independent policy review. Graph nodes are graph IDs, not claimed original OSM node IDs. Graph geometry/way association must be reconciled against retained full PBF evidence before authoring labels.

## Strict bounds and publication

Existing caps remain: compressed graph 32 MiB, entire decompressed TAR 128 MiB before tar metadata parsing, at most 8,192 archive members. Census limits: 500,000 nodes, 1,000,000 edges, 100,000 geometry points per edge, 4 MiB JSONL record, total 32 MiB file. Runtime also applies a 32 MiB OS file-size limit and 120-second enumeration timeout; container is 2 CPUs/10 GiB. All generated output stays in private directories until complete verification and the existing atomic publication gate (each file 32 MiB, all metadata 128 MiB/128 files). Oversize remains a failure, not permission to raise caps or filter edges. Census size at actual runtime is unmeasured.

Only bounded published metadata is uploaded. Failures expose a small receipt, never private partial output. The original 8.7 MB download ZIP is removed on the ephemeral runner after consumed verification; graph/signature remain for current consumers. Build/TZ/private intermediates exist only on the GitHub ephemeral runner and expire with it. No local build, archive download or scratch was created for this preparation.

## Remaining independent labels

A graph endpoint or missing neighboring tile cannot distinguish source clipping from a real cul-de-sac, denied access, isolated road or builder policy. The `.poly` defines source extraction, not installed road coverage. To admit coverage-boundary positives/negatives, review every candidate against the complete graph census plus full PBF highway/ferry/shuttle-train and barrier/restriction evidence. Pinned Lua explicitly admits some non-highway routes; the retained highway-only XML is not exhaustive.

Outside-source continuation still requires dated authoritative OSM continuation evidence for the selected frontier, or the original parent clipping receipt. The census cannot recover absent source objects. Do not manufacture negative labels, claim that a missing highway means no routable edge, or treat current OSM as proof of historical continuation. Preserve the historical cohort verbatim, then independently author a new version and satisfy all eight classes, at least two held-out positives per class (including boundary), original/resampled variants and spatial hold-out review **before observing any new matcher outcomes**.

## Validation receipt

`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_valhalla*.py'`: 39 tests pass, including 10 new census tests. Six malformed-field subcases were observed failing before validator fixes. Tests cover complete bidirectional/mode records, omissions, duplicate/index ownership, mismatched source digest, false endpoint coverage, missing/footer records, malformed access/geometry, oversized lines and private-failure publication. Shell syntax, YAML parsing and diff whitespace checks pass. Native compilation and actual census execution remain pending independent review and explicit dispatch.
