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

## Manual Trigger

To manually run the extraction:
1. Go to Actions → Monthly OSM Data Extraction
2. Click "Run workflow"

## License

The extracted data is derived from OpenStreetMap and is available under the [ODbL](https://www.openstreetmap.org/copyright).
