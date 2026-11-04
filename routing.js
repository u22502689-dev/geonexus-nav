// ==========================================
// GEONEXUS PATH ROUTER
// Shared by the 2D page (Leaflet) and the 3D page (Cesium).
// Provides: config normalisation, stable-ID point extraction, the pathway
// graph + shortest-path routing, and share-URL building.
// ==========================================

window.PathRouter = (function () {
  "use strict";

  const EARTH = 6378137;
  const RAD = Math.PI / 180;
  const DEFAULT_SNAP_TOLERANCE = 1.5; // metres: nodes closer than this are merged
  const SEGMENT_CELL = 25;            // metres: cell size of the segment spatial index

  // Stable ID lookup order. Add an "Entrance ID" / "Screen ID" property to your
  // GeoJSON so QR codes keep working when features are re-ordered or removed.
  const ID_FIELDS = ["Entrance ID", "Screen ID", "ID", "Id", "id", "FID", "fid", "OBJECTID", "objectid"];
  // Optional pathway attribute: segments on different layers/levels do not
  // create junctions where they cross (bridges, tunnels).
  const LAYER_FIELDS = ["layer", "Layer", "level", "Level"];

  /* ---------- Config (supports flat and nested keys) ---------- */

  function getConfig() {
    const C = window.GEONEXUS || {};
    const D = C.DATA || {};
    const R = C.ROUTING || {};
    return {
      cesiumToken: C.CESIUM_TOKEN || "",
      screensUrl: D.SCREENS || C.SCREENS_URL || "Dashboard_loc.geojson",
      entrancesUrl: D.ENTRANCES || C.ENTRANCES_URL || "building_entrances.geojson",
      pathwaysUrl: D.PATHWAYS || C.PATHWAYS_URL || "Pathways.geojson",
      buildingsUrl: D.BUILDINGS || C.BUILDINGS_URL || "Buildings.geojson",
      aoiUrl: D.AOI || C.AOI_URL || "campus_aoi.geojson",
      routePage: C.ROUTE_PAGE || "route.html",
      publicBaseUrl: C.PUBLIC_BASE_URL || "",
      // The public OSM tile server is for light use only. For a QR-driven,
      // publicly shared app, point TILE_URL at a proper tile provider.
      tileUrl: C.TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      tileAttribution:
        C.TILE_ATTRIBUTION ||
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      // Off by default: the external QR service receives your route URLs.
      allowExternalQr: C.ALLOW_EXTERNAL_QR === true,
      routing: {
        routeColor: R.ROUTE_COLOR || "#ec4899",
        startColor: R.START_COLOR || "#22c55e",
        destColor: R.DESTINATION_COLOR || "#ef4444",
        walkSpeed: R.WALK_SPEED_MS || 1.4,
        snapTolerance: R.SNAP_TOLERANCE_M || DEFAULT_SNAP_TOLERANCE,
        maxSnapDistance: R.MAX_SNAP_M || 75,
        maxGpsSnapDistance: R.MAX_GPS_SNAP_M || 100,
        gpsMinMove: R.GPS_MIN_MOVE_M || 3
      }
    };
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
    return res.json();
  }

  // False when the page is on localhost / file://, where a QR code cannot work from a phone.
  function isShareableHost() {
    const h = window.location.hostname;
    if (window.location.protocol === "file:") return false;
    return !(h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1");
  }

  function buildRouteUrl(startId, destId) {
    const cfg = getConfig();
    const base = cfg.publicBaseUrl
      ? cfg.publicBaseUrl.replace(/\/?$/, "/") + cfg.routePage
      : new URL(cfg.routePage, window.location.href).href;
    const url = new URL(base);
    url.searchParams.set("s", startId);
    url.searchParams.set("d", destId);
    return url.href;
  }

  /* ---------- GeoJSON extraction ---------- */

  function firstDefined(props, fields) {
    for (const f of fields) {
      const v = props[f];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  }

  function extractLines(geojson) {
    const lines = [];
    for (const f of (geojson && geojson.features) || []) {
      const g = f.geometry;
      if (!g) continue;
      const layer = String(firstDefined(f.properties || {}, LAYER_FIELDS) ?? 0);
      if (g.type === "LineString") lines.push({ coords: g.coordinates, layer });
      else if (g.type === "MultiLineString") {
        for (const l of g.coordinates) lines.push({ coords: l, layer });
      }
    }
    return lines;
  }

  // Both the 2D and 3D apps call this on the same GeoJSON, so IDs always match.
  // ID = feature.id, or an ID property, or (fallback) "f<feature index>".
  function extractPoints(geojson, nameProperty) {
    const points = [];
    const used = new Set();
    ((geojson && geojson.features) || []).forEach((f, index) => {
      const g = f.geometry;
      if (!g) return;
      let coords = null;
      if (g.type === "Point") coords = g.coordinates;
      else if (g.type === "MultiPoint" && g.coordinates.length) coords = g.coordinates[0];
      if (!coords) return;

      const props = f.properties || {};
      const name = props[nameProperty] || props.name || props.Name || `Point ${index + 1}`;

      let id = f.id ?? firstDefined(props, ID_FIELDS);
      id = id === undefined || id === null || id === "" ? `f${index}` : String(id);
      if (used.has(id)) id = `${id}_${index}`;
      used.add(id);

      points.push({
        id,
        featureIndex: index,
        name: String(name),
        coordinates: [coords[0], coords[1]] // GeoJSON [lng, lat]
      });
    });
    return points;
  }

  /* ---------- Binary heap ---------- */

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

  /* ---------- Geometry helpers ---------- */

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

  /* ---------- Path network ---------- */

  class PathNetwork {
    constructor(pathwaysGeojson, options = {}) {
      this.tol = options.snapTolerance || DEFAULT_SNAP_TOLERANCE;
      this.maxSnap = Number.isFinite(options.maxSnapDistance) ? options.maxSnapDistance : Infinity;
      this.nodes = [];
      this.edges = [];
      this.origin = null;
      this.droppedComponents = 0;
      this._grid = new Map();

      const lines = extractLines(pathwaysGeojson);
      for (const line of lines) {
        if (line.coords.length) {
          this.origin = { lon: line.coords[0][0] * RAD, lat: line.coords[0][1] * RAD };
          break;
        }
      }
      if (!this.origin) return;

      const segs = [];
      for (const line of lines) {
        for (let i = 0; i < line.coords.length - 1; i++) {
          const a2 = this._xy(line.coords[i]);
          const b2 = this._xy(line.coords[i + 1]);
          if (a2.x === b2.x && a2.y === b2.y) continue; // zero-length
          segs.push({ a: line.coords[i], b: line.coords[i + 1], a2, b2, layer: line.layer });
        }
      }

      this._buildNodes(segs);
      this._keepLargestComponent();
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

    // Splits segments at crossings / T-junctions. A spatial index keeps this
    // close to linear instead of comparing every segment with every other one.
    _buildNodes(segs) {
      const tol = this.tol;
      const cells = new Map();

      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        s.x0 = Math.floor((Math.min(s.a2.x, s.b2.x) - tol) / SEGMENT_CELL);
        s.x1 = Math.floor((Math.max(s.a2.x, s.b2.x) + tol) / SEGMENT_CELL);
        s.y0 = Math.floor((Math.min(s.a2.y, s.b2.y) - tol) / SEGMENT_CELL);
        s.y1 = Math.floor((Math.max(s.a2.y, s.b2.y) + tol) / SEGMENT_CELL);
        for (let cx = s.x0; cx <= s.x1; cx++) {
          for (let cy = s.y0; cy <= s.y1; cy++) {
            const k = cx + "," + cy;
            let bucket = cells.get(k);
            if (!bucket) { bucket = []; cells.set(k, bucket); }
            bucket.push(i);
          }
        }
      }

      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const candidates = new Set();
        for (let cx = s.x0; cx <= s.x1; cx++) {
          for (let cy = s.y0; cy <= s.y1; cy++) {
            for (const j of cells.get(cx + "," + cy) || []) if (j !== i) candidates.add(j);
          }
        }

        const ts = [0, 1];
        for (const j of candidates) {
          const o = segs[j];
          if (o.layer !== s.layer) continue; // bridges/tunnels: no junction
          const t = segmentIntersectionT(s.a2, s.b2, o.a2, o.b2);
          if (t !== null) ts.push(t);
          for (const end of [o.a2, o.b2]) {
            const proj = projectOnSegment(end, s.a2, s.b2);
            if (proj.dist <= tol && proj.t > 0 && proj.t < 1) ts.push(proj.t);
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
    }

    // Only the largest connected component is routable. Isolated fragments are
    // dropped so a point can never snap onto a piece you cannot route from.
    _keepLargestComponent() {
      const n = this.nodes.length;
      if (!n) return;
      const comp = new Int32Array(n).fill(-1);
      const sizes = [];

      for (let s = 0; s < n; s++) {
        if (comp[s] !== -1) continue;
        const id = sizes.length;
        const stack = [s];
        comp[s] = id;
        let size = 0;
        while (stack.length) {
          const u = stack.pop();
          size++;
          for (const v of this.nodes[u].nb.keys()) {
            if (comp[v] === -1) { comp[v] = id; stack.push(v); }
          }
        }
        sizes.push(size);
      }

      let main = 0;
      sizes.forEach((sz, i) => { if (sz > sizes[main]) main = i; });
      this.droppedComponents = sizes.length - 1;
      if (this.droppedComponents > 0) {
        console.warn(`PathNetwork: ${this.droppedComponents} disconnected pathway fragment(s) ignored. Check the Pathways data for gaps.`);
      }

      this.edges = [];
      this.nodes.forEach((nd, i) => {
        if (comp[i] !== main) return;
        for (const j of nd.nb.keys()) if (i < j) this.edges.push([i, j]);
      });
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

    /**
     * @param from, to  [lng, lat]
     * @param options   { maxStartSnap, maxEndSnap, startLabel, endLabel }
     * @returns { path: [[lat,lng]...], coordinates: [[lng,lat]...],
     *            distance, networkDistance, startSnapDistance, endSnapDistance }
     * distance = pathway distance + the off-network legs at both ends.
     */
    route(from, to, options = {}) {
      if (!this.edges.length) throw new Error("No pathway lines were found.");
      const s = this.snap(from);
      const e = this.snap(to);
      if (!s || !e) throw new Error("Could not snap points to pathway network.");

      const maxStart = options.maxStartSnap ?? this.maxSnap;
      const maxEnd = options.maxEndSnap ?? this.maxSnap;
      if (s.dist > maxStart) {
        throw new Error(`${options.startLabel || "The start point"} is ${Math.round(s.dist)} m from the nearest pathway (limit ${Math.round(maxStart)} m).`);
      }
      if (e.dist > maxEnd) {
        throw new Error(`${options.endLabel || "The destination"} is ${Math.round(e.dist)} m from the nearest pathway (limit ${Math.round(maxEnd)} m).`);
      }

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
        if (extra.has(u)) for (const kv of extra.get(u)) nbrs.push(kv);
        for (const [v, w] of nbrs) {
          const nd = d + w;
          if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
            dist.set(v, nd);
            prev.set(v, u);
            heap.push(nd, v);
          }
        }
      }

      if (!dist.has(E)) throw new Error("No connected route found.");

      const ids = [];
      for (let cur = E; cur !== undefined; cur = prev.get(cur)) ids.push(cur);
      ids.reverse();

      const coordinates = [from, ...ids.map(lonlatOf), to];
      const networkDistance = dist.get(E);
      return {
        coordinates,                                  // [lng, lat]
        path: coordinates.map((c) => [c[1], c[0]]),   // [lat, lng] for Leaflet
        networkDistance,
        startSnapDistance: s.dist,
        endSnapDistance: e.dist,
        distance: networkDistance + s.dist + e.dist
      };
    }
  }

  return { PathNetwork, extractPoints, getConfig, fetchJSON, buildRouteUrl, isShareableHost };
})();


// ==========================================
// 2D MAP CONTROLLER & UI WITH LIVE GPS
// ==========================================

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const mapContainer = $("map");
  if (!mapContainer) return; // not the 2D page (e.g. the 3D page also loads this file)
  if (typeof L === "undefined") {
    console.error("Leaflet (L) is not loaded.");
    return;
  }

  const CFG = PathRouter.getConfig();
  const GPS_START_ID = "USER_GPS_LOCATION"; // dropdown value
  const GPS_URL_TOKEN = "gps";              // used in share URLs: ?s=gps&d=<entrance id>

  const setStatus = (msg, isError) => {
    const statusEl = $("status");
    if (statusEl) {
      statusEl.textContent = msg || "";
      statusEl.className = isError ? "error" : "";
    }
  };

  const map = L.map("map", { zoomControl: true }).setView([-25.7545, 28.2315], 17);

  L.tileLayer(CFG.tileUrl, { maxZoom: 19, attribution: CFG.tileAttribution }).addTo(map);

  const layers = {
    aoi: L.layerGroup().addTo(map),
    buildings: L.layerGroup().addTo(map),
    paths: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
    userLocation: L.layerGroup().addTo(map)
  };

  let network = null;
  let screens = [];
  let entrances = [];

  // GPS state
  let userCoords = null;     // latest [lng, lat]
  let watchId = null;
  let gpsOverlay = false;    // show the "You are here" dot (QR visits)
  let gpsRouting = false;    // GPS is the route start
  let pendingDest = null;    // destination used for live GPS re-routing
  let lastRouted = null;     // [lng, lat] of the last GPS position that was routed
  let lastQrKey = null;

  /* ---------- Helpers ---------- */

  function metersBetween(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Leaflet's bindTooltip(string) treats strings as HTML, so always pass an element.
  function tipEl(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  function findItem(list, param) {
    if (param === null || param === undefined || param === "") return null;
    if (param === GPS_START_ID) {
      if (!userCoords) return null;
      return { id: GPS_START_ID, name: "My Current Location", coordinates: userCoords };
    }
    const q = String(param).trim();
    return (
      list.find((item) => item.id === q) ||
      list.find((item) => item.name.toLowerCase() === q.toLowerCase()) ||
      null
    );
  }

  function fillSelect(sel, list, placeholder, includeGpsOption = false) {
    if (!sel) return;
    sel.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = placeholder;
    sel.appendChild(ph);

    if (includeGpsOption) {
      const gpsOpt = document.createElement("option");
      gpsOpt.value = GPS_START_ID;
      gpsOpt.textContent = "📍 My Current Location";
      sel.appendChild(gpsOpt);
    }

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

  /* ---------- QR (generated once per start/destination pair) ---------- */

  function clearQr() {
    lastQrKey = null;
    const target = $("qrcode");
    if (target) target.replaceChildren();
    const img = $("qrCodeImage");
    if (img) img.removeAttribute("src");
  }

  function updateQr(startToken, destId) {
    const key = startToken + "|" + destId;
    if (key === lastQrKey) return;
    lastQrKey = key;

    const url = PathRouter.buildRouteUrl(startToken, destId);
    const target = $("qrcode");
    if (target && typeof QRCode !== "undefined") {
      target.replaceChildren();
      new QRCode(target, {
        text: url, width: 200, height: 200,
        colorDark: "#000000", colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
      return;
    }
    // Fallback sends the URL to a third party, so it is opt-in (GEONEXUS.ALLOW_EXTERNAL_QR = true).
    const img = $("qrCodeImage");
    if (img && CFG.allowExternalQr) {
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(url)}`;
    }
  }

  /* ---------- GPS ---------- */

  function drawUserMarker(lat, lng, accuracy) {
    layers.userLocation.clearLayers();
    L.circle([lat, lng], {
      radius: accuracy, color: "#3b82f6", fillColor: "#3b82f6",
      fillOpacity: 0.15, weight: 1, interactive: false
    }).addTo(layers.userLocation);

    L.circleMarker([lat, lng], {
      radius: 8, color: "#ffffff", weight: 2, fillColor: "#2563eb", fillOpacity: 1
    }).bindTooltip(tipEl("You Are Here"), { direction: "top", offset: [0, -10] })
      .addTo(layers.userLocation);
  }

  function routeFromGps(force) {
    if (!gpsRouting || !pendingDest) return;
    if (!userCoords) {
      setStatus("Waiting for your GPS position…");
      return;
    }
    const moved = lastRouted ? metersBetween(lastRouted, userCoords) : Infinity;
    if (!force && moved < CFG.routing.gpsMinMove) return;

    const start = { id: GPS_START_ID, name: "My Current Location", coordinates: userCoords };
    showRoute(start, pendingDest, { fit: !lastRouted });
  }

  function onPosition(position) {
    const { latitude: lat, longitude: lng, accuracy } = position.coords;
    userCoords = [lng, lat];
    drawUserMarker(lat, lng, accuracy);
    routeFromGps(false);
  }

  function onGpsError(err) {
    const messages = {
      1: "Location permission was denied. Allow location access in your browser to use your current position.",
      2: "Your position is currently unavailable.",
      3: "Timed out while waiting for a GPS fix."
    };
    let msg = messages[err.code] || "Could not read your location.";
    if (!window.isSecureContext) msg += " Location requires HTTPS (or localhost).";
    setStatus(msg, true);
    if (err.code === 1) {
      gpsRouting = false;
      pendingDest = null;
    }
  }

  // Idempotent: calling it again only updates the flags.
  function startLocationTracking({ overlay = false, routing = false } = {}) {
    if (!("geolocation" in navigator)) {
      setStatus("Geolocation is not supported by this device/browser.", true);
      return false;
    }
    if (!window.isSecureContext) {
      setStatus("Location requires HTTPS (or localhost). Open this page over a secure connection.", true);
      return false;
    }
    if (overlay) gpsOverlay = true;
    if (routing) gpsRouting = true;
    if (watchId !== null) return true;

    watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 10000
    });
    return true;
  }

  function stopLocationTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    layers.userLocation.clearLayers();
    userCoords = null;
    lastRouted = null;
  }

  // Stop the GPS watch only if nothing needs it any more.
  function releaseLocationTracking() {
    if (!gpsOverlay && !gpsRouting) stopLocationTracking();
  }

  /* ---------- Routing display ---------- */

  function showRoute(start, dest, { fit = true } = {}) {
    if (!network) {
      setStatus("Pathway network is not loaded yet.", true);
      return false;
    }

    const isGps = start.id === GPS_START_ID;
    let r;
    try {
      r = network.route(start.coordinates, dest.coordinates, {
        maxStartSnap: isGps ? CFG.routing.maxGpsSnapDistance : undefined,
        startLabel: isGps ? "Your location" : "The start point"
      });
    } catch (err) {
      layers.route.clearLayers();
      setStatus(err.message, true);
      return false;
    }

    layers.route.clearLayers();

    L.polyline(r.path, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(layers.route);
    const line = L.polyline(r.path, { color: CFG.routing.routeColor, weight: 5, opacity: 1 }).addTo(layers.route);

    const dot = (latLng, color, text, customClass) =>
      L.circleMarker(latLng, {
        radius: 8, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1
      }).bindTooltip(tipEl(text), {
        permanent: true, direction: "top", offset: [0, -10], className: customClass
      }).addTo(layers.route);

    dot([start.coordinates[1], start.coordinates[0]], CFG.routing.startColor, `START: ${start.name}`, "label-start");
    dot([dest.coordinates[1], dest.coordinates[0]], CFG.routing.destColor, `END: ${dest.name}`, "label-end");

    if (fit) map.fitBounds(line.getBounds(), { padding: [50, 50] });

    const mins = Math.max(1, Math.round(r.distance / CFG.routing.walkSpeed / 60));
    if ($("cardStart")) $("cardStart").textContent = start.name;
    if ($("cardDest")) $("cardDest").textContent = dest.name;
    if ($("cardEta")) $("cardEta").textContent = `≈ ${mins} min (${Math.round(r.distance)} m)`;

    if ($("selStart")) $("selStart").value = start.id;
    if ($("selDest")) $("selDest").value = dest.id;
    if ($("btnEnd")) $("btnEnd").hidden = false;

    const startToken = isGps ? GPS_URL_TOKEN : start.id;
    setURLParams(startToken, dest.id);
    updateQr(startToken, dest.id);

    if (isGps) lastRouted = start.coordinates;
    setStatus(`Route calculated: ${start.name} → ${dest.name}`);
    return true;
  }

  function resetRouteUi() {
    layers.route.clearLayers();
    clearQr();
    if ($("cardStart")) $("cardStart").textContent = "–";
    if ($("cardDest")) $("cardDest").textContent = "–";
    if ($("cardEta")) $("cardEta").textContent = "–";
    if ($("btnEnd")) $("btnEnd").hidden = true;
    setURLParams(null, null);
  }

  /* ---------- Init ---------- */

  async function init() {
    const startSelect = $("selStart");
    const endSelect = $("selDest");

    try {
      const [sGeo, eGeo, pGeo] = await Promise.all([
        PathRouter.fetchJSON(CFG.screensUrl),
        PathRouter.fetchJSON(CFG.entrancesUrl),
        PathRouter.fetchJSON(CFG.pathwaysUrl)
      ]);

      screens = PathRouter.extractPoints(sGeo, "LCD Display Name");
      entrances = PathRouter.extractPoints(eGeo, "Entrance Name");
      network = new PathRouter.PathNetwork(pGeo, {
        snapTolerance: CFG.routing.snapTolerance,
        maxSnapDistance: CFG.routing.maxSnapDistance
      });

      try {
        const bGeo = await PathRouter.fetchJSON(CFG.buildingsUrl);
        L.geoJSON(bGeo, {
          style: { color: "#475569", weight: 1, fillColor: "#FFE5B4", fillOpacity: 0.4 }
        }).addTo(layers.buildings);
      } catch (e) {
        console.warn("Buildings dataset optional render skipped:", e);
      }

      L.geoJSON(pGeo, {
        style: { color: "#24fb5a", weight: 3, opacity: 0.6 },
        interactive: false
      }).addTo(layers.paths);

      try {
        const aoiGeo = await PathRouter.fetchJSON(CFG.aoiUrl);
        const aoiLayer = L.geoJSON(aoiGeo, {
          style: { color: "#ef4444", weight: 2, fillOpacity: 0.05 },
          interactive: false
        }).addTo(layers.aoi);
        if (aoiLayer.getBounds().isValid()) map.fitBounds(aoiLayer.getBounds());
      } catch (e) {
        const pBounds = L.geoJSON(pGeo).getBounds();
        if (pBounds.isValid()) map.fitBounds(pBounds);
      }

      fillSelect(startSelect, screens, "Select starting display screen", true);
      fillSelect(endSelect, entrances, "Select destination entrance", false);

      if (startSelect) {
        startSelect.addEventListener("change", (e) => {
          if (e.target.value === GPS_START_ID) {
            // GPS is the start: begin tracking now so the permission prompt appears early.
            startLocationTracking({ routing: true });
          } else {
            gpsRouting = false;
            pendingDest = null;
            lastRouted = null;
            releaseLocationTracking(); // keeps the dot if a QR visit asked for it
          }
        });
      }

      if (endSelect) {
        // A new destination needs an explicit "Show route"; stop auto-updating the old one.
        endSelect.addEventListener("change", () => { pendingDest = null; });
      }

      setStatus("");
      setTimeout(() => map.invalidateSize(), 200);
    } catch (err) {
      console.error(err);
      setStatus(`${err.message}. Ensure files are served over HTTP/HTTPS.`, true);
      return;
    }

    // Deep link: ?s=<screen id>&d=<entrance id>   or   ?s=gps&d=<entrance id>
    const params = new URLSearchParams(window.location.search);
    if (params.has("s") && params.has("d")) {
      const sParam = params.get("s");
      const d = findItem(entrances, params.get("d"));
      if (!d) {
        setStatus("The destination entrance in this link was not found.", true);
        return;
      }

      if (sParam === GPS_URL_TOKEN || sParam === GPS_START_ID) {
        if (startSelect) startSelect.value = GPS_START_ID;
        if (endSelect) endSelect.value = d.id;
        pendingDest = d;
        lastRouted = null;
        if (startLocationTracking({ overlay: true, routing: true })) {
          setStatus("Waiting for your GPS position…");
        }
      } else {
        const s = findItem(screens, sParam);
        if (!s) {
          setStatus("The starting display screen in this link was not found.", true);
          return;
        }
        showRoute(s, d, { fit: true });
        startLocationTracking({ overlay: true }); // show the live "You are here" dot
      }
    }
  }

  /* ---------- Form + buttons ---------- */

  const routeForm = $("routeForm");
  if (routeForm) {
    routeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const startSelect = $("selStart");
      const endSelect = $("selDest");
      if (!startSelect || !endSelect) return;

      const d = findItem(entrances, endSelect.value);

      if (startSelect.value === GPS_START_ID) {
        if (!d) {
          setStatus("Please select a destination entrance.", true);
          return;
        }
        pendingDest = d;
        lastRouted = null;
        if (!startLocationTracking({ routing: true })) return;
        if (userCoords) routeFromGps(true);
        else setStatus("Waiting for your GPS position…");
        return;
      }

      const s = findItem(screens, startSelect.value);
      if (!s || !d) {
        setStatus("Please select both a start location and a destination entrance.", true);
        return;
      }
      gpsRouting = false;
      pendingDest = null;
      releaseLocationTracking();
      showRoute(s, d, { fit: true });
    });
  }

  const endRouteBtn = $("btnEnd");
  if (endRouteBtn) {
    endRouteBtn.addEventListener("click", () => {
      gpsRouting = false;
      pendingDest = null;
      lastRouted = null;
      releaseLocationTracking();

      if ($("selStart")) $("selStart").value = "";
      if ($("selDest")) $("selDest").value = "";
      resetRouteUi();
      setStatus("Route cleared.");
    });
  }

  init();
})();
