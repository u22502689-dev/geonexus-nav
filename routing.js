// ==========================================
// GEONEXUS PATH ROUTER
// ==========================================

window.PathRouter = (function () {
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
        coordinates: g.coordinates // Standard GeoJSON [lng, lat]
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

      const rawPath = [from, ...ids.map(lonlatOf), to];
      // Ensure output is Leaflet format: [lat, lng]
      const path = rawPath.map((c) => [c[1], c[0]]);
      
      // Calculate turn-by-turn directions
      const instructions = this._generateInstructions(rawPath);

      return { path, distance: dist.get(E), instructions };
    }

    _bearing(p1, p2) {
      const xy1 = this._xy(p1);
      const xy2 = this._xy(p2);
      const angle = Math.atan2(xy2.x - xy1.x, xy2.y - xy1.y) * (180 / Math.PI);
      return (angle + 360) % 360;
    }

    _generateInstructions(points) {
      const pts = [];
      for (const p of points) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(this._xy(p).x - this._xy(last).x, this._xy(p).y - this._xy(last).y) > 0.5) pts.push(p);
      }
      points = pts;
      if (points.length < 2) return [];

      const steps = [];
      steps.push({
        type: "start",
        text: "Head towards the pathway",
        distance: Math.hypot(
          this._xy(points[1]).x - this._xy(points[0]).x,
          this._xy(points[1]).y - this._xy(points[0]).y
        )
      });

      for (let i = 1; i < points.length - 1; i++) {
        const b1 = this._bearing(points[i - 1], points[i]);
        const b2 = this._bearing(points[i], points[i + 1]);

        let turnAngle = (b2 - b1 + 360) % 360;
        if (turnAngle > 180) turnAngle -= 360;

        const segDist = Math.hypot(
          this._xy(points[i + 1]).x - this._xy(points[i]).x,
          this._xy(points[i + 1]).y - this._xy(points[i]).y
        );

        let turnType = "continue";
        let turnText = "Continue straight";

        if (turnAngle > 45 && turnAngle <= 135) {
          turnType = "turn-right";
          turnText = "Turn right";
        } else if (turnAngle >= 135 || turnAngle <= -135) {
          turnType = "u-turn";
          turnText = "Make a U-turn";
        } else if (turnAngle < -45 && turnAngle >= -135) {
          turnType = "turn-left";
          turnText = "Turn left";
        } else if (turnAngle > 15 && turnAngle <= 45) {
          turnType = "slight-right";
          turnText = "Slight right";
        } else if (turnAngle < -15 && turnAngle >= -45) {
          turnType = "slight-left";
          turnText = "Slight left";
        }

        if (turnType !== "continue" || i === points.length - 2) {
          steps.push({
            type: turnType,
            text: turnText,
            distance: segDist
          });
        } else {
          steps[steps.length - 1].distance += segDist;
        }
      }

      steps.push({
        type: "destination",
        text: "Arrive at your destination",
        distance: 0
      });

      return steps;
    }
  }

  return { PathNetwork, extractPoints };
})();


// GeoNexus 2D route page controller (screens -> entrances, live GPS, turn-by-turn). Needs Leaflet, config.js, routing.js first.
(function () {
  "use strict";

  const CFG = window.GEONEXUS || {};
  const DATA_CFG = CFG.DATA || {};
  const ROUTING_CFG = CFG.ROUTING || {};
  const GPS_START_ID = "USER_GPS_LOCATION";
  const $ = (id) => document.getElementById(id);

  const setStatus = (msg, isError) => {
    const statusEl = $("status");
    if (statusEl) {
      statusEl.textContent = msg || "";
      statusEl.className = isError ? "error" : "";
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

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

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

  // Mobile Geolocation State
  let userCoords = null; // Stores latest [lng, lat]
  let watchId = null;
  let gpsRouted = false; // only re-fit the map on the first GPS route

  function findItem(list, param) {
    if (param === null || param === undefined || param === "") return null;
    if (param === GPS_START_ID) {
      if (!userCoords) return null;
      return {
        id: GPS_START_ID,
        name: "My Current Location",
        coordinates: userCoords
      };
    }
    const q = String(param).trim();
    return (
      list.find((item) => String(item.id) === q) ||
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

  function startLocationTracking(autoRouteTargetDest = null) {
    if (!("geolocation" in navigator)) {
      setStatus("Geolocation is not supported by your browser.", true);
      return;
    }

    if (watchId !== null) return; // Already watching

    setStatus("Acquiring GPS position...");

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        userCoords = [lng, lat];
        layers.userLocation.clearLayers();

        // Accuracy radius blue circle
        L.circle([lat, lng], {
          radius: accuracy,
          color: "#3b82f6",
          fillColor: "#3b82f6",
          fillOpacity: 0.15,
          weight: 1,
          interactive: false
        }).addTo(layers.userLocation);

        // Marker for user position
        L.circleMarker([lat, lng], {
          radius: 8,
          color: "#ffffff",
          weight: 2,
          fillColor: "#2563eb",
          fillOpacity: 1
        }).bindTooltip("Your Location", { direction: "top", offset: [0, -10] })
          .addTo(layers.userLocation);

        // Dynamic re-route if navigating from Current Location
        const startSelect = $("selStart");
        const endSelect = $("selDest");

        if (startSelect && startSelect.value === GPS_START_ID) {
          const dest = autoRouteTargetDest || (endSelect ? findItem(entrances, endSelect.value) : null);
          if (dest) {
            const userStart = {
              id: GPS_START_ID,
              name: "My Current Location",
              coordinates: userCoords
            };
            showRoute(userStart, dest, { fit: !gpsRouted });
            gpsRouted = true;
          }
        }
      },
      (err) => {
        const msgs = {
          1: "Location permission denied.",
          2: "GPS position unavailable.",
          3: "GPS request timed out."
        };
        setStatus(msgs[err.code] || "Location tracking error.", true);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 10000
      }
    );
  }

  function stopLocationTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    layers.userLocation.clearLayers();
    userCoords = null;
    gpsRouted = false;
  }

  const STEP_ICONS = { start: "🛫", "turn-left": "↰", "slight-left": "↖", "turn-right": "↱", "slight-right": "↗", "u-turn": "↶", destination: "📍" };

  function renderDirections(steps) {
    const list = $("directionsList"), box = $("directionsContainer");
    if (!list) return;
    list.replaceChildren();
    if (!steps || !steps.length) { if (box) box.hidden = true; return; }
    steps.forEach((step) => {
      const li = document.createElement("li");
      li.className = "step-item " + step.type;
      const icon = document.createElement("span");
      icon.className = "step-icon";
      icon.textContent = STEP_ICONS[step.type] || "↑";
      const details = document.createElement("div");
      details.className = "step-details";
      const text = document.createElement("strong");
      text.textContent = step.text;
      details.appendChild(text);
      if (step.distance > 0) {
        const d = document.createElement("small");
        d.textContent = Math.round(step.distance) + " m";
        details.appendChild(d);
      }
      li.appendChild(icon);
      li.appendChild(details);
      list.appendChild(li);
    });
    if (box) box.hidden = false;
  }

  function showRoute(start, dest, opts) {
    layers.route.clearLayers();

    let r;
    try {
      r = network.route(start.coordinates, dest.coordinates);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }

    const routeColor = ROUTING_CFG.ROUTE_COLOR || "#ec4899";
    const startColor = ROUTING_CFG.START_COLOR || "#22c55e";
    const destColor = ROUTING_CFG.DESTINATION_COLOR || "#ef4444";

    L.polyline(r.path, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(layers.route);
    const line = L.polyline(r.path, { color: routeColor, weight: 5, opacity: 1 }).addTo(layers.route);

    const dot = (latLng, color, text, customClass) =>
      L.circleMarker(latLng, {
        radius: 8, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1
      }).bindTooltip(text, { permanent: true, direction: "top", offset: [0, -10], className: customClass }).addTo(layers.route);

    const startLatLng = [start.coordinates[1], start.coordinates[0]];
    const destLatLng = [dest.coordinates[1], dest.coordinates[0]];

    dot(startLatLng, startColor, `START: ${start.name}`, "label-start");
    dot(destLatLng, destColor, `END: ${dest.name}`, "label-end");

    if (!opts || opts.fit !== false) map.fitBounds(line.getBounds(), { padding: [50, 50] });

    const walkSpeed = ROUTING_CFG.WALK_SPEED_MS || 1.4;
    const mins = Math.max(1, Math.round(r.distance / walkSpeed / 60));

    if ($("cardStart")) $("cardStart").textContent = start.name;
    if ($("cardDest")) $("cardDest").textContent = dest.name;
    if ($("cardEta")) $("cardEta").textContent = `≈ ${mins} min (${Math.round(r.distance)} m)`;

    const startSelect = $("selStart");
    const endSelect = $("selDest");
    if (startSelect) startSelect.value = start.id;
    if (endSelect) endSelect.value = dest.id;

    if ($("btnEnd")) $("btnEnd").hidden = false;

    if (start.id !== GPS_START_ID) {
      setURLParams(start.id, dest.id);
    }
    setStatus(`Route calculated: ${start.name} → ${dest.name}`);
    renderDirections(r.instructions);
  }

  async function init() {
    try {
      const screensUrl = CFG.SCREENS_URL || "Dashboard_loc.geojson";
      const entrancesUrl = CFG.ENTRANCES_URL || "building_entrances.geojson";
      const pathwaysUrl = DATA_CFG.PATHWAYS || "Pathways.geojson";
      const buildingsUrl = DATA_CFG.BUILDINGS || "Buildings.geojson";
      const aoiUrl = DATA_CFG.AOI || "campus_aoi.geojson";

      const [sGeo, eGeo, pGeo] = await Promise.all([
        fetchJSON(screensUrl),
        fetchJSON(entrancesUrl),
        fetchJSON(pathwaysUrl)
      ]);

      screens = PathRouter.extractPoints(sGeo, "LCD Display Name");
      entrances = PathRouter.extractPoints(eGeo, "Entrance Name");
      network = new PathRouter.PathNetwork(pGeo);
      console.log("2D route:", screens.length, "screens,", entrances.length, "entrances,", network.nodes.length, "path nodes,", network.edges.length, "path edges");
      if (!network.edges.length) throw new Error("No LineString pathways found in " + pathwaysUrl);
      if (!screens.length) throw new Error("No Point features found in " + screensUrl + " (MultiPoint is not supported)");
      if (!entrances.length) throw new Error("No Point features found in " + entrancesUrl + " (MultiPoint is not supported)");

      try {
        const bGeo = await fetchJSON(buildingsUrl);
        L.geoJSON(bGeo, {
          style: {
            color: "#475569",
            weight: 1,
            fillColor: "#FFE5B4",
            fillOpacity: 0.4
          }
        }).addTo(layers.buildings);
      } catch (e) {
        console.warn("Buildings dataset optional render skipped:", e);
      }

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

      const startSelect = $("selStart");
      const endSelect = $("selDest");

      fillSelect(startSelect, screens, "Select starting display screen", true);
      fillSelect(endSelect, entrances, "Select destination entrance", false);

      // Listener for start select dropdown change
      if (startSelect) {
        startSelect.addEventListener("change", (e) => {
          if (e.target.value === GPS_START_ID) {
            startLocationTracking();
          } else if (watchId !== null) {
            stopLocationTracking();
          }
        });
      }

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

  const showRouteForm = $("routeForm");
  if (showRouteForm) {
    showRouteForm.addEventListener("submit", (e) => {
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
        if (!userCoords) {
          startLocationTracking(d);
        } else {
          const s = {
            id: GPS_START_ID,
            name: "My Current Location",
            coordinates: userCoords
          };
          showRoute(s, d);
        }
        return;
      }

      const s = findItem(screens, startSelect.value);
      if (!s || !d) {
        setStatus("Please select both a start location and a destination entrance.", true);
        return;
      }
      showRoute(s, d);
    });
  }

  const endRouteBtn = $("btnEnd");
  if (endRouteBtn) {
    endRouteBtn.addEventListener("click", () => {
      layers.route.clearLayers();
      stopLocationTracking();

      const startSelect = $("selStart");
      const endSelect = $("selDest");
      if (startSelect) startSelect.value = "";
      if (endSelect) endSelect.value = "";

      if ($("cardStart")) $("cardStart").textContent = "–";
      if ($("cardDest")) $("cardDest").textContent = "–";
      if ($("cardEta")) $("cardEta").textContent = "–";

      endRouteBtn.hidden = true;
      setURLParams(null, null);
      renderDirections(null);
      setStatus("Route cleared.");
    });
  }

  init();
})();