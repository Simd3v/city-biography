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
import csv
import gzip
import json
import re
import sys
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio
import requests
from shapely import set_precision
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

MS_MANIFEST_URL = (
    "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
)

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


def empty_buildings_gdf() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs="EPSG:4326")


def fetch_osm_zone(city_id: str, zone: str, bbox: tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    cache = DATA / "raw" / city_id / f"{zone}.geojson"
    if cache.exists():
        try:
            gdf = gpd.read_file(cache)
            return gdf if len(gdf) else empty_buildings_gdf()
        except Exception:
            cache.unlink(missing_ok=True)

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

    cache.parent.mkdir(parents=True, exist_ok=True)
    if not features:
        gdf = empty_buildings_gdf()
        gdf.to_file(cache, driver="GeoJSON")
        return gdf

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    gdf.to_file(cache, driver="GeoJSON")
    return gdf


def load_microsoft_uae_footprints() -> gpd.GeoDataFrame:
    """Microsoft Global ML Building Footprints — fills low-density villa areas OSM misses."""
    cache = DATA / "raw" / "microsoft_uae.geojson"
    if cache.exists():
        return gpd.read_file(cache)

    print("Downloading Microsoft building footprints (United Arab Emirates)...")
    resp = requests.get(MS_MANIFEST_URL, timeout=120)
    resp.raise_for_status()
    tiles = [row for row in csv.DictReader(resp.text.splitlines()) if row.get("Location") == "UnitedArabEmirates"]
    if not tiles:
        raise RuntimeError("No Microsoft footprint tiles found for United Arab Emirates")

    features: list[dict] = []
    for row in tqdm(tiles, desc="MS UAE tiles"):
        tile_resp = requests.get(row["Url"], timeout=120)
        tile_resp.raise_for_status()
        raw = gzip.decompress(tile_resp.content).decode("utf-8")
        for line in raw.splitlines():
            line = line.strip()
            if line:
                features.append(json.loads(line))

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    cache.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(cache, driver="GeoJSON")
    print(f"  → {len(gdf):,} Microsoft footprints cached")
    return gdf


def merge_osm_microsoft(
    osm: gpd.GeoDataFrame, ms: gpd.GeoDataFrame, dedupe_m: float = 10.0
) -> gpd.GeoDataFrame:
    """Add Microsoft footprints where OSM has no nearby building (villa suburbs)."""
    if ms is None or ms.empty:
        return osm

    osm3857 = osm.to_crs(3857)
    ms3857 = ms.to_crs(3857)
    osm_pts = gpd.GeoDataFrame(geometry=osm3857.geometry.centroid, crs=3857)
    ms_pts = gpd.GeoDataFrame(geometry=ms3857.geometry.centroid, crs=3857)

    matched = gpd.sjoin_nearest(
        ms_pts,
        osm_pts,
        how="left",
        max_distance=dedupe_m,
        distance_col="dist",
    )
    keep = matched[matched["index_right"].isna()].index
    ms_new = ms3857.loc[keep].copy()
    ms_new["building"] = "yes"
    ms_new["source"] = "microsoft"
    ms_new["geometry"] = ms_new.geometry.simplify(8.0, preserve_topology=True)

    print(f"  → adding {len(ms_new):,} Microsoft footprints (OSM dedupe {dedupe_m:.0f} m)")
    if ms_new.empty:
        return osm

    combined = pd.concat([osm3857, ms_new], ignore_index=True)
    return gpd.GeoDataFrame(combined, geometry="geometry", crs=3857).to_crs(4326)


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
    print(f"Total unique OSM footprints: {len(buildings):,}")

    if cfg.get("microsoft_footprints"):
        west, south, east, north = cfg["clip_bbox"]
        ms_all = load_microsoft_uae_footprints()
        ms_clip = ms_all.cx[west:east, south:north]
        print(f"Microsoft footprints in clip area: {len(ms_clip):,}")
        buildings = merge_osm_microsoft(
            buildings,
            ms_clip,
            dedupe_m=cfg.get("microsoft_dedupe_m", 10),
        )
        buildings = buildings.drop_duplicates(subset=["geometry"], keep="first")
        print(f"Combined OSM + Microsoft: {len(buildings):,}")

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

    ghs_dist = cfg.get("ghs_max_distance_m", 80)
    print(f"Spatial join OSM ↔ GHS-OBAT (nearest neighbour, {ghs_dist} m)...")
    joined = gpd.sjoin_nearest(
        buildings,
        obat_pts[["_cx", "_cy", "epoch_ref", "geometry"]],
        how="left",
        max_distance=ghs_dist,
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
    simplify_m = cfg.get("simplify_m", 1.0)
    out_3857["geometry"] = out_3857.geometry.simplify(simplify_m, preserve_topology=True)
    out = out_3857.to_crs(4326)
    prec = cfg.get("coordinate_precision")
    if prec:
        out["geometry"] = out.geometry.apply(lambda g: set_precision(g, prec))

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
