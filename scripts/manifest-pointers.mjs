/**
 * manifest-pointers.mjs — which routing-pack and offline-map releases a road-data manifest names.
 *
 * PURPOSE: Rods reads its routing packs from `releases/download/<valhallaPackTag>/` and its offline
 *   maps from `<basemapTag>/` when the monthly manifest.json carries those fields, and from
 *   `valhalla-<version>` / `basemap-<version>` when it does not (Rods
 *   doc/specs/mapbox-exit/results/OPS-monthly-run-1005.md §6). So a plain road-data refresh must
 *   CARRY THE POINTERS FORWARD, or every phone is pointed at `valhalla-<today>` / `basemap-<today>`,
 *   releases that do not exist, and every installed pack and map turns stale.
 * RESPONSIBILITY: decide both fields for a new manifest: an explicit override (the aligned release
 *   that moves packs/maps), else the previous manifest's value, else what the app resolved from the
 *   previous manifest (`<prefix>-<previous version>`). A malformed value is refused, never written.
 * DEPENDENCIES: none.
 * CONSUMERS: generate-manifest.ts (osm-extract.yml release job, regenerate-manifest.yml);
 *   manifest-pointers.test.mjs.
 */

export const POINTERS = { valhallaPackTag: 'valhalla', basemapTag: 'basemap' };

/** Same shape the app accepts: `<prefix>-<version>`, URL-safe (no `/`, no `..`), at most 64 chars. */
export function isValidPointer(field, value) {
  const prefix = POINTERS[field];
  return typeof value === 'string' && value.length <= 64 && new RegExp(`^${prefix}-[A-Za-z0-9][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9_-]+)*$`).test(value);
}

/**
 * @param previous  the previous published manifest (parsed), or null when there is none
 * @param overrides { valhallaPackTag?, basemapTag? } — empty / undefined means "not set"
 * @returns the pointer fields to write ({} when there is no previous manifest and no override)
 */
export function resolvePointers(previous, overrides = {}) {
  const out = {};
  for (const [field, prefix] of Object.entries(POINTERS)) {
    const override = overrides[field] || undefined;
    let value;
    let source;
    if (override !== undefined) {
      value = override;
      source = 'override';
    } else if (!previous) {
      continue;
    } else if (previous[field] !== undefined) {
      value = previous[field];
      source = 'previous manifest';
    } else {
      // The previous manifest had no pointer: the app resolved `<prefix>-<its version>` from it.
      value = typeof previous.version === 'string' ? `${prefix}-${previous.version}` : previous.version;
      source = 'previous manifest version';
    }
    if (!isValidPointer(field, value)) {
      throw new Error(`${field} from ${source} is not ${prefix}-<version>: ${JSON.stringify(value)}`);
    }
    out[field] = value;
  }
  return out;
}
