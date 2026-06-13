#!/usr/bin/env python3
"""Generate low-res JPEG previews for the mobile gate (no MapLibre needed)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PatchCollection
from matplotlib.patches import Polygon

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "previews"

ERA_COLORS = {
    0: "#4a4a4a",
    1: "#c0392b",
    2: "#e67e22",
    3: "#f1c40f",
    4: "#2ecc71",
    5: "#3498db",
}
ERA_COLORS_LIGHT = {
    0: "#8A8278",
    1: "#C44E3B",
    2: "#D87A31",
    3: "#B58A28",
    4: "#4F8A5B",
    5: "#2E6E8E",
}


def polygons_from_feature(feat: dict) -> list[list[tuple[float, float]]]:
    geom = feat.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    if gtype == "Polygon":
        return [[(x, y) for x, y in ring] for ring in coords[:1]]
    if gtype == "MultiPolygon":
        rings = []
        for poly in coords:
            if poly:
                rings.append([(x, y) for x, y in poly[0]])
        return rings
    return []


def render_city(city_id: str, mode: str = "black", sample_every: int = 4) -> None:
    src = ROOT / "public" / "data" / city_id / "buildings.geojson"
    if not src.exists():
        print(f"skip {city_id}: no buildings.geojson")
        return

    data = json.loads(src.read_text())
    palette = ERA_COLORS_LIGHT if mode == "beige" else ERA_COLORS
    bg = "#D8D0C2" if mode == "beige" else "#000000"

    by_epoch: dict[int, list[Polygon]] = {}
    for i, feat in enumerate(data.get("features", [])):
        if i % sample_every:
            continue
        epoch = int(feat.get("properties", {}).get("epoch", 0))
        for ring in polygons_from_feature(feat):
            if len(ring) >= 3:
                by_epoch.setdefault(epoch, []).append(Polygon(ring, closed=True))

    fig, ax = plt.subplots(figsize=(9, 11), dpi=96)
    ax.set_facecolor(bg)
    fig.patch.set_facecolor(bg)
    for epoch, patches in by_epoch.items():
        ax.add_collection(
            PatchCollection(
                patches,
                facecolor=palette.get(epoch, palette[0]),
                edgecolor="none",
                antialiased=False,
            )
        )

    ax.autoscale()
    ax.set_aspect("equal", adjustable="box")
    ax.axis("off")

    PUBLIC.mkdir(parents=True, exist_ok=True)
    out = PUBLIC / f"{city_id}-{mode}.jpg"
    fig.savefig(out, format="jpeg", dpi=120, bbox_inches="tight", pad_inches=0.04, facecolor=bg)
    plt.close(fig)
    print(f"  → {out.name} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    cities = sys.argv[1:] or ["abu-dhabi", "dubai"]
    for city in cities:
        for mode in ("black", "beige"):
            print(f"[{city}] {mode}…")
            render_city(city, mode)
