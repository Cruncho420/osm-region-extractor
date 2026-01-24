# Rods OSM Data

Pre-extracted OpenStreetMap data for the Rods app. Contains traffic calming features (speed bumps, bridges, tunnels, speed cameras) and roundabouts.

## How It Works

1. **Monthly Extraction**: GitHub Actions extracts data from Geofabrik PBF files on the 1st of each month
2. **GitHub Releases**: Extracted data is published as GitHub Release assets
3. **App Download**: The Rods app downloads region data on-demand based on user location

## Data Format

Each region file (`{region-id}.json.gz`) contains:
```json
{
  "version": "2025-01-24",
  "region": "europe-gb",
  "trafficCalming": [
    { "lat": 51.5074, "lon": -0.1278, "type": "speed_bump" }
  ],
  "roundabouts": [
    { "lat": 51.5074, "lon": -0.1278, "type": "roundabout", "radius": 25 }
  ]
}
```

## Manual Trigger

To manually run the extraction:
1. Go to Actions → Monthly OSM Data Extraction
2. Click "Run workflow"

## License

The extracted data is derived from OpenStreetMap and is available under the [ODbL](https://www.openstreetmap.org/copyright).
