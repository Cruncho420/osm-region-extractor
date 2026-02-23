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

## License

The extracted data is derived from OpenStreetMap and is available under the [ODbL](https://www.openstreetmap.org/copyright).
