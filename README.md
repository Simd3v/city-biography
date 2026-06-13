# Building Age Map

Interactive maps of **building construction periods**, inspired by the Paris building-age visualizations. Each footprint is colored by when it was likely built, using **public data only**.

**Live demo:** after you deploy to GitHub Pages → `https://<username>.github.io/<repo>/`

Included cities: **Abu Dhabi** (~100k buildings) · **Dubai** (~170k buildings)

![Map preview](https://img.shields.io/badge/stack-MapLibre%20GL-blue)

## How it works

| Layer | Source |
|-------|--------|
| Building footprints | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API |
| Construction epoch | [GHS-OBAT R2024A](https://data.jrc.ec.europa.eu/dataset/ghs-built-up-surface-grid-derived-from-landsat-multitemporal-1975-2014-r2018a) (JRC / EU Copernicus) — satellite-derived 10-year buckets |
| OSM date override | `start_date`, `construction_date`, etc. when present (sparse in the UAE) |

**Pipeline:** fetch OSM polygons → nearest GHS-OBAT point within 80 m → assign epoch → export GeoJSON.

This is **fully replicable** for any city worldwide: define a config with bounding-box tiles, run the build script, add the city to `public/cities.json`. No proprietary cadastre required.

> **Caveat:** GHS-OBAT epochs are **satellite estimates**, not official construction dates. There is no open equivalent to France’s BDNB for the UAE.

## Quick start (local)

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Build one city (downloads OSM + GHS-OBAT on first run)
python scripts/build_city.py abu-dhabi
python scripts/build_city.py dubai
# or both:
python scripts/build_city.py --all

# Serve the frontend
cd public && python3 -m http.server 8080
# → http://localhost:8080
```

Pre-built GeoJSON is committed under `public/data/` so you can skip the build step and view the map immediately.

## Add your own city

1. Copy `configs/abu_dhabi.json` → `configs/my_city.json`
2. Set `id`, `name`, `center`, `clip_bbox`, and `zones` (each zone is `[south, west, north, east]`)
3. Run `python scripts/build_city.py my-city-id`
4. Add an entry to `public/cities.json`
5. Commit the new files under `public/data/my-city-id/`

Tip: split large areas into smaller Overpass tiles to avoid API timeouts.

## Project layout

```
configs/           City definitions (zones, bbox, attribution)
scripts/
  build_city.py    Unified data pipeline
public/
  index.html       Single-page app
  app.js           Map logic + city switcher + PNG export
  style.css
  cities.json      City manifest for the UI
  data/
    abu-dhabi/     buildings.geojson + meta.json
    dubai/
data/raw/          Cached OSM tiles (gitignored, created by build)
```

## Deploy with GitHub Pages

This repo includes [`.github/workflows/pages.yml`](.github/workflows/pages.yml). On push to `main`:

1. GitHub Actions uploads the `public/` folder
2. GitHub Pages serves it as a static site

**One-time setup in your repo:**

1. Push this code to GitHub
2. **Settings → Pages → Build and deployment → Source:** *GitHub Actions*
3. After the workflow runs, your site is live at `https://<username>.github.io/<repo>/`

No separate hosting — the site is just files in git, deployed automatically.

## Epoch colors

| Period | Color |
|--------|-------|
| Before 1980 | Red |
| 1980–1989 | Orange |
| 1990–1999 | Yellow |
| 2000–2009 | Green |
| 2010–2020 | Blue |
| Unknown | Gray |

## License

MIT — see [LICENSE](LICENSE).

Data attributions: © OpenStreetMap contributors · GHS-OBAT © European Commission, JRC.
