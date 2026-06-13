#!/usr/bin/env python3
"""Fetch roads + water GeoJSON for cartography layers (one-time per city)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import geopandas as gpd
import requests

ROOT = Path(__file__).resolve().parents[1]
CONFIGS = ROOT / "configs"
PUBLIC = ROOT / "public" / "data"

OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]


def overpass(query: str) -> dict:
    headers = {"Accept": "application/json"}
    last = None
    for url in OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": query}, timeout=300, headers=headers)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            last = exc
    raise last or RuntimeError("Overpass failed")


def elements_to_gdf(payload: dict) -> gpd.GeoDataFrame:
    features = []
    for el in payload.get("elements", []):
        geom = None
        if el["type"] == "way" and el.get("geometry"):
            coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
            if len(coords) >= 2:
                geom = {"type": "LineString", "coordinates": coords}
                if coords[0] == coords[-1] and len(coords) >= 4:
                    geom = {"type": "Polygon", "coordinates": [coords]}
        elif el["type"] == "relation" and el.get("members"):
            rings = []
            for m in el["members"]:
                if m.get("role") == "outer" and m.get("geometry"):
                    ring = [[p["lon"], p["lat"]] for p in m["geometry"]]
                    if len(ring) >= 4:
                        rings.append(ring)
            if rings:
                geom = (
                    {"type": "Polygon", "coordinates": rings}
                    if len(rings) == 1
                    else {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}
                )
        if geom:
            features.append({"type": "Feature", "geometry": geom, "properties": el.get("tags", {})})
    if not features:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    return gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")


def fetch_city(city_id: str) -> None:
    cfg_path = CONFIGS / f"{city_id.replace('-', '_')}.json"
    cfg = json.loads(cfg_path.read_text())
    west, south, east, north = cfg["clip_bbox"]
    out = PUBLIC / city_id
    out.mkdir(parents=True, exist_ok=True)

    road_q = f"""
    [out:json][timeout:300];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]
          ({south},{west},{north},{east});
    );
    out geom;
    """
    print(f"[{city_id}] roads…")
    roads = elements_to_gdf(overpass(road_q))
    roads = roads[roads.geometry.notna() & ~roads.geometry.is_empty]
    if len(roads):
        roads = roads.to_crs(3857)
        roads["geometry"] = roads.geometry.simplify(6, preserve_topology=True)
        roads = roads.to_crs(4326)
    roads.to_file(out / "roads.geojson", driver="GeoJSON")
    print(f"  → {len(roads):,} road features")

    water_q = f"""
    [out:json][timeout:300];
    (
      way["natural"="water"]({south},{west},{north},{east});
      relation["natural"="water"]({south},{west},{north},{east});
      way["waterway"="riverbank"]({south},{west},{north},{east});
      relation["waterway"="riverbank"]({south},{west},{north},{east});
      way["natural"="bay"]({south},{west},{north},{east});
    );
    out geom;
    """
    print(f"[{city_id}] water…")
    water = elements_to_gdf(overpass(water_q))
    water = water[water.geometry.notna() & ~water.geometry.is_empty]
    if len(water):
        water = water.to_crs(3857)
        water["geometry"] = water.geometry.simplify(12, preserve_topology=True)
        water = water.to_crs(4326)
    water.to_file(out / "water.geojson", driver="GeoJSON")
    print(f"  → {len(water):,} water features")


if __name__ == "__main__":
    for cid in sys.argv[1:] or ["abu-dhabi", "dubai"]:
        fetch_city(cid)
