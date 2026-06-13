#!/usr/bin/env python3
"""Build roads-lite.geojson — geometry only, stronger simplify, for web display."""

from __future__ import annotations

import sys
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"


def build_lite(city_id: str, simplify_m: float = 28.0) -> None:
    src = PUBLIC / city_id / "roads.geojson"
    if not src.exists():
        print(f"[{city_id}] skip — no roads.geojson")
        return

    gdf = gpd.read_file(src)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    if len(gdf):
        gdf = gdf.to_crs(3857)
        gdf["geometry"] = gdf.geometry.simplify(simplify_m, preserve_topology=True)
        gdf = gdf.to_crs(4326)

    lite = gpd.GeoDataFrame(geometry=gdf.geometry, crs="EPSG:4326")
    dest = PUBLIC / city_id / "roads-lite.geojson"
    lite.to_file(dest, driver="GeoJSON")
    print(f"[{city_id}] {len(lite):,} features → {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    for cid in sys.argv[1:] or ["abu-dhabi", "dubai"]:
        build_lite(cid)
