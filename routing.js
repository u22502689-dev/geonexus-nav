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

  // Same property names the 3D app shows for pathways.
  function roadName(props) {
    const v = props && (props["Road Name"] || props.name || props.Name);
    return v === undefined || v === null ? "" : String(v).trim();
  }

  function extractLines(geojson) {
    const lines = [];
    ((geojson && geojson.features) || []).forEach((f) => {
      const g = f.geometry;
      if (!g) return;
      const name = roadName(f.properties);
      if (g.type === "LineString") lines.push({ coords: g.coordinates, name });
      else if (g.type === "MultiLineString") g.coordinates.forEach((l) => lines.push({ coords: l, name }));
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
      this._names = new Map(); // "i-j" -> road name

      const lines = extractLines(geojson);
      for (const line of lines) {
        if (line.coords.length && !this.origin) {
          this.origin = { lon: line.coords[0][0] * RAD, lat: line.coords[0][1] * RAD };
        }
      }
      if (!this.origin) return;

      const segs = [];
      for (const line of lines) {
        const c = line.coords;
        for (let i = 0; i < c.length - 1; i++) {
          segs.push({
            a: c[i], b: c[i + 1], name: line.name,
            a2: this._xy(c[i]), b2: this._xy(c[i + 1])
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
          if (prev >= 0) this._connect(prev, idx, s.name);
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

    _edgeName(a, b) {
      return this._names.get(Math.min(a, b) + "-" + Math.max(a, b)) || "";
    }

    _connect(a, b, name) {
      if (a === b) return;
      const A = this.nodes[a].xy, B = this.nodes[b].xy;
      const d = Math.hypot(A.x - B.x, A.y - B.y);
      if (!Number.isFinite(d) || d <= 0) return;
      this.nodes[a].nb.set(b, d);
      this.nodes[b].nb.set(a, d);
      const key = Math.min(a, b) + "-" + Math.max(a, b);
      if (name && !this._names.get(key)) this._names.set(key, name);
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

      // Road name of the walkway between two consecutive route nodes.
      const sn = this._edgeName(s.a, s.b);
      const en = this._edgeName(e.a, e.b);
      const nameBetween = (u, v) => {
        if (u === S || v === S) return u === E || v === E ? sn || en : sn;
        if (u === E || v === E) return en;
        return this._edgeName(u, v);
      };
      const track = ids.map((id, k) => ({
        ll: lonlatOf(id),
        name: k < ids.length - 1 ? nameBetween(id, ids[k + 1]) : "",
        junction: id >= 0 && this.nodes[id].nb.size >= 3
      }));

      return { path, track, distance: dist.get(E) };
    }
  }

  /* ---------- turn-by-turn directions ---------- */

  const norm180 = (a) => {
    a = ((a % 360) + 360) % 360;
    return a > 180 ? a - 360 : a;
  };
  const bearingDeg = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) / RAD + 360) % 360;
  const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const compass = (b) => COMPASS[Math.round(b / 45) % 8];

  /**
   * Turns a route track ([{ ll: [lng, lat], name }], from the snap point to the
   * snap point) into step-by-step instructions. A turn is detected by comparing the
   * walking direction ~10 m before and ~10 m after each vertex, so wiggles in the
   * digitised line are ignored and a rounded corner counts as one turn.
   * landmarks (optional): [{ name, rings }] building polygons in lon/lat. Used to say
   * "near <building>" when a path has no name.
   * Returns [{ kind, icon, text, sub, dist, ll }]; dist = metres to the next step.
   */
  function buildDirections(track, startName, destName, landmarks) {
    const W = 10;          // metres used to read the starting heading
    const MIN_TURN_FREE = 60;      // degrees; a bend on a continuous path must be this sharp to count as a turn
    const MIN_TURN_JUNCTION = 40;  // degrees; at a junction, a smaller change of direction still counts
    const JUNCTION_NEAR = 10;      // metres; how close to a junction a bend must be to use the lower limit
    const MAX_RADIUS = 35;         // metres; away from junctions, a wide sweeping curve is not a turn
    const LANDMARK_MAX = 30;       // metres; nearest building must be this close to be named
    const SUPPRESS = 12;   // metres; a "continue onto" step is skipped this close to a turn
    const SIMPLIFY = 2.5;  // metres; digitising wiggles smaller than this are ignored
    const CLUSTER = 35;    // metres; bends in the same direction this close together count as one corner

    if (!track || !track.length) return [];
    const lon0 = track[0].ll[0], lat0 = track[0].ll[1];
    const kx = RAD * Math.cos(lat0 * RAD) * EARTH, ky = RAD * EARTH;
    const toXY = (ll) => ({ x: (ll[0] - lon0) * kx, y: (ll[1] - lat0) * ky });

    // building outlines in the same local metres, for "near <building>"
    const lm = (landmarks || []).map((l) => ({ name: l.name, ring: ((l.rings && l.rings[0]) || []).map(toXY) }));
    const nearestLandmark = (p) => {
      let best = null, bd = LANDMARK_MAX;
      for (const l of lm) {
        const r = l.ring;
        if (r.length < 3) continue;
        let inside = false, d = Infinity;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          if ((r[i].y > p.y) !== (r[j].y > p.y) &&
              p.x < ((r[j].x - r[i].x) * (p.y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) inside = !inside;
          const dx = r[j].x - r[i].x, dy = r[j].y - r[i].y, l2 = dx * dx + dy * dy;
          let t = l2 ? ((p.x - r[i].x) * dx + (p.y - r[i].y) * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          d = Math.min(d, Math.hypot(p.x - (r[i].x + t * dx), p.y - (r[i].y + t * dy)));
        }
        if (inside) d = 0;
        if (d < bd) { bd = d; best = l.name; }
      }
      return best;
    };

    // drop repeated points (a leg of zero length); the next leg's name moves back onto the kept point
    const pts = [];
    track.forEach((t) => {
      const xy = toXY(t.ll);
      const last = pts[pts.length - 1];
      if (last && Math.hypot(xy.x - last.xy.x, xy.y - last.xy.y) < 0.05) {
        last.name = t.name || "";
        if (t.junction) last.junction = true;
        return;
      }
      pts.push({ ll: t.ll, xy, name: t.name || "", junction: !!t.junction });
    });

    const arriveText = "Arrive at " + (destName || "your destination");
    const n = pts.length;
    if (n < 2) return [{ kind: "arrive", icon: "arrive", text: arriveText, sub: "", dist: 0, ll: pts[0].ll }];

    const s = [0];
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i].xy.x - pts[i - 1].xy.x, pts[i].xy.y - pts[i - 1].xy.y);
    const total = s[n - 1];

    const pointAt = (sv) => {
      sv = Math.max(0, Math.min(total, sv));
      let i = 1;
      while (i < n - 1 && s[i] < sv) i++;
      const seg = s[i] - s[i - 1] || 1;
      const t = (sv - s[i - 1]) / seg;
      return {
        x: pts[i - 1].xy.x + (pts[i].xy.x - pts[i - 1].xy.x) * t,
        y: pts[i - 1].xy.y + (pts[i].xy.y - pts[i - 1].xy.y) * t
      };
    };

    // 1) turns: simplify the line (so wiggles vanish and a rounded corner has few vertices),
    //    then add up the bends that sit within CLUSTER metres of each other.
    const norm = (x) => (x || "").trim().toLowerCase();
    const force = [];
    for (let i = 1; i < n - 1; i++) if (norm(pts[i - 1].name) !== norm(pts[i].name) || pts[i].junction) force.push(i);

    const keep = new Set([0, n - 1, ...force]);
    const distToSeg = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    const dp = (a, b) => {
      let worst = -1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = distToSeg(pts[i].xy, pts[a].xy, pts[b].xy);
        if (d > worst) { worst = d; wi = i; }
      }
      if (wi >= 0 && worst > SIMPLIFY) { keep.add(wi); dp(a, wi); dp(wi, b); }
    };
    const anchors = [...keep].sort((a, b) => a - b);
    for (let k = 0; k < anchors.length - 1; k++) dp(anchors[k], anchors[k + 1]);
    const kept = [...keep].sort((a, b) => a - b);

    const bends = [];
    for (let k = 1; k < kept.length - 1; k++) {
      const a = pts[kept[k - 1]].xy, v = pts[kept[k]].xy, b = pts[kept[k + 1]].xy;
      if (Math.hypot(v.x - a.x, v.y - a.y) < 0.5 || Math.hypot(b.x - v.x, b.y - v.y) < 0.5) continue;
      const delta = norm180(bearingDeg(v, b) - bearingDeg(a, v)); // + = right (clockwise)
      if (Math.abs(delta) >= 1) bends.push({ i: kept[k], s: s[kept[k]], delta });
    }
    const clusters = [];
    for (const b of bends) {
      const last = clusters[clusters.length - 1];
      const prevBend = last && last.items[last.items.length - 1];
      if (prevBend && b.s - prevBend.s <= CLUSTER && Math.sign(b.delta) === Math.sign(prevBend.delta)) last.items.push(b);
      else clusters.push({ items: [b] });
    }
    const maneuvers = [];
    for (const c of clusters) {
      const total = c.items.reduce((sum, b) => sum + b.delta, 0);
      const apex = c.items.reduce((m, b) => (Math.abs(b.delta) > Math.abs(m.delta) ? b : m));
      const atJunction = pts.some((q, i) => q.junction && Math.abs(s[i] - apex.s) <= JUNCTION_NEAR);
      if (Math.abs(total) < (atJunction ? MIN_TURN_JUNCTION : MIN_TURN_FREE)) continue;
      // radius of the bend ~ length of path it takes / angle turned (radians)
      const span = c.items[c.items.length - 1].s - c.items[0].s;
      if (!atJunction && span / (Math.abs(total) * RAD) > MAX_RADIUS) continue;
      maneuvers.push({
        kind: "turn", i: apex.i, s: apex.s, delta: total,
        firstIdx: c.items[0].i, nameIdx: c.items[c.items.length - 1].i
      });
    }

    // 2) straight on, but onto a differently named road
    for (let i = 1; i < n - 1; i++) {
      const before = norm(pts[i - 1].name), after = norm(pts[i].name);
      if (after && before !== after && !maneuvers.some((m) => Math.abs(m.s - s[i]) < SUPPRESS)) {
        maneuvers.push({ kind: "continue", i, s: s[i], delta: 0 });
      }
    }
    maneuvers.sort((a, b) => a.s - b.s);

    // 3) wording
    const steps = [];
    const heading = bearingDeg(pts[0].xy, pointAt(W));
    steps.push({
      kind: "start", icon: "start", s: 0, ll: pts[0].ll,
      text: "Head " + compass(heading) + (pts[0].name ? " on " + pts[0].name : ""),
      sub: startName ? "From " + startName : ""
    });

    for (const m of maneuvers) {
      const name = pts[m.nameIdx !== undefined ? m.nameIdx : m.i].name;
      const prevName = m.firstIdx !== undefined ? pts[Math.max(0, m.firstIdx - 1)].name : "";
      const onto = name && norm(name) !== norm(prevName) ? " onto " + name : "";
      const landmark = nearestLandmark(pts[m.i].xy);
      const where = !name && landmark ? " near " + landmark : "";
      let text, icon;
      if (m.kind === "continue") {
        text = "Continue" + onto; icon = "straight";
      } else {
        const a = Math.abs(m.delta), side = m.delta > 0 ? "right" : "left";
        if (a >= 165) { text = "Make a U-turn" + where; icon = "uturn"; }
        else if (a >= 125) { text = "Turn sharp " + side + onto + where; icon = "sharp-" + side; }
        else if (a >= 55) { text = "Turn " + side + onto + where; icon = side; }
        else { text = "Turn slightly " + side + onto + where; icon = "slight-" + side; }
      }
      steps.push({ kind: m.kind, icon, text, sub: name && landmark ? "Near " + landmark : "", s: m.s, ll: pts[m.i].ll });
    }

    steps.push({ kind: "arrive", icon: "arrive", text: arriveText, sub: "", s: total, ll: pts[n - 1].ll });

    for (let k = 0; k < steps.length; k++) {
      steps[k].dist = k < steps.length - 1 ? steps[k + 1].s - steps[k].s : 0;
      delete steps[k].s;
    }
    return steps;
  }

  const api = { PathNetwork, buildDirections };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.PathRouter = api;
})(typeof window !== "undefined" ? window : globalThis);
