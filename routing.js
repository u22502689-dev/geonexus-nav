/*
 * GeoNexus - 2D pathway routing system and map controller.
 *
 * Starts: Dashboard_loc.geojson (by "LCD Display Name")
 * Destinations: building_entrances.geojson (by "Entrance Name")
 */
(function (global) {
  "use strict";

  const EARTH = 6378137;
  const RAD = Math.PI / 180;
  const SNAP_TOLERANCE = 1.5; // metres

  function extractLines(geojson) {
    const lines = [];
    ((geojson && geojson.features) || []).forEach((f) => {
      const g = f.geometry;
      if (!g) return;
      if (g.type === "LineString") lines.push(g.coordinates);
      else if (g.type === "MultiLineString") g.coordinates.forEach((l) => lines.push(l));
    });
    return lines;
  }

  function extractPoints(geojson, nameProperty) {
    const points = [];
    ((geojson && geojson.features) || []).forEach((f, index) => {
      const g = f.geometry;
      if (!g || g.type !== "Point") return;
      const props = f.properties || {};
      const name = props[nameProperty] || props.name || props.Name || `Point ${index + 1}`;
      points.push({
        id: index,
        name: String(name),
        coordinates: g.coordinates // [lng, lat]
      });
    });
    return points;
  }

  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(p, v) {
      const a = this.a;
      a.push([p, v]);
      let i = a.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (a[parent][0] <= a[i][0]) break;
        [a[parent], a[i]] = [a[i], a[parent]];
        i = parent;
      }
    }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  }

  function segmentIntersectionT(a1, a2, b1, b2) {
    const rx = a2.x - a1.x, ry = a2.y - a1.y;
    const sx = b2.x - b1.x, sy = b2.y - b1.y;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const qx = b1.x - a1.x, qy = b1.y - a1.y;
    const t = (qx * sy - qy * sx) / denom;
    const u = (qx * ry - qy * rx) / denom;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  }

  function projectOnSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return { t: 0, dist: Math.hypot(p.x - a.x, p.y - a.y) };
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { t, dist: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) };
  }

  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  class PathNetwork {
    constructor(pathwaysGeojson, options) {
      this.tol = (options && options.snapTolerance) || SNAP_TOLERANCE;
      this.nodes = [];
      this.edges = [];
      this.origin = null;
      this._grid = new Map();

      const lines = extractLines(pathwaysGeojson);
      for (const line of lines) {
        if (line.length && !this.origin) {
          this.origin = { lon: line[0][0] * RAD, lat: line[0][1] * RAD };
        }
      }
      if (!this.origin) return;

      const segs = [];
      for (const line of lines) {
        for (let i = 0; i < line.length - 1; i++) {
          segs.push({
            a: line[i], b: line[i + 1],
            a2: this._xy(line[i]), b2: this._xy(line[i + 1])
          });
        }
      }

      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const ts = [0, 1];
        for (let j = 0; j < segs.length; j++) {
          if (i === j) continue;
          const o = segs[j];
          const t = segmentIntersectionT(s.a2, s.b2, o.a2, o.b2);
          if (t !== null) ts.push(t);
          for (const end of [o.a2, o.b2]) {
            const proj = projectOnSegment(end, s.a2, s.b2);
            if (proj.dist <= this.tol && proj.t > 0 && proj.t < 1) ts.push(proj.t);
          }
        }
        ts.sort((p, q) => p - q);
        let prev = -1;
        for (const t of ts) {
          const idx = this._node(lerp(s.a, s.b, t));
          if (prev >= 0) this._connect(prev, idx);
          prev = idx;
        }
      }

      this.nodes.forEach((n, i) => {
        for (const j of n.nb.keys()) if (i < j) this.edges.push([i, j]);
      });
    }

    _xy(c) {
      return {
        x: (c[0] * RAD - this.origin.lon) * Math.cos(this.origin.lat) * EARTH,
        y: (c[1] * RAD - this.origin.lat) * EARTH
      };
    }

    _node(lonlat) {
      const xy = this._xy(lonlat);
      const cx = Math.floor(xy.x / this.tol), cy = Math.floor(xy.y / this.tol);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = this._grid.get((cx + dx) + "," + (cy + dy));
          if (!bucket) continue;
          for (const i of bucket) {
            const n = this.nodes[i];
            if (Math.hypot(n.xy.x - xy.x, n.xy.y - xy.y) <= this.tol) return i;
          }
        }
      }
      const idx = this.nodes.length;
      this.nodes.push({ lonlat, xy, nb: new Map() });
      const key = cx + "," + cy;
      if (!this._grid.has(key)) this._grid.set(key, []);
      this._grid.get(key).push(idx);
      return idx;
    }

    _connect(a, b) {
      if (a === b) return;
      const A = this.nodes[a].xy, B = this.nodes[b].xy;
      const d = Math.hypot(A.x - B.x, A.y - B.y);
      if (!Number.isFinite(d) || d <= 0) return;
      this.nodes[a].nb.set(b, d);
      this.nodes[b].nb.set(a, d);
    }

    snap(lonlat) {
      const p = this._xy(lonlat);
      let best = null;
      for (const [i, j] of this.edges) {
        const proj = projectOnSegment(p, this.nodes[i].xy, this.nodes[j].xy);
        if (!best || proj.dist < best.dist) best = { a: i, b: j, t: proj.t, dist: proj.dist };
      }
      if (!best) return null;
      best.point = lerp(this.nodes[best.a].lonlat, this.nodes[best.b].lonlat, best.t);
      best.xy = this._xy(best.point);
      return best;
    }

    route(from, to) {
      if (!this.edges.length) throw new Error("No pathway lines were found.");
      const s = this.snap(from);
      const e = this.snap(to);
      if (!s || !e) throw new Error("Could not snap points to pathway network.");

      const S = -1, E = -2;
      const extra = new Map();
      const xyOf = (id) => (id === S ? s.xy : id === E ? e.xy : this.nodes[id].xy);
      const lonlatOf = (id) => (id === S ? s.point : id === E ? e.point : this.nodes[id].lonlat);
      const add = (x, y) => {
        const X = xyOf(x), Y = xyOf(y);
        const d = Math.max(Math.hypot(X.x - Y.x, X.y - Y.y), 1e-6);
        if (!extra.has(x)) extra.set(x, []);
        if (!extra.has(y)) extra.set(y, []);
        extra.get(x).push([y, d]);
        extra.get(y).push([x, d]);
      };
      add(S, s.a); add(S, s.b);
      add(E, e.a); add(E, e.b);
      if ((s.a === e.a && s.b === e.b) || (s.a === e.b && s.b === e.a)) add(S, E);

      const dist = new Map([[S, 0]]);
      const prev = new Map();
      const heap = new Heap();
      heap.push(0, S);

      while (heap.size) {
        const [d, u] = heap.pop();
        if (d > (dist.has(u) ? dist.get(u) : Infinity)) continue;
        if (u === E) break;
        const nbrs = [];
        if (u >= 0) for (const kv of this.nodes[u].nb) nbrs.push(kv);
        if (extra.has(u)) nbrs.push(...extra.get(u));
        for (const [v, w] of nbrs) {
          const nd = d + w;
          if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
            dist.set(v, nd);
            prev.set(v, u);
            heap.push(nd, v);
          }
        }
      }

      if (!dist.has(E)) {
        throw new Error("No connected route found.");
      }

      const ids = [];
      for (let cur = E; cur !== undefined; cur = prev.get(cur)) ids.push(cur);
      ids.reverse();

      const path = [from, ...ids.map(lonlatOf), to].map((c) => [c[1], c[0]]);
      return { path, distance: dist.get(E) };
    }
  }

  const api = { PathNetwork, extractPoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.PathRouter = api;
})(typeof window !== "undefined" ? window : globalThis);

/* ---------- 2D MAP CONTROLLER & UI ---------- */

(function () {
  "use strict";

  const CFG = window.GEONEXUS || {};
  const $ = (id) => document.getElementById(id);

  const setStatus = (msg, isError) => {
    const statusEl = $("routeStatus") || $("status");
    if (statusEl) {
      statusEl.textContent = msg || "";
      statusEl.style.color = isError ? "#ef4444" : "#2dd4bf";
    }
  };

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
    return res.json();
  }

  const mapContainer = $("map");
  if (!mapContainer) return;

  const map = L.map("map", { zoomControl: true }).setView([-25.7545, 28.2315], 17);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  const layers = {
    aoi: L.layerGroup().addTo(map),
    paths: L.layerGroup().addTo(map),
    screens: L.layerGroup().addTo(map),
    entrances: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map)
  };

  const screenIcon = L.divIcon({
    className: "custom-screen-marker",
    html: `<div style="background-color: #06b6d4; width: 14px; height: 14px; border-radius: 3px; border: 2px solid #ffffff; box-shadow: 0 0 8px rgba(6,182,212,0.8);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  const entranceIcon = L.divIcon({
    className: "custom-entrance-marker",
    html: `<div style="background-color: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 6px rgba(59,130,246,0.8);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  let network = null;
  let screens = [];
  let entrances = [];

  function findItem(list, param) {
    if (param === null || param === undefined || param === "") return null;
    const q = String(param).trim();
    return (
      list.find((item) => String(item.id) === q) ||
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

  function setURLParams(s, d) {
    const url = new URL(window.location.href);
    ["s", "d"].forEach((k) => url.searchParams.delete(k));
    if (s !== null && d !== null) {
      url.searchParams.set("s", s);
      url.searchParams.set("d", d);
    }
    history.replaceState(null, "", url.toString());
  }

  function showRoute(start, dest) {
    layers.route.clearLayers();

    let r;
    try {
      r = network.route(start.coordinates, dest.coordinates);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }

    L.polyline(r.path, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(layers.route);
    const line = L.polyline(r.path, { color: "#ec4899", weight: 5, opacity: 1 }).addTo(layers.route);

    const dot = (latLng, color, text) =>
      L.circleMarker(latLng, {
        radius: 8, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1
      }).bindTooltip(text, { permanent: true, direction: "top", offset: [0, -10] }).addTo(layers.route);

    const startLatLng = [start.coordinates[1], start.coordinates[0]];
    const destLatLng = [dest.coordinates[1], dest.coordinates[0]];

    dot(startLatLng, "#22c55e", `START: ${start.name}`);
    dot(destLatLng, "#ef4444", `END: ${dest.name}`);

    map.fitBounds(line.getBounds(), { padding: [50, 50] });

    const walkSpeed = CFG.WALK_SPEED_MS || 1.4;
    const mins = Math.max(1, Math.round(r.distance / walkSpeed / 60));

    if ($("cardStart")) $("cardStart").textContent = start.name;
    if ($("cardDest")) $("cardDest").textContent = dest.name;
    if ($("cardEta")) $("cardEta").textContent = `≈ ${mins} min (${Math.round(r.distance)} m)`;

    const startSelect = $("startBuilding") || $("selStart");
    const endSelect = $("endBuilding") || $("selDest");
    if (startSelect) startSelect.value = start.id;
    if (endSelect) endSelect.value = end.id;

    setURLParams(start.id, dest.id);
    setStatus(`Route calculated: ${start.name} → ${dest.name}`);
  }

  async function init() {
    try {
      const screensUrl = CFG.SCREENS_URL || "Dashboard_loc.geojson";
      const entrancesUrl = CFG.ENTRANCES_URL || "building_entrances.geojson";
      const pathwaysUrl = CFG.PATHWAYS_URL || "Pathways.geojson";
      const aoiUrl = CFG.AOI_URL || "campus_aoi.geojson";

      const [sGeo, eGeo, pGeo] = await Promise.all([
        fetchJSON(screensUrl),
        fetchJSON(entrancesUrl),
        fetchJSON(pathwaysUrl)
      ]);

      screens = PathRouter.extractPoints(sGeo, "LCD Display Name");
      entrances = PathRouter.extractPoints(eGeo, "Entrance Name");
      network = new PathRouter.PathNetwork(pGeo);

      screens.forEach((s) => {
        const latLng = [s.coordinates[1], s.coordinates[0]];
        L.marker(latLng, { icon: screenIcon })
          .bindTooltip(`LCD Screen: ${s.name}`)
          .addTo(layers.screens);
      });

      entrances.forEach((e) => {
        const latLng = [e.coordinates[1], e.coordinates[0]];
        L.marker(latLng, { icon: entranceIcon })
          .bindTooltip(`Entrance: ${e.name}`)
          .addTo(layers.entrances);
      });

      L.geoJSON(pGeo, {
        style: { color: "#24fb5a", weight: 3, opacity: 0.6 },
        interactive: false
      }).addTo(layers.paths);

      try {
        const aoiGeo = await fetchJSON(aoiUrl);
        const aoiLayer = L.geoJSON(aoiGeo, {
          style: { color: "#ef4444", weight: 2, fillOpacity: 0.05 },
          interactive: false
        }).addTo(layers.aoi);

        if (aoiLayer.getBounds().isValid()) {
          map.fitBounds(aoiLayer.getBounds());
        }
      } catch (e) {
        const pBounds = L.geoJSON(pGeo).getBounds();
        if (pBounds.isValid()) map.fitBounds(pBounds);
      }

      const startSelect = $("startBuilding") || $("selStart");
      const endSelect = $("endBuilding") || $("selDest");

      fillSelect(startSelect, screens, "Select starting LCD display screen");
      fillSelect(endSelect, entrances, "Select destination entrance");

      setStatus("");
      setTimeout(() => map.invalidateSize(), 200);

    } catch (err) {
      console.error(err);
      setStatus(`${err.message}. Ensure files are served over HTTP/HTTPS.`, true);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.has("s") && params.has("d")) {
      const s = findItem(screens, params.get("s"));
      const d = findItem(entrances, params.get("d"));
      if (s && d) {
        showRoute(s, d);
      } else {
        setStatus("Target display screen or building entrance point was not found.", true);
      }
    }
  }

  const showRouteBtn = $("findRoute") || $("btnShowRoute") || document.querySelector("button");
  if (showRouteBtn) {
    showRouteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const startSelect = $("startBuilding") || $("selStart");
      const endSelect = $("endBuilding") || $("selDest");

      if (!startSelect || !endSelect) return;

      const s = findItem(screens, startSelect.value);
      const d = findItem(entrances, endSelect.value);

      if (!s || !d) {
        setStatus("Please select both a start screen and a destination entrance.", true);
        return;
      }
      showRoute(s, d);
    });
  }

  init();
})();
