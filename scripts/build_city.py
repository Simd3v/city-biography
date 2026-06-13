#!/usr/bin/env python3
"""
Build a building-age map dataset for any configured city.

Usage:
    python scripts/build_city.py abu-dhabi
    python scripts/build_city.py dubai
    python scripts/build_city.py --all

Data pipeline:
    1. Fetch building footprints from OpenStreetMap (Overpass API)
    2. Assign construction epoch from GHS-OBAT (EU Copernicus / JRC)
    3. Export GeoJSON + metadata to public/data/{city_id}/
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio
import requests
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
CONFIGS = ROOT / "configs"
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "data"

OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

OBAT_URL = (
    "https://cidportal.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    "GHS_OBAT_GLOBE_R2024A/GHS_OBAT_GPKG_GLOBE_R2024A/V1-0/"
    "GHS_OBAT_GPKG_ARE_E2020_R2024A_V1_0.zip"
)

EPOCH_LABELS = {
    0: "Unknown",
    1: "Before 1980",
    2: "1980–1989",
    3: "1990–1999",
    4: "2000–2009",
    5: "2010–2020",
}

EPOCH_COLORS = {
    0: "#4a4a4a",
    1: "#c0392b",
    2: "#e67e22",
    3: "#f1c40f",
    4: "#2ecc71",
    5: "#3498db",
}

EPOCH_ORDER = [1, 2, 3, 4, 5, 0]


def parse_year(raw: str | None) -> int | None:
    if not raw:
        return None
    match = re.search(r"(\d{4})", str(raw))
    if not match:
        return None
    year = int(match.group(1))
    return year if 1800 <= year <= 2030 else None


def year_to_epoch(year: int | None) -> int:
    if year is None:
        return 0
    if year < 1980:
        return 1
    if year < 1990:
        return 2
    if year < 2000:
        return 3
    if year < 2010:
        return 4
    return 5


def fetch_osm_zone(city_id: str, zone: str, bbox: tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    cache = DATA / "raw" / city_id / f"{zone}.geojson"
    if cache.exists():
        return gpd.read_file(cache)

    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["building"]({south},{west},{north},{east});
      relation["building"]["type"="multipolygon"]({south},{west},{north},{east});
    );
    out geom;
    """
    headers = {"Accept": "application/json"}
    last_err: Exception | None = None
    payload = None
    for url in OVERPASS_URLS:
        try:
            resp = requests.post(url, data={"data": query}, timeout=200, headers=headers)
            resp.raise_for_status()
            payload = resp.json()
            break
        except Exception as exc:
            last_err = exc
    if payload is None:
        raise last_err or RuntimeError("Overpass request failed")

    features = []
    for el in payload.get("elements", []):
        tags = el.get("tags", {})
        if "building" not in tags:
            continue
        geom = None
        if el["type"] == "way" and el.get("geometry"):
            coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
            if len(coords) >= 4:
                geom = {"type": "Polygon", "coordinates": [coords]}
        elif el["type"] == "relation" and el.get("members"):
            rings = []
            for member in el["members"]:
                if member.get("role") == "outer" and member.get("geometry"):
                    ring = [[p["lon"], p["lat"]] for p in member["geometry"]]
                    if len(ring) >= 4:
                        rings.append(ring)
            if rings:
                geom = (
                    {"type": "Polygon", "coordinates": rings}
                    if len(rings) == 1
                    else {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}
                )
        if geom:
            features.append({"type": "Feature", "geometry": geom, "properties": tags})

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    cache.parent.mkdir(parents=True, exist_ok=True)
    if len(gdf):
        gdf.to_file(cache, driver="GeoJSON")
    return gdf


def load_obat() -> gpd.GeoDataFrame:
    cache = DATA / "raw" / "ghs_obat_are.gpkg"
    if not cache.exists():
        print("Downloading GHS-OBAT UAE (~78 MB)...")
        zip_path = DATA / "raw" / "ghs_obat_are.zip"
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(OBAT_URL, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", 0))
            with open(zip_path, "wb") as fh, tqdm(total=total, unit="B", unit_scale=True) as bar:
                for chunk in resp.iter_content(1024 * 1024):
                    fh.write(chunk)
                    bar.update(len(chunk))
        with zipfile.ZipFile(zip_path) as zf:
            name = next(n for n in zf.namelist() if n.endswith(".gpkg"))
            cache.write_bytes(zf.read(name))

    layers = pyogrio.list_layers(cache)
    layer = layers[0][0] if len(layers) else "GHS_OBAT"
    return gpd.read_file(cache, layer=layer).to_crs(4326)


def load_config(city_id: str) -> dict:
    path = CONFIGS / f"{city_id.replace('-', '_')}.json"
    if not path.exists():
        path = CONFIGS / f"{city_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"No config for city '{city_id}' in configs/")
    return json.loads(path.read_text())


def build_city(city_id: str) -> None:
    cfg = load_config(city_id)
    out_dir = PUBLIC / cfg["id"]
    out_dir.mkdir(parents=True, exist_ok=True)

    frames = []
    for zone, bbox in cfg["zones"].items():
        print(f"[{cfg['name']}] OSM tile: {zone}...")
        try:
            gdf = fetch_osm_zone(cfg["id"], zone, tuple(bbox))
            print(f"  → {len(gdf):,} buildings")
            if len(gdf):
                frames.append(gdf)
        except Exception as exc:
            print(f"  ⚠ skipped {zone}: {exc}", file=sys.stderr)

    if not frames:
        raise SystemExit(f"No OSM buildings fetched for {cfg['name']}.")

    buildings = gpd.GeoDataFrame(
        pd.concat(frames, ignore_index=True), geometry="geometry", crs="EPSG:4326"
    )
    buildings = buildings[buildings.geometry.notna() & ~buildings.geometry.is_empty]
    buildings = buildings.drop_duplicates(subset=["geometry"], keep="first")
    buildings["geometry"] = buildings.geometry.buffer(0)
    print(f"Total unique footprints: {len(buildings):,}")

    print("Loading GHS-OBAT epoch reference...")
    obat = load_obat()
    west, south, east, north = cfg["clip_bbox"]
    obat = obat.cx[west:east, south:north]
    print(f"  → {len(obat):,} reference points in clip area")

    epoch_col = next((c for c in obat.columns if "epoch" in c.lower()), "epoch")
    obat_pts = obat.copy()
    obat_pts["epoch_ref"] = pd.to_numeric(obat_pts[epoch_col], errors="coerce").fillna(0).astype(int)

    buildings = buildings.to_crs(3857)
    obat_pts = obat_pts.to_crs(3857)
    buildings["_cx"] = buildings.geometry.centroid.x
    buildings["_cy"] = buildings.geometry.centroid.y
    obat_pts["_cx"] = obat_pts.geometry.x
    obat_pts["_cy"] = obat_pts.geometry.y

    print("Spatial join OSM ↔ GHS-OBAT (nearest neighbour, 80 m)...")
    joined = gpd.sjoin_nearest(
        buildings,
        obat_pts[["_cx", "_cy", "epoch_ref", "geometry"]],
        how="left",
        max_distance=80,
        distance_col="match_dist",
    )
    joined = joined.drop(columns=[c for c in joined.columns if c.startswith("index_")], errors="ignore")

    def resolve_epoch(row) -> int:
        for key in ("start_date", "construction_date", "building:year_built", "year_of_construction"):
            year = parse_year(row.get(key))
            if year:
                return year_to_epoch(year)
        ref = row.get("epoch_ref")
        if pd.notna(ref) and int(ref) > 0:
            return int(ref)
        return 0

    joined["epoch"] = joined.apply(resolve_epoch, axis=1)
    joined["era"] = joined["epoch"].map(EPOCH_LABELS)
    joined["color"] = joined["epoch"].map(EPOCH_COLORS)
    joined["era_order"] = joined["epoch"].map({e: i for i, e in enumerate(EPOCH_ORDER)})

    out = joined.drop(columns=["_cx", "_cy", "epoch_ref", "match_dist"], errors="ignore").to_crs(4326)
    keep = ["geometry", "epoch", "era", "color", "era_order", "building"]
    out = out[[c for c in keep if c in out.columns]].copy().reset_index(drop=True)

    out_3857 = out.to_crs(3857)
    out_3857["geometry"] = out_3857.geometry.simplify(1.0, preserve_topology=True)
    out = out_3857.to_crs(4326)

    geojson_path = out_dir / "buildings.geojson"
    out.to_file(geojson_path, driver="GeoJSON")

    meta = {
        "id": cfg["id"],
        "name": cfg["name"],
        "center": cfg["center"],
        "default_zoom": cfg.get("default_zoom", 11),
        "total_buildings": int(len(out)),
        "zones": list(cfg["zones"].keys()),
        "epoch_counts": out["era"].value_counts().to_dict(),
        "attribution": cfg.get("attribution", {}),
        "epoch_labels": EPOCH_LABELS,
        "epoch_colors": {str(k): v for k, v in EPOCH_COLORS.items()},
        "epoch_order": EPOCH_ORDER,
        "bbox": list(out.total_bounds),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    print(json.dumps(meta["epoch_counts"], indent=2))
    print(f"✓ {geojson_path} ({geojson_path.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build building-age map data for a city")
    parser.add_argument("city", nargs="?", help="City id (e.g. abu-dhabi, dubai)")
    parser.add_argument("--all", action="store_true", help="Build all cities in configs/")
    args = parser.parse_args()

    if args.all:
        for path in sorted(CONFIGS.glob("*.json")):
            cfg = json.loads(path.read_text())
            build_city(cfg["id"])
        return

    if not args.city:
        parser.print_help()
        raise SystemExit("Provide a city id or --all")

    build_city(args.city)


if __name__ == "__main__":
    main()
