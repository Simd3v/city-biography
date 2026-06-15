const MAP_SUBTITLE = "Sand into city, by decade";

const ERA_ORDER = [1, 2, 3, 4, 5, 0];
const ERA_LABELS = {
  1: "Before 1980",
  2: "1980-1989",
  3: "1990-1999",
  4: "2000-2009",
  5: "2010-2020",
  0: "Unknown",
};

const ERA_COLORS = {
  1: "#c0392b",
  2: "#e67e22",
  3: "#f1c40f",
  4: "#2ecc71",
  5: "#3498db",
  0: "#4a4a4a",
};

/* ========== LIGHT-MODE-STYLING START (revert: delete block + updateBuildingStyle calls) ========== */
const ERA_COLORS_LIGHT = {
  1: "#C44E3B",
  2: "#D87A31",
  3: "#B58A28",
  4: "#4F8A5B",
  5: "#2E6E8E",
  0: "#8A8278",
};

/* White mode: warm (old) → coral rose (mid) → teal/blue (new) */
const ERA_COLORS_WHITE = {
  1: "#6E4050",
  2: "#9E5A68",
  3: "#E8A090",
  4: "#6EAAA6",
  5: "#5A90C0",
  0: "#B8B4B0",
};

const ERA_COLORS_BY_MODE = {
  black: ERA_COLORS,
  beige: ERA_COLORS_LIGHT,
  white: ERA_COLORS_WHITE,
};

const LIGHT_BUILDING_STYLE = {
  fillOpacity: 0.88,
  outlineColor: "rgba(0, 0, 0, 0.08)",
  shadowOpacity: 0.15,
  shadowTranslate: [0.5, 0.5],
};

const WHITE_BUILDING_STYLE = {
  fillOpacity: 0.92,
  outlineColor: "rgba(0, 0, 0, 0.06)",
  shadowOpacity: 0,
  shadowTranslate: [0, 0],
};

const DARK_BUILDING_STYLE = {
  fillOpacity: 1,
  outlineColor: "rgba(255, 255, 255, 0.08)",
  shadowOpacity: 0,
  shadowTranslate: [0, 0],
};

const BUILDING_STYLE_BY_MODE = {
  black: DARK_BUILDING_STYLE,
  beige: LIGHT_BUILDING_STYLE,
  white: WHITE_BUILDING_STYLE,
};
/* ========== LIGHT-MODE-STYLING END ========== */

const BACKGROUND_MODES = {
  black: {
    id: "black",
    label: "Black",
    map: "#000000",
    page: "#000000",
    cropThreshold: 12,
    legendTitle: "rgba(255, 255, 255, 0.95)",
    legendText: "rgba(255, 255, 255, 0.88)",
  },
  beige: {
    id: "beige",
    label: "Beige",
    map: "#D8D0C2",
    page: "#D8D0C2",
    cropThreshold: 20,
    legendTitle: "rgba(28, 24, 20, 0.92)",
    legendText: "rgba(48, 42, 36, 0.88)",
  },
  white: {
    id: "white",
    label: "White",
    map: "#FFFFFF",
    page: "#FFFFFF",
    cropThreshold: 18,
    legendTitle: "rgba(28, 24, 20, 0.92)",
    legendText: "rgba(48, 42, 36, 0.88)",
  },
};

let cities = [];
let meta = null;
let currentCity = null;
let backgroundMode = "black";
let animTimer = null;
let playing = false;
const buildingsCache = {};

const GEOJSON_SOURCE_OPTS = {
  tolerance: 0,
  maxzoom: 16,
  buffer: 128,
  generateId: true,
};

const BUILDING_LAYER_OPTS = {
  minzoom: 0,
  maxzoom: 24,
};

/* Print export: 7200px ≈ 60 cm @ 300 DPI on the long edge (typical city crop). */
const EXPORT_WIDTH = 7200;
const EXPORT_IDLE_PASSES = 8;
const EXPORT_CROP_MARGIN = 20;

function getTheme() {
  return BACKGROUND_MODES[backgroundMode] || BACKGROUND_MODES.black;
}

function parseHex(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function isBackgroundPixel(r, g, b, bgRgb, threshold) {
  return (
    Math.abs(r - bgRgb[0]) <= threshold &&
    Math.abs(g - bgRgb[1]) <= threshold &&
    Math.abs(b - bgRgb[2]) <= threshold
  );
}

function getEraColors() {
  return ERA_COLORS_BY_MODE[backgroundMode] || ERA_COLORS;
}

function getBuildingStyle() {
  return BUILDING_STYLE_BY_MODE[backgroundMode] || DARK_BUILDING_STYLE;
}

function eraColorExpression(colors) {
  return [
    "match",
    ["get", "epoch"],
    1, colors[1],
    2, colors[2],
    3, colors[3],
    4, colors[4],
    5, colors[5],
    colors[0],
  ];
}

function updateBuildingStyle() {
  if (!map.getLayer("buildings-fill")) return;
  const colors = getEraColors();
  const style = getBuildingStyle();
  map.setPaintProperty("buildings-fill", "fill-color", eraColorExpression(colors));
  map.setPaintProperty("buildings-fill", "fill-opacity", style.fillOpacity);
  if (window.Cartography?.enabled) {
    window.Cartography.applyBuildingStyle(map, backgroundMode);
  } else {
    map.setPaintProperty("buildings-fill", "fill-outline-color", style.outlineColor);
  }
  if (map.getLayer("buildings-shadow")) {
    const shadowOp = window.Cartography?.enabled ? 0 : style.shadowOpacity;
    map.setPaintProperty("buildings-shadow", "fill-opacity", shadowOp);
    map.setPaintProperty("buildings-shadow", "fill-translate", style.shadowTranslate);
  }
}

function applyBackgroundMode() {
  const theme = getTheme();
  document.documentElement.style.background = theme.page;
  document.body.style.background = theme.page;
  document.body.classList.remove("bg-black", "bg-beige", "bg-white");
  document.body.classList.add(`bg-${backgroundMode}`);
  document.getElementById("loading").style.background = theme.page;
  document.getElementById("loading").style.color =
    backgroundMode === "black" ? "#fff" : "#1c1814";

  if (map.isStyleLoaded()) {
    map.setPaintProperty("background", "background-color", theme.map);
    updateBuildingStyle();
    if (meta) buildLegend();
    if (window.Cartography?.enabled) {
      window.Cartography.onBackgroundMode(map, backgroundMode);
    } else {
      map.triggerRepaint();
    }
  }

  document.querySelectorAll("[data-bg-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bgMode === backgroundMode);
  });
}

function setBackgroundMode(mode) {
  if (!BACKGROUND_MODES[mode] || mode === backgroundMode) return;
  backgroundMode = mode;
  applyBackgroundMode();
}

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#000000" } }],
  },
  center: [54.45, 24.47],
  zoom: 11,
  attributionControl: false,
  fadeDuration: 0,
  preserveDrawingBuffer: true,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

function setLoading(text, visible = true) {
  const el = document.getElementById("loading");
  el.textContent = text;
  el.classList.toggle("hidden", !visible);
}

function buildLegend() {
  document.getElementById("legend-title").innerHTML =
    `<span class="legend-title-city">${meta.name}</span>` +
    `<span class="legend-title-sub">${MAP_SUBTITLE}</span>`;

  const container = document.getElementById("legend-items");
  container.innerHTML = "";
  const colors = getEraColors();
  ERA_ORDER.forEach((epoch) => {
    const row = document.createElement("div");
    row.className = "legend-item";
    row.innerHTML =
      `<span class="swatch" style="background:${colors[epoch]}"></span>` +
      `<span>${ERA_LABELS[epoch]}</span>`;
    container.appendChild(row);
  });

  const attr = meta.attribution || {};
  document.getElementById("legend-meta").textContent = window.Cartography?.enabled
    ? `${meta.total_buildings.toLocaleString()} buildings · Footprints: OpenStreetMap · Age: GHSL`
    : `${meta.total_buildings.toLocaleString()} buildings · OSM + GHS-OBAT (JRC)`;

  document.getElementById("count-label").textContent =
    `${meta.total_buildings.toLocaleString()} footprints`;
}

function visibleEpochs(upToIndex) {
  if (upToIndex >= ERA_ORDER.length - 1) return ERA_ORDER;
  return ERA_ORDER.slice(0, upToIndex + 1);
}

function applyFilter(stepIndex) {
  const epochs = visibleEpochs(stepIndex);
  const filter = ["in", ["get", "epoch"], ["literal", epochs]];
  map.setFilter("buildings-fill", filter);
  if (map.getLayer("buildings-shadow")) {
    map.setFilter("buildings-shadow", filter);
  }
  const lastEpoch = epochs[epochs.length - 1];
  document.getElementById("era-label").textContent =
    stepIndex >= ERA_ORDER.length - 1 ? "All periods" : `Up to: ${ERA_LABELS[lastEpoch]}`;
  document.getElementById("timeline").value = String(stepIndex);
}

function stopAnimation() {
  playing = false;
  clearInterval(animTimer);
  animTimer = null;
  const btn = document.getElementById("btn-play");
  btn.textContent = "▶ Animate";
  btn.classList.remove("active");
}

function startAnimation() {
  stopAnimation();
  playing = true;
  const btn = document.getElementById("btn-play");
  btn.textContent = "⏸ Pause";
  btn.classList.add("active");
  let step = 0;
  applyFilter(step);
  animTimer = setInterval(() => {
    step += 1;
    if (step >= ERA_ORDER.length) {
      stopAnimation();
      applyFilter(ERA_ORDER.length - 1);
      return;
    }
    applyFilter(step);
  }, 1400);
}

function buildingBounds() {
  if (!meta?.bbox || meta.bbox.length !== 4) return null;
  const [w, s, e, n] = meta.bbox;
  return new maplibregl.LngLatBounds([w, s], [e, n]);
}

function boundsAspectRatio(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const latMid = (sw.lat + ne.lat) / 2;
  const width = (ne.lng - sw.lng) * Math.cos((latMid * Math.PI) / 180);
  const height = ne.lat - sw.lat;
  return width / height;
}

function cropCanvasToBuildings(sourceCanvas, marginPx = 12) {
  const theme = getTheme();
  const bgRgb = parseHex(theme.map);
  const threshold = theme.cropThreshold;

  const copy = document.createElement("canvas");
  copy.width = sourceCanvas.width;
  copy.height = sourceCanvas.height;
  const ctx = copy.getContext("2d");
  if (!ctx) return sourceCanvas;
  ctx.drawImage(sourceCanvas, 0, 0);

  const { width, height } = copy;
  const { data } = ctx.getImageData(0, 0, width, height);
  let minX = width, minY = height, maxX = 0, maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!isBackgroundPixel(data[i], data[i + 1], data[i + 2], bgRgb, threshold)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return copy;

  minX = Math.max(0, minX - marginPx);
  minY = Math.max(0, minY - marginPx);
  maxX = Math.min(width - 1, maxX + marginPx);
  maxY = Math.min(height - 1, maxY + marginPx);

  const cropped = document.createElement("canvas");
  cropped.width = maxX - minX + 1;
  cropped.height = maxY - minY + 1;
  cropped.getContext("2d").drawImage(
    copy, minX, minY, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height
  );
  return cropped;
}

function drawExportLegend(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !meta) return canvas;

  const theme = getTheme();
  const scale = canvas.width / 1400;
  const pad = 14 * scale;
  const x = 20 * scale;
  const y = 20 * scale;
  const lineH = 17 * scale;
  const swatchW = 12 * scale;
  const swatchH = 9 * scale;
  const fontSize = 12 * scale;
  const titleSize = 13 * scale;
  const panelW = 200 * scale;
  const panelH = pad * 2 + titleSize + 20 * scale + ERA_ORDER.length * lineH;

  ctx.fillStyle = theme.map;
  ctx.fillRect(x, y, panelW, panelH);
  ctx.fillStyle = theme.legendTitle;
  ctx.font = `600 ${titleSize}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(`${meta.name} - ${MAP_SUBTITLE}`, x + pad, y + pad + titleSize);

  let cy = y + pad + titleSize + 22 * scale;
  ctx.font = `400 ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
  const legendColors = getEraColors();
  ERA_ORDER.forEach((epoch) => {
    ctx.fillStyle = legendColors[epoch];
    ctx.fillRect(x + pad, cy - swatchH + 2 * scale, swatchW, swatchH);
    ctx.fillStyle = theme.legendText;
    ctx.fillText(ERA_LABELS[epoch], x + pad + swatchW + 7 * scale, cy);
    cy += lineH;
  });
  return canvas;
}

function downloadCanvas(canvas, filename) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Could not generate PNG"));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        link.remove();
        resolve();
      }, 200);
    }, "image/png");
  });
}

function waitForIdle() {
  return new Promise((resolve) => {
    map.once("idle", resolve);
    map.triggerRepaint();
  });
}

async function waitForFullRender(idlePasses = 4) {
  applyFilter(ERA_ORDER.length - 1);
  map.setFilter("buildings-fill", null);
  if (map.getLayer("buildings-shadow")) map.setFilter("buildings-shadow", null);
  let attempts = 0;
  while (!map.isSourceLoaded("buildings") && attempts < 120) {
    await new Promise((r) => setTimeout(r, 50));
    attempts += 1;
  }
  for (let i = 0; i < idlePasses; i++) await waitForIdle();
}

async function exportPNG() {
  const btn = document.getElementById("btn-export");
  const sidebar = document.getElementById("sidebar");
  const mapEl = document.getElementById("map");
  const navCtrl = document.querySelector(".maplibregl-ctrl-bottom-right");
  const bounds = buildingBounds();

  btn.disabled = true;
  btn.textContent = "Exporting (print)…";
  stopAnimation();

  const saved = {
    mapWidth: mapEl.style.width,
    mapHeight: mapEl.style.height,
    mapPosition: mapEl.style.position,
    mapLeft: mapEl.style.left,
    mapTop: mapEl.style.top,
    mapZIndex: mapEl.style.zIndex,
    bodyOverflow: document.body.style.overflow,
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    pixelRatio: typeof map.getPixelRatio === "function" ? map.getPixelRatio() : window.devicePixelRatio,
  };

  try {
    sidebar.style.visibility = "hidden";
    if (navCtrl) navCtrl.style.visibility = "hidden";

    const aspect = bounds ? boundsAspectRatio(bounds) : mapEl.clientWidth / mapEl.clientHeight;
    const exportHeight = Math.round(EXPORT_WIDTH / aspect);
    Object.assign(mapEl.style, {
      position: "fixed", left: "0", top: "0", zIndex: "9999",
      width: `${EXPORT_WIDTH}px`, height: `${exportHeight}px`,
    });
    document.body.style.overflow = "hidden";
    if (typeof map.setPixelRatio === "function") map.setPixelRatio(1);
    map.resize();
    if (bounds) map.fitBounds(bounds, { padding: 0, duration: 0, maxZoom: 22 });

    await waitForFullRender(EXPORT_IDLE_PASSES);
    if (window.Cartography?.enabled) window.Cartography.hideLabelsForExport(true);
    await waitForIdle();
    const mapCanvas = window.Cartography?.enabled
      ? window.Cartography.composeMapWithLabels(map, backgroundMode)
      : map.getCanvas();
    const cropped = cropCanvasToBuildings(mapCanvas, EXPORT_CROP_MARGIN);
    if (window.Cartography?.enabled) {
      window.Cartography.drawExportCartouche(
        cropped, meta, getTheme(), getEraColors(), ERA_ORDER, ERA_LABELS, backgroundMode
      );
    } else {
      drawExportLegend(cropped);
    }
    await downloadCanvas(cropped, `${currentCity}-building-age-${backgroundMode}.png`);
  } catch (err) {
    console.error(err);
    alert("Export failed: " + err.message);
  } finally {
    mapEl.style.width = saved.mapWidth;
    mapEl.style.height = saved.mapHeight;
    mapEl.style.position = saved.mapPosition;
    mapEl.style.left = saved.mapLeft;
    mapEl.style.top = saved.mapTop;
    mapEl.style.zIndex = saved.mapZIndex;
    document.body.style.overflow = saved.bodyOverflow;
    if (typeof map.setPixelRatio === "function") map.setPixelRatio(saved.pixelRatio);
    sidebar.style.visibility = "";
    if (navCtrl) navCtrl.style.visibility = "";
    if (window.Cartography?.enabled) window.Cartography.hideLabelsForExport(false);
    map.resize();
    map.jumpTo({ center: saved.center, zoom: saved.zoom, bearing: saved.bearing, pitch: saved.pitch });
    applyFilter(Number(document.getElementById("timeline").value));
    btn.disabled = false;
    btn.textContent = "⬇ Export PNG";
  }
}

async function fetchBuildings(cityId) {
  if (!buildingsCache[cityId]) {
    const resp = await fetch(`data/${cityId}/buildings.geojson`);
    if (!resp.ok) throw new Error(`Failed to load buildings for ${cityId}`);
    buildingsCache[cityId] = await resp.json();
  }
  return buildingsCache[cityId];
}

function evictBuildingsCache(keepCityId) {
  for (const id of Object.keys(buildingsCache)) {
    if (id !== keepCityId) delete buildingsCache[id];
  }
}

function renderCityButtons() {
  const container = document.getElementById("city-switcher");
  container.innerHTML = "";
  cities.forEach((city) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "city-btn" + (city.id === currentCity ? " active" : "");
    btn.textContent = city.name;
    btn.addEventListener("click", () => loadCity(city.id));
    container.appendChild(btn);
  });
}

async function loadCity(cityId) {
  if (cityId === currentCity && map.getSource("buildings")) return;

  stopAnimation();
  setLoading(`Loading ${cityId.replace("-", " ")}…`, true);
  currentCity = cityId;

  const metaResp = await fetch(`data/${cityId}/meta.json`);
  meta = await metaResp.json();
  buildLegend();
  renderCityButtons();

  const buildingsData = await fetchBuildings(cityId);

  await new Promise((resolve) => {
    const attach = () => {
      if (map.getSource("buildings")) {
        map.getSource("buildings").setData(buildingsData);
        updateBuildingStyle();
      } else {
        map.addSource("buildings", {
          type: "geojson",
          data: buildingsData,
          ...GEOJSON_SOURCE_OPTS,
        });
        map.addLayer({
          id: "buildings-shadow",
          type: "fill",
          source: "buildings",
          ...BUILDING_LAYER_OPTS,
          paint: {
            "fill-color": "#000000",
            "fill-opacity": 0,
            "fill-translate": [0.5, 0.5],
          },
        });
        map.addLayer({
          id: "buildings-fill",
          type: "fill",
          source: "buildings",
          ...BUILDING_LAYER_OPTS,
          paint: {
            "fill-color": eraColorExpression(ERA_COLORS),
            "fill-opacity": 1,
            "fill-outline-color": "rgba(255, 255, 255, 0.08)",
            "fill-antialias": true,
          },
        });
        updateBuildingStyle();
      }
      resolve();
    };
    if (map.isStyleLoaded()) attach();
    else map.once("load", attach);
  });
  evictBuildingsCache(cityId);
  delete buildingsCache[cityId];

  await waitForFullRender();

  if (meta.bbox?.length === 4) {
    map.fitBounds([[meta.bbox[0], meta.bbox[1]], [meta.bbox[2], meta.bbox[3]]], {
      padding: { top: 40, bottom: 40, left: 40, right: 320 },
      duration: 0,
    });
  } else if (meta.center) {
    map.jumpTo({ center: meta.center, zoom: meta.default_zoom || 11 });
  }

  if (window.Cartography?.enabled) {
    await window.Cartography.onCityChange(map, cityId, meta, backgroundMode);
  }

  setLoading("", false);
  applyFilter(ERA_ORDER.length - 1);
}

async function init() {
  const resp = await fetch("cities.json");
  const manifest = await resp.json();
  cities = manifest.cities;
  const defaultCity = cities[0]?.id || "abu-dhabi";

  document.getElementById("btn-play").addEventListener("click", () => {
    if (playing) stopAnimation();
    else startAnimation();
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    stopAnimation();
    applyFilter(ERA_ORDER.length - 1);
  });
  document.getElementById("btn-export").addEventListener("click", (e) => {
    e.preventDefault();
    exportPNG();
  });
  document.getElementById("timeline").addEventListener("input", (e) => {
    stopAnimation();
    applyFilter(Number(e.target.value));
  });

  document.querySelectorAll("[data-bg-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setBackgroundMode(btn.dataset.bgMode));
  });

  map.once("load", () => applyBackgroundMode());
  if (window.Cartography?.enabled) window.Cartography.init(map);

  await loadCity(defaultCity);

  setTimeout(startAnimation, 800);
}

function bootApp() {
  init().catch((err) => {
    setLoading("Load error: " + err.message, true);
    console.error(err);
  });
}

if (window.MOBILE_GATE_SKIP) {
  window.addEventListener("mobile-gate-dismissed", () => {
    document.getElementById("sidebar")?.style.removeProperty("visibility");
    document.getElementById("map")?.style.removeProperty("visibility");
    bootApp();
  }, { once: true });
} else {
  bootApp();
}
