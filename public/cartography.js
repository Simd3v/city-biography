/* ==========================================================================
   CARTOGRAPHY-V2 — remove this file + cartography.css + index.html hooks to revert
   ========================================================================== */

(function () {
  const ENABLED = true;
  if (!ENABLED) return;

  const CARTO_SOURCE_OPTS = { tolerance: 4, buffer: 32, maxzoom: 14 };
  const ROAD_FILES = ["roads-lite.geojson", "roads.geojson"];

  const CARTO_THEME = {
    black: {
      roads: "#8a8a8a",
      water: "#060608",
      graticule: "rgba(255, 255, 255, 0.035)",
    },
    beige: {
      roads: "#5a4e42",
      water: "#C4BCAC",
      graticule: "rgba(40, 36, 32, 0.045)",
    },
    white: {
      roads: "#52A8A6",
      water: "#F0C4B8",
      graticule: "rgba(82, 168, 166, 0.1)",
    },
  };

  const OUTLINE_DARK = {
    1: "#8f2f20",
    2: "#ad651f",
    3: "#8f7018",
    4: "#276033",
    5: "#1a4558",
    0: "#333333",
  };

  const OUTLINE_LIGHT = {
    1: "#9A3829",
    2: "#B86522",
    3: "#907018",
    4: "#3A6248",
    5: "#245A72",
    0: "#6A645C",
  };

  const OUTLINE_WHITE = {
    1: "#8A3348",
    2: "#A84E62",
    3: "#BC6A7C",
    4: "#CC8894",
    5: "#9878A8",
    0: "#9A9692",
  };

  const OUTLINES_BY_MODE = {
    black: OUTLINE_DARK,
    beige: OUTLINE_LIGHT,
    white: OUTLINE_WHITE,
  };

  let mapRef = null;
  let cityConfig = null;
  let labelEls = [];
  let labelSyncQueued = false;
  let activeCityId = null;
  const configCache = {};

  function outlineExpression(mode) {
    const o = OUTLINES_BY_MODE[mode] || OUTLINES_BY_MODE.black;
    return ["match", ["get", "epoch"], 1, o[1], 2, o[2], 3, o[3], 4, o[4], 5, o[5], o[0]];
  }

  function cartoTheme(mode) {
    return CARTO_THEME[mode] || CARTO_THEME.black;
  }

  function stripGeoJSON(geo) {
    if (!geo?.features) return geo;
    return {
      type: "FeatureCollection",
      features: geo.features.map((f) => ({
        type: "Feature",
        properties: {},
        geometry: f.geometry,
      })),
    };
  }

  function graticuleGeoJSON(bbox) {
    if (!bbox || bbox.length !== 4) return { type: "FeatureCollection", features: [] };
    const [w, s, e, n] = bbox;
    const step = 0.1;
    const features = [];
    for (let lng = Math.ceil(w / step) * step; lng <= e; lng += step) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[lng, s], [lng, n]] },
        properties: {},
      });
    }
    for (let lat = Math.ceil(s / step) * step; lat <= n; lat += step) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[w, lat], [e, lat]] },
        properties: {},
      });
    }
    return { type: "FeatureCollection", features };
  }

  async function fetchFirst(base, files) {
    for (const file of files) {
      try {
        const r = await fetch(`${base}/${file}`);
        if (!r.ok) continue;
        return stripGeoJSON(await r.json());
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async function loadLayerData(cityId) {
    const base = `data/${cityId}`;
    const load = async (file) => {
      try {
        const r = await fetch(`${base}/${file}`);
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    };

    if (!configCache[cityId]) {
      configCache[cityId] = (await load("cartography.json")) || { labels: [] };
    }

    const [roads, water] = await Promise.all([
      fetchFirst(base, ROAD_FILES),
      load("water.geojson").then(stripGeoJSON),
    ]);

    return { roads, water, config: configCache[cityId] };
  }

  function evictCartoCache(keepCityId) {
    for (const id of Object.keys(configCache)) {
      if (id !== keepCityId) delete configCache[id];
    }
  }

  function ensureLayer(map, id, spec, beforeId) {
    if (map.getLayer(id)) return;
    map.addLayer(spec, beforeId);
  }

  function applyLayerColors(map, mode) {
    const t = cartoTheme(mode);
    if (map.getLayer("carto-water")) {
      map.setPaintProperty("carto-water", "fill-color", t.water);
    }
    if (map.getLayer("carto-roads")) {
      map.setPaintProperty("carto-roads", "line-color", t.roads);
      map.setPaintProperty("carto-roads", "line-width", roadLayerPaint(mode)["line-width"]);
      map.setPaintProperty("carto-roads", "line-opacity", 0.9);
    }
    if (map.getLayer("carto-graticule")) {
      map.setPaintProperty("carto-graticule", "line-color", t.graticule);
    }
  }

  function buildLabels(labels) {
    const container = document.getElementById("map-labels");
    if (!container) return;
    container.innerHTML = "";
    labelEls = labels.map((lb) => {
      const el = document.createElement("div");
      el.className = "map-label" + (lb.water ? " map-label-water" : "");
      el.textContent = lb.text;
      container.appendChild(el);
      return { el, lng: lb.lng, lat: lb.lat };
    });
  }

  function syncLabelsNow() {
    labelSyncQueued = false;
    if (!mapRef || !labelEls.length) return;
    const w = mapRef.getCanvas().clientWidth;
    const h = mapRef.getCanvas().clientHeight;
    labelEls.forEach(({ el, lng, lat }) => {
      const p = mapRef.project([lng, lat]);
      if (p.x < -80 || p.y < -20 || p.x > w + 80 || p.y > h + 20) {
        el.style.visibility = "hidden";
        return;
      }
      el.style.visibility = "visible";
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.style.transform = "translate(-50%, -50%)";
    });
  }

  function syncLabels() {
    if (labelSyncQueued) return;
    labelSyncQueued = true;
    requestAnimationFrame(syncLabelsNow);
  }

  function setGeoSource(map, srcId, geo) {
    if (!geo) return;
    if (map.getSource(srcId)) {
      map.getSource(srcId).setData(geo);
    } else {
      map.addSource(srcId, { type: "geojson", data: geo, ...CARTO_SOURCE_OPTS });
    }
  }

  function waitForCartoReady(map) {
    return new Promise((resolve) => {
      let attempts = 0;
      const done = () => {
        map.once("idle", () => resolve());
        map.triggerRepaint();
      };
      const check = () => {
        const roadsOk = !map.getSource("carto-roads") || map.isSourceLoaded("carto-roads");
        const waterOk = !map.getSource("carto-water") || map.isSourceLoaded("carto-water");
        if (roadsOk && waterOk) return done();
        attempts += 1;
        if (attempts >= 120) return done();
        map.once("sourcedata", check);
      };
      check();
    });
  }

  function roadLayerPaint(mode) {
    const t = cartoTheme(mode);
    return {
      "line-color": t.roads,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.35, 12, 0.45, 15, 0.6, 18, 0.85],
      "line-opacity": 0.9,
    };
  }

  function ensureCartoLayers(map, mode) {
    const t = cartoTheme(mode);
    const beforeBuildings = map.getLayer("buildings-shadow")
      ? "buildings-shadow"
      : map.getLayer("buildings-fill")
        ? "buildings-fill"
        : undefined;

    if (map.getSource("carto-graticule")) {
      ensureLayer(
        map,
        "carto-graticule",
        {
          id: "carto-graticule",
          type: "line",
          source: "carto-graticule",
          paint: { "line-color": t.graticule, "line-width": 0.4, "line-opacity": 0.7 },
        },
        beforeBuildings
      );
    }

    if (map.getSource("carto-water")) {
      ensureLayer(
        map,
        "carto-water",
        {
          id: "carto-water",
          type: "fill",
          source: "carto-water",
          paint: { "fill-color": t.water, "fill-opacity": 1 },
        },
        beforeBuildings
      );
    }

    if (map.getSource("carto-roads")) {
      ensureLayer(
        map,
        "carto-roads",
        {
          id: "carto-roads",
          type: "line",
          source: "carto-roads",
          paint: roadLayerPaint(mode),
        },
        beforeBuildings
      );
    }

    applyLayerColors(map, mode);
  }

  async function onCityChange(map, cityId, meta, backgroundMode = "black") {
    mapRef = map;
    activeCityId = cityId;
    evictCartoCache(cityId);

    const data = await loadLayerData(cityId);
    cityConfig = data.config || { labels: [] };

    setGeoSource(map, "carto-graticule", graticuleGeoJSON(meta.bbox));
    setGeoSource(map, "carto-water", data.water);
    setGeoSource(map, "carto-roads", data.roads);

    ensureCartoLayers(map, backgroundMode);
    await waitForCartoReady(map);

    buildLabels(cityConfig.labels || []);
    syncLabelsNow();
  }

  function applyBuildingStyle(map, backgroundMode) {
    if (!map.getLayer("buildings-fill")) return;
    map.setPaintProperty("buildings-fill", "fill-outline-color", outlineExpression(backgroundMode));
    if (map.getLayer("buildings-shadow")) {
      map.setPaintProperty("buildings-shadow", "fill-opacity", 0);
    }
  }

  function onBackgroundMode(map, mode) {
    ensureCartoLayers(map, mode);
    applyBuildingStyle(map, mode);
    document.body.classList.toggle("carto-texture", mode === "beige");
    syncLabelsNow();
    map.triggerRepaint();
  }

  function init(map) {
    mapRef = map;
    document.body.classList.add("carto-v2");
    map.on("moveend", syncLabels);
    map.on("zoomend", syncLabels);
    map.on("resize", syncLabels);
  }

  function labelInk(backgroundMode) {
    const isLight = backgroundMode === "beige" || backgroundMode === "white";
    return {
      isLight,
      faint: isLight ? "rgba(28, 24, 20, 0.88)" : "rgba(255, 255, 255, 1)",
      water: isLight ? "rgba(42, 36, 32, 0.68)" : "rgba(255, 255, 255, 0.72)",
      shadow: isLight ? "rgba(255, 255, 255, 0.85)" : "rgba(0, 0, 0, 0.5)",
    };
  }

  function drawLabelsOnMapCanvas(ctx, map, backgroundMode) {
    if (!cityConfig?.labels?.length) return;

    const src = map.getCanvas();
    const dpr = src.width / src.clientWidth || 1;
    const fontScale = src.clientWidth / 1200;
    const ink = labelInk(backgroundMode);

    cityConfig.labels.forEach((lb) => {
      const p = map.project([lb.lng, lb.lat]);
      const x = p.x * dpr;
      const y = p.y * dpr;
      if (x < 0 || y < 0 || x > src.width || y > src.height) return;

      ctx.save();
      ctx.translate(x, y);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = ink.shadow;
      ctx.shadowBlur = 10 * fontScale * dpr;

      if (lb.water) {
        ctx.font = `italic ${12 * fontScale * dpr}px "Helvetica Neue", Arial, sans-serif`;
        ctx.fillStyle = ink.water;
        ctx.fillText(lb.text.toUpperCase(), 0, 0);
      } else {
        ctx.font = `500 ${11 * fontScale * dpr}px "Helvetica Neue", Arial, sans-serif`;
        ctx.fillStyle = ink.faint;
        ctx.fillText(lb.text.toUpperCase(), 0, 0);
      }
      ctx.restore();
    });
  }

  function composeMapWithLabels(map, backgroundMode) {
    const src = map.getCanvas();
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(src, 0, 0);
    drawLabelsOnMapCanvas(ctx, map, backgroundMode);
    return out;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawExportCartouche(canvas, meta, theme, eraColors, eraOrder, eraLabels, backgroundMode) {
    const ctx = canvas.getContext("2d");
    if (!ctx || !meta) return canvas;

    const scale = canvas.width / 1400;
    const margin = 22 * scale;
    const inner = 18 * scale;
    const isLight = backgroundMode === "beige" || backgroundMode === "white";
    const ink = isLight ? "rgba(28, 24, 20, 0.92)" : "rgba(255, 255, 255, 0.94)";
    const inkSoft = isLight ? "rgba(48, 42, 36, 0.62)" : "rgba(255, 255, 255, 0.62)";
    const inkFaint = isLight ? "rgba(32, 28, 24, 0.52)" : "rgba(255, 255, 255, 0.52)";
    const frameFill = backgroundMode === "white"
      ? "rgba(255, 255, 255, 0.78)"
      : isLight
        ? "rgba(216, 208, 194, 0.62)"
        : "rgba(0, 0, 0, 0.48)";
    const frameStroke = isLight ? "rgba(32, 28, 24, 0.28)" : "rgba(255, 255, 255, 0.3)";
    const frameInner = isLight ? "rgba(32, 28, 24, 0.12)" : "rgba(255, 255, 255, 0.12)";

    const titleSize = 20 * scale;
    const subSize = 11 * scale;
    const legendSize = 10 * scale;
    const lineH = 16 * scale;
    const sw = 14 * scale;
    const sh = 9 * scale;
    const font = '"Helvetica Neue", Arial, sans-serif';
    const subtitle = "Sand into city, by decade";

    ctx.font = `600 ${titleSize}px ${font}`;
    const titleW = ctx.measureText(meta.name).width;
    ctx.font = `400 ${subSize}px ${font}`;
    const subW = ctx.measureText(subtitle).width;
    ctx.font = `400 ${legendSize}px ${font}`;
    let legendW = 0;
    eraOrder.forEach((epoch) => {
      legendW = Math.max(legendW, sw + 8 * scale + ctx.measureText(eraLabels[epoch]).width);
    });

    const boxW = Math.ceil(Math.max(titleW, subW, legendW) + inner * 2);
    const boxH = Math.ceil(
      inner + titleSize + 7 * scale + subSize + 14 * scale + eraOrder.length * lineH + inner
    );
    const bx = margin;
    const by = margin;

    ctx.fillStyle = frameFill;
    ctx.strokeStyle = frameStroke;
    ctx.lineWidth = Math.max(1, scale);
    roundRect(ctx, bx, by, boxW, boxH, 2 * scale);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = frameInner;
    ctx.lineWidth = Math.max(1, 0.75 * scale);
    roundRect(ctx, bx + 5 * scale, by + 5 * scale, boxW - 10 * scale, boxH - 10 * scale, 1 * scale);
    ctx.stroke();

    let y = by + inner;
    const x = bx + inner;
    ctx.textBaseline = "top";
    ctx.fillStyle = ink;
    ctx.font = `600 ${titleSize}px ${font}`;
    ctx.fillText(meta.name, x, y);
    y += titleSize + 7 * scale;

    ctx.font = `400 ${subSize}px ${font}`;
    ctx.fillStyle = inkSoft;
    ctx.fillText(subtitle, x, y);
    y += subSize + 14 * scale;

    ctx.font = `400 ${legendSize}px ${font}`;
    eraOrder.forEach((epoch) => {
      ctx.fillStyle = eraColors[epoch];
      ctx.fillRect(x, y + 2 * scale, sw, sh);
      ctx.fillStyle = inkSoft;
      ctx.fillText(eraLabels[epoch], x + sw + 8 * scale, y);
      y += lineH;
    });

    drawScaleBar(ctx, canvas.width - margin - 120 * scale, canvas.height - margin - 16 * scale, scale, inkFaint);
    drawCompass(ctx, canvas.width - margin - 28 * scale, margin + 8 * scale, 22 * scale, 8 * scale, inkSoft);

    return canvas;
  }

  function drawScaleBar(ctx, x, y, scale, color) {
    const barW = 80 * scale;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barW, y);
    ctx.moveTo(x, y - 4 * scale);
    ctx.lineTo(x, y + 4 * scale);
    ctx.moveTo(x + barW, y - 4 * scale);
    ctx.lineTo(x + barW, y + 4 * scale);
    ctx.stroke();
    ctx.font = `400 ${9 * scale}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText("5 km", x + barW * 0.32, y - 10 * scale);
  }

  function drawCompass(ctx, cx, cy, r, fontSize, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx - r * 0.28, cy + r * 0.35);
    ctx.lineTo(cx + r * 0.28, cy + r * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("N", cx, cy - r - fontSize * 1.2);
  }

  window.Cartography = {
    enabled: true,
    init,
    onCityChange,
    onBackgroundMode,
    applyBuildingStyle,
    drawExportCartouche,
    composeMapWithLabels,
    hideLabelsForExport(hide) {
      const c = document.getElementById("map-labels");
      if (c) c.style.visibility = hide ? "hidden" : "";
    },
  };
})();
