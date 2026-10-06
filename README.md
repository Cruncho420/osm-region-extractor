# OSM Region Extractor

Extract regional OpenStreetMap data from Geofabrik PBF files into compact SQLite databases.

## What It Does

1. **Monthly Extraction**: GitHub Actions extracts data from Geofabrik PBF files on the 1st of each month
2. **GitHub Releases**: Extracted data is published as GitHub Release assets
3. **On-Demand Download**: Clients download region data on-demand via release URLs

## Failure modes

### Monthly source download rejected (BUG-819, 2026-09-02)

The September 2026 run launched 20 simultaneous Geofabrik downloads and 184 of 236 jobs saved tiny non-PBF responses; bare `curl -L` treated those responses as successful, so the failure appeared later as an opaque `osmium` parse error. Downloads now reject HTTP errors, retry transient failures within a bounded budget, validate the full PBF stream with `osmium fileinfo --extended`, and atomically replace the destination only after validation. The workflow limits Geofabrik traffic to four concurrent jobs, retains the existing complete release whenever any gate fails or the run is cancelled, and sends the owner one private Discord DM from an independent terminal monitor. Run the separate **Test OSM Discord Notification** workflow to prove DM delivery without starting extraction.

## Data Format

Each region produces a SQLite database (`{region-id}.sqlite.gz`) containing:
- Traffic calming features (speed bumps, dips, bridges, tunnels, speed cameras)
- Roundabouts (full and mini)
- Road surfaces (asphalt, gravel, cobblestone, dirt, etc.)
- Road ways (dense road geometry)

## Offline search file (`{region-id}-search.sqlite.gz`, Rods FEAT-090)

`scripts/search_index.py` builds one per region (and per split-country piece) from the same PBF:
places, passes, peaks, sights, fuel/charging, named shops/cafés/parking and streets in an FTS5
index, plus OpenStreetMap house numbers when the file with them stays at or under 5 % of the
region's download (road data + routing + map; `HOUSENUMBER_MAX_SHARE`). The schema contract,
including the most-important-first row order the app relies on, is in the script's docstring.
It is **dry-run until the 1 Nov 2026 aligned release**: the monthly job uploads it as a
`search-<region>` workflow artifact only. `gh variable set PUBLISH_SEARCH_INDEX --body true`
(or the `publish_search` dispatch input) puts it on the release and adds `searchSize` /
`searchChecksum` to each region in `manifest.json` (+234 assets, ~700 of the 1000 cap).

Local build of any region (needs `osmium` and python3 with FTS5):

```bash
node scripts/download-pbf.mjs https://download.geofabrik.de/europe/estonia-latest.osm.pbf /tmp/ee.osm.pbf
gh release download -R Cruncho420/osm-region-extractor --pattern manifest.json -O /tmp/osm.json   # + the
#   valhalla-manifest.json / basemap manifest.json of the releases it points at, for today's download
python3 scripts/search_index.py --region europe-estonia --pbf /tmp/ee.osm.pbf --out /tmp/search \
  --manifest /tmp/osm.json --manifest /tmp/valhalla.json --manifest /tmp/basemap.json --keep-sqlite
```

## Offline map files (basemap) and split countries

`basemap-tiles.yml` cuts one Protomaps PMTiles map file per unit onto a `basemap-<YYYY-MM-DD>`
prerelease, with its own `manifest.json` written only when every unit is there. A unit is a region
from `scripts/regions.json`, except that a country listed in `scripts/region-slices.json` (the 12
countries whose download is over 2 GB: GB, Canada, Russia, Japan, Italy, Spain, Poland, Indonesia,
Norway, Australia, Mexico, Brazil-Sudeste) ships as its pieces instead — 36
`<piece-id>-basemap.pmtiles` files clipped to `scripts/polys/<piece-id>.poly` (or the piece's
single Geofabrik outline), at zoom 14 unless the piece says otherwise (Nunavut: 12). A piece
never drops a zoom to fit under 2 GiB; it fails the run instead. `scripts/basemap-units.mjs`
is the unit list; `scripts/basemap-build-unit.sh` builds one. Regenerate a piece outline with
`NE_ADMIN1=<ne_10m_admin_1_states_provinces.geojson> python3 scripts/build-slice-polys.py <country>`.
R2 upload runs only when `R2_ACCOUNT_ID`, `R2_MAPS_ACCESS_KEY_ID` and `R2_MAPS_SECRET_ACCESS_KEY`
(a bucket-scoped token, never an account-wide one) are all set; otherwise it is skipped.

## Manual Trigger

To manually run the extraction:
1. Go to Actions → Monthly OSM Data Extraction
2. Click "Run workflow"

## License

The extracted data is derived from OpenStreetMap and is available under the [ODbL](https://www.openstreetmap.org/copyright).
