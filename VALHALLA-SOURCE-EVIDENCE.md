# Dispatch-only clean-source Andorra graph evidence

Prepared for independent review; **not dispatched, compiled or exercised on Linux/native consumers**. Existing production extraction defaults remain unchanged. The separate `.github/workflows/valhalla-source-evidence.yml` has no schedule, publication input, release/tag command, package-write permission or production download target. Its only output is a seven-day evidence artifact plus provenance attestation.

## Authority model

This is `same-run-clean-source`, separate from the prebuilt image model in `valhalla-evidence-builders.json`. That image allowlist stays empty and continues to reject image-based evidence builds. The new job checks out upstream Valhalla core `e2f017b16080f49203de245a211b09efab09cf72` (the mobile gitlink), verifies all 21 recursive submodule commits in `scripts/valhalla-source-build-pins.json`, and refuses dirty, missing, extra or wrong source before and after building. The core is mounted read-only; a newly created output directory is mandatory. Every graph command uses the absolute path of its freshly built or source-configured tool; tool hashes are checked again before publication.

The Linux amd64 standard base is Ubuntu's immutable manifest `sha256:a61567bd31828687156d735ea8eb01ba4e37636e225dd6a48ba94136a70d9d61`, verified through Docker Hub manifest metadata on 2026-09-14. This asserts the base identity, not prebuilt Valhalla source provenance. Ordinary signed Ubuntu package installation records all installed versions, every downloaded `.deb` archive hash, compiler/build utility hashes and apt source-file hashes. **The apt dependency closure is not locked and this build is not hermetic or bit-reproducible.** The pinned upstream timezone script retrieves its fixed 2025b release data; that dependency is also not content-pinned, and its generated SQLite hash is retained explicitly. No mutable Valhalla builder or unpinned prime_server clone is used: `ENABLE_SERVICES=OFF` still builds the one-shot `valhalla_service` CLI.

The receipt records workflow source SHA/run ID, core/submodule/base pins, dependencies, CMake cache/compile-command hashes and tool hashes. Exact configs, timezone/admin database hashes, compressed graph hash and per-tile inventory bind graph generation to that receipt. GitHub build-provenance attestations bind the graph and metadata archive to the checked-out extractor workflow/source run. Consumers must verify those attestations and receipt hashes against the reviewed workflow commit; merely seeing a JSON receipt is not sufficient.

## Source and labels

Only the exact 2026-09-12 Andorra PBF and polygon hashes retained in `valhalla-evidence-source-metadata-20260914.json` are admitted. Full PBF bytes, PBF replication header, polygon bytes, all retained highway ways, ordered node IDs, versions, tags and coordinates are retained. Source selection polygons describe clipping semantics; **they are not installed graph edges**. Geofabrik retains complete crossing ways, and the current polygon's historical association with the dated PBF is not asserted.

The sanity route selects endpoints of the first eligible source highway before invoking the engine and retains the actual CLI response; it requires integer success status, finite positive trip/leg distance and duration, and bounded, decoded, geographically valid non-degenerate polyline6 geometry; it is only a graph-readability smoke test, not an independently labelled road-sequence test. Negative and boundary labels remain unresolved. The full source segment topology and graph inventory support a later independent label audit; exact routable-edge/coverage boundaries still need graph inspection. Preserve historical fixtures and captures, freeze a new source cohort before looking at matcher outcomes, and satisfy the full C3 eight-class matrix with at least two held-out positives per class, including boundary cases. Eight multi-window fixtures alone cannot satisfy that acceptance bar. No app admission gate changes here.

## Bounds and failure behavior

The shared evidence implementation caps source PBF at 16MiB, polygon at 128KiB, decoded XML at 64MiB, compressed graph/individual published files at 32MiB, full expanded TAR (including PAX/GNU metadata/padding) and published bundle at 128MiB. At most 8192 archive members and 128 evidence files are allowed. Every archive path/type/duplicate is checked; a full streaming decompression cap runs before tarfile parses extended metadata. All incomplete output stays private. Publication is an atomic rename only after complete validation; failed preparation exposes only a small failure receipt. Compiler output, apt archives and world timezone intermediates stay on the ephemeral CI runner, outside uploaded paths.

The runner uses two CPUs, 10GiB container memory and a 120-minute workflow timeout. A source build may exceed those limits; such a run must fail with retained failure metadata, not silently fall back to installed binaries. Actual Linux package/build compatibility has not been tested yet. Any first-run failure remains evidence to fix before runtime acceptance.

## Validation and next execution

Local, no-build checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_valhalla*.py'
bash -n scripts/valhalla-source-dependencies.sh
```

The test suite includes source mismatch/dirty checkout, recursive gitlink mismatch/duplicate, missing workflow identity, tool symlink substitution, fake/empty CLI success, retained source/graph integrity, archive traversal/duplicate/count, expanded PAX metadata, oversized output and atomic failure-publication regressions. Tests use synthetic data only; they do not manufacture native acceptance.

After independent review, parent may choose a public source commit/branch and dispatch this separate workflow. No dispatch is authorized by this document. After successful capture, verify attestation subject SHA against the exact reviewed workflow/run, validate receipt and PBF/graph/config hashes, then prove graph format and road traversal against the clean mobile wrapper on both platforms. Device/simulator queue leases and the active endurance run remain parent-owned prerequisites; this workflow does not touch devices. Runtime acceptance, boundary/negative label review, train/held-out freezing and full C3/C4 bars remain pending.
