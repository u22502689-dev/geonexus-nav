// GeoNexus deployment config (loaded by index.html and route.html).
window.GEONEXUS = {
  PUBLIC_BASE_URL: "https://u22502689-dev.github.io/geonexus-nav/",
  ROUTE_PAGE: "route.html",
  SCREENS_URL: "Dashboard_loc.geojson",
  ENTRANCES_URL: "building_entrances.geojson",
  PATHWAYS_URL: "Pathways.geojson",
  AOI_URL: "campus_aoi.geojson",
  WALK_SPEED_MS: 1.4 // metres per second, used for estimated walking time
};

(function () {
  "use strict";
  const CFG = window.GEONEXUS;
  const $ = (id) => document.getElementById(id);

  const setStatus = (msg, isError) => {
    if ($("status")) {
      $("status").textContent = msg || "";
      $("status").className = isError ? "error" : "";
    }
  };

  const map = L.map("map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  map.setView([-25.7545, 28.2290], 16);

  const routeLayer = L.layerGroup().addTo(map);
  const screensLayer = L.layerGroup().addTo(map);
  const entrancesLayer = L.layerGroup().addTo(map);

  let network = null;
  let screens = [];
  let entrances = [];

  // Custom icon for LCD display screens (Start points)
  const screenIcon = L.divIcon({
    className: "custom-screen-marker",
    html: `<div style="background-color: #0284c7; width: 14px; height: 14px; border-radius: 3px; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  // Custom icon for building entrances (End points)
  const entranceIcon = L.divIcon({
    className: "custom-entrance-marker",
    html: `<div style="background-color: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  /* ---------- Points parser helper ---------- */

  function parsePoints(geojson, nameProp, prefix) {
    const out = [];
    ((geojson && geojson.features) || []).forEach((f, idx) => {
      const g = f.geometry;
      if (!g || g.type !== "Point") return;
      const props = f.properties || {};
      const name = props[nameProp] || props.name || props.Name || `${prefix} ${idx + 1}`;
      out.push({
        id: String(idx),
        name: String(name),
        coordinates: g.coordinates, // [lng, lat]
        latLng: [g.coordinates[1], g.coordinates[0]] // [lat, lng] for Leaflet
      });
    });
    return out;
  }

  function findItem(list, param) {
    if (param === null || param === undefined || param === "") return null;
    const q = String(param).trim();
    return (
      list.find((item) => item.id === q) ||
      list.find((item) => item.name.toLowerCase() === q.toLowerCase()) ||
      null
    );
  }

  function fillSelect(sel, list, placeholder) {
    if (!sel) return;
    sel.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = placeholder;
    sel.appendChild(ph);
    [...list]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => {
        const o = document.createElement("option");
        o.value = item.id;
        o.textContent = item.name;
        sel.appendChild(o);
      });
  }

  /* ---------- URL State Sync ---------- */

  function setParams(s, d) {
    const url = new URL(window.location.href);
    ["s", "d"].forEach((k) => url.searchParams.delete(k));
    if (s !== null && d !== null) {
      url.searchParams.set("s", s);
      url.searchParams.set("d", d);
    }
    history.replaceState(null, "", url.toString());
  }

  /* ---------- Route Display ---------- */

  function showRoute(start, dest) {
    routeLayer.clearLayers();
    let r;
    try {
      // PathRouter takes coordinates as [lng, lat]
      r = network.route(start.coordinates, dest.coordinates);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }

    // Polyline outline and route line
    L.polyline(r.path, { color: "#ffffff", weight: 10, opacity: 0.95 }).addTo(routeLayer);
    const line = L.polyline(r.path, { color: "#ec4899", weight: 6 }).addTo(routeLayer);

    // Marker labels
    const dot = (latLng, color, cls, text) =>
      L.circleMarker(latLng, {
        radius: 9, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1
      }).bindTooltip(text, { permanent: true, direction: "top", offset: [0, -10], className: cls }).addTo(routeLayer);

    dot(start.latLng, "#22c55e", "label-start", "START: " + start.name);
    dot(dest.latLng, "#ef4444", "label-end", "END: " + dest.name);

    map.fitBounds(line.getBounds(), { padding: [50, 50] });

    const mins = Math.max(1, Math.round(r.distance / CFG.WALK_SPEED_MS / 60));
    if ($("cardStart")) $("cardStart").textContent = start.name;
    if ($("cardDest")) $("cardDest").textContent = dest.name;
    if ($("cardEta")) $("cardEta").textContent = "≈ " + mins + " min (" + Math.round(r.distance) + " m)";
    if ($("selStart")) $("selStart").value = start.id;
    if ($("selDest")) $("selDest").value = dest.id;
    if ($("btnEnd")) $("btnEnd").hidden = false;

    setParams(start.id, dest.id);
    setStatus("Route found: " + start.name + " → " + dest.name + ".");
  }

  function endRouting() {
    routeLayer.clearLayers();
    ["cardStart", "cardDest", "cardEta"].forEach((id) => {
      if ($(id)) $(id).textContent = "–";
    });
    if ($("btnEnd")) $("btnEnd").hidden = true;
    if ($("selStart")) $("selStart").value = "";
    if ($("selDest")) $("selDest").value = "";
    setParams(null, null);
    setStatus("Routing ended. Select a display screen and destination entrance.");
  }

  /* ---------- Data Loader ---------- */

  async function loadJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("Could not load " + url + " (HTTP " + res.status + ")");
    return res.json();
  }

  async function init() {
    try {
      const [sGeo, eGeo, pGeo] = await Promise.all([
        loadJSON(CFG.SCREENS_URL),
        loadJSON(CFG.ENTRANCES_URL),
        loadJSON(CFG.PATHWAYS_URL)
      ]);

      screens = parsePoints(sGeo, "LCD Display Name", "Display Screen");
      entrances = parsePoints(eGeo, "Entrance Name", "Building Entrance");
      network = new PathRouter.PathNetwork(pGeo);

      // Render Display Screen markers
      screens.forEach((s) => {
        L.marker(s.latLng, { icon: screenIcon })
          .bindTooltip(`LCD Screen: ${s.name}`)
          .addTo(screensLayer);
      });

      // Render Entrance markers
      entrances.forEach((e) => {
        L.marker(e.latLng, { icon: entranceIcon })
          .bindTooltip(`Entrance: ${e.name}`)
          .addTo(entrancesLayer);
      });

      // Pathways basemap overlay
      L.geoJSON(pGeo, { style: { color: "#16a34a", weight: 3, opacity: 0.7 }, interactive: false }).addTo(map);

      // Campus AOI boundary
      try {
        const aoi = await loadJSON(CFG.AOI_URL);
        const layer = L.geoJSON(aoi, { style: { color: "#ef4444", weight: 3, fillOpacity: 0.05 }, interactive: false }).addTo(map);
        if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds());
      } catch (e) {
        const b = L.geoJSON(pGeo).getBounds();
        if (b.isValid()) map.fitBounds(b);
      }

      fillSelect($("selStart"), screens, "Select starting LCD display screen");
      fillSelect($("selDest"), entrances, "Select destination entrance");
      setStatus("");
    } catch (err) {
      setStatus(err.message + ". Open this page over HTTP(S), not as a local file.", true);
      return;
    }

    // Process incoming URL search parameters (from QR Code scanning)
    const p = new URLSearchParams(window.location.search);
    if (p.has("s") || p.has("d")) {
      const s = findItem(screens, p.get("s"));
      const d = findItem(entrances, p.get("d"));
      if (s && d) {
        showRoute(s, d);
      } else {
        setStatus("This QR code refers to a screen or entrance point that was not found.", true);
      }
    } else {
      setStatus("Select a display screen and destination entrance to build a route.");
    }
  }

  const routeForm = $("routeForm");
  if (routeForm) {
    routeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!network) return;
      const s = findItem(screens, $("selStart").value);
      const d = findItem(entrances, $("selDest").value);
      if (!s || !d) {
        setStatus("Please choose both a start screen and a destination entrance.", true);
        return;
      }
      showRoute(s, d);
    });
  }

  if ($("btnEnd")) $("btnEnd").addEventListener("click", endRouting);

  init();
})();
