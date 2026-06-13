const ERA_ORDER = [1, 2, 3, 4, 5, 0];
const ERA_LABELS = {
  1: "Before 1980",
  2: "1980–1989",
  3: "1990–1999",
  4: "2000–2009",
  5: "2010–2020",
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

let cities = [];
let meta = null;
let currentCity = null;
let animTimer = null;
let playing = false;

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
  document.getElementById("legend-title").textContent =
    `${meta.name} — building construction period`;

  const container = document.getElementById("legend-items");
  container.innerHTML = "";
  ERA_ORDER.forEach((epoch) => {
    const row = document.createElement("div");
    row.className = "legend-item";
    row.innerHTML =
      `<span class="swatch" style="background:${ERA_COLORS[epoch]}"></span>` +
      `<span>${ERA_LABELS[epoch]}</span>`;
    container.appendChild(row);
  });

  const attr = meta.attribution || {};
  document.getElementById("legend-meta").textContent =
    `${meta.total_buildings.toLocaleString()} buildings · OSM + GHS-OBAT (JRC)`;

  document.getElementById("count-label").textContent =
    `${meta.total_buildings.toLocaleString()} footprints`;
}

function visibleEpochs(upToIndex) {
  if (upToIndex >= ERA_ORDER.length - 1) return ERA_ORDER;
  return ERA_ORDER.slice(0, upToIndex + 1);
}

function applyFilter(stepIndex) {
  const epochs = visibleEpochs(stepIndex);
  map.setFilter("buildings-fill", ["in", ["get", "epoch"], ["literal", epochs]]);
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
      if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) {
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

  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(x, y, panelW, panelH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.font = `600 ${titleSize}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(`${meta.name} · building age`, x + pad, y + pad + titleSize);

  let cy = y + pad + titleSize + 22 * scale;
  ctx.font = `400 ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
  ERA_ORDER.forEach((epoch) => {
    ctx.fillStyle = ERA_COLORS[epoch];
    ctx.fillRect(x + pad, cy - swatchH + 2 * scale, swatchW, swatchH);
    ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
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

async function waitForFullRender() {
  applyFilter(ERA_ORDER.length - 1);
  map.setFilter("buildings-fill", null);
  let attempts = 0;
  while (!map.isSourceLoaded("buildings") && attempts < 120) {
    await new Promise((r) => setTimeout(r, 50));
    attempts += 1;
  }
  for (let i = 0; i < 4; i++) await waitForIdle();
}

async function exportPNG() {
  const btn = document.getElementById("btn-export");
  const sidebar = document.getElementById("sidebar");
  const mapEl = document.getElementById("map");
  const navCtrl = document.querySelector(".maplibregl-ctrl-bottom-right");
  const EXPORT_WIDTH = 4096;
  const bounds = buildingBounds();

  btn.disabled = true;
  btn.textContent = "Exporting…";
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
    map.resize();
    if (bounds) map.fitBounds(bounds, { padding: 0, duration: 0, maxZoom: 22 });

    await waitForFullRender();
    const cropped = cropCanvasToBuildings(map.getCanvas());
    drawExportLegend(cropped);
    await downloadCanvas(cropped, `${currentCity}-building-age.png`);
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
    sidebar.style.visibility = "";
    if (navCtrl) navCtrl.style.visibility = "";
    map.resize();
    map.jumpTo({ center: saved.center, zoom: saved.zoom, bearing: saved.bearing, pitch: saved.pitch });
    applyFilter(Number(document.getElementById("timeline").value));
    btn.disabled = false;
    btn.textContent = "⬇ Export PNG";
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

  const dataUrl = `data/${cityId}/buildings.geojson`;

  await new Promise((resolve) => {
    const attach = () => {
      if (map.getSource("buildings")) {
        map.getSource("buildings").setData(dataUrl);
      } else {
        map.addSource("buildings", { type: "geojson", data: dataUrl, generateId: true });
        map.addLayer({
          id: "buildings-fill",
          type: "fill",
          source: "buildings",
          paint: {
            "fill-color": ["coalesce", ["get", "color"], "#4a4a4a"],
            "fill-opacity": 1,
          },
        });
      }
      resolve();
    };
    if (map.isStyleLoaded()) attach();
    else map.once("load", attach);
  });
  await waitForFullRender();

  if (meta.bbox?.length === 4) {
    map.fitBounds([[meta.bbox[0], meta.bbox[1]], [meta.bbox[2], meta.bbox[3]]], {
      padding: { top: 40, bottom: 40, left: 40, right: 320 },
      duration: 0,
    });
  } else if (meta.center) {
    map.jumpTo({ center: meta.center, zoom: meta.default_zoom || 11 });
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

  await loadCity(defaultCity);
  setTimeout(startAnimation, 800);
}

init().catch((err) => {
  setLoading("Load error: " + err.message, true);
  console.error(err);
});
