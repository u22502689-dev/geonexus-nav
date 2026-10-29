/*
 * GeoNexus - 2D port of the pathway routing used in the Cesium app (app.js).
 *
 * Same method, so the 2D route matches the 3D route:
 *   - every pathway segment is split where it crosses another segment
 *   - T-junctions / near misses within 1.5 m are treated as connected
 *   - nodes closer than 1.5 m are merged
 *   - a building centre is snapped to the nearest pathway EDGE (not node)
 *   - shortest path by distance (Dijkstra; A* in the 3D app gives the same length)
 *
 * Input is GeoJSON in EPSG:4326 (lon/lat). Output paths are [lat, lng] for Leaflet.
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
    if (Math.abs(denom) < 1e-9) return null; // parallel
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
    constructor(geojson, options) {
      this.tol = (options && options.snapTolerance) || SNAP_TOLERANCE;
      this.nodes = [];   // { lonlat, xy, nb: Map(index -> metres) }
      this.edges = [];   // [i, j] with i < j
      this.origin = null;
      this._grid = new Map();

      const lines = extractLines(geojson);
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

    // Nearest point on any edge to a [lng, lat] position.
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
     * Shortest walkable route between two [lng, lat] points (e.g. building centres).
     * Returns { path: [[lat, lng], ...], distance } where distance is metres along
     * the pathways only (same figure the 3D app shows).
     */
    route(from, to) {
      if (!this.edges.length) throw new Error("No pathway lines were found. Check Pathways.geojson.");
      const s = this.snap(from);
      const e = this.snap(to);
      if (!s || !e) throw new Error("Could not snap the buildings to the pathway network.");

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
        throw new Error("No connected route found. Check that the pathway features connect to one another.");
      }

      const ids = [];
      for (let cur = E; cur !== undefined; cur = prev.get(cur)) ids.push(cur);
      ids.reverse();

      // building centre -> snap point -> pathway nodes -> snap point -> building centre
      const path = [from, ...ids.map(lonlatOf), to].map((c) => [c[1], c[0]]);
      return { path, distance: dist.get(E) };
    }
  }

  const api = { PathNetwork };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.PathRouter = api;
})(typeof window !== "undefined" ? window : globalThis);
