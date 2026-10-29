//GEONEXUS CAMPUS 3D AND NAVIGATION

// Paste your Cesium ion token here (rotate the old one, it was exposed).
Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjF4NEQ2RXVIdnhEU3ZVQ0wiLCJqdGkiOiIzNjViYjNhMS04ODJlLTRkYWItYmVkMC0xN2I1NTdjZjgxYjIiLCJpZCI6NTEyMTU0LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTA3NzY3MDl9.NcMiDOBCqxHQfxRQC35kOslp0cXZeyWPPo9m-MklGpY";

const IMAGERY_ASSET_ID = null;

const HEIGHT_FIELDS = [
  "height", "Height", "HEIGHT", "building_height", "z", "Z"
];

const LEVEL_FIELDS = [
  "building:levels", "levels", "Levels", "floors", "Floors"
];

const NAME_FIELDS = [
  "Name", "name", "NAME", "building_name", "building:name", "title"
];

const METERS_PER_LEVEL = 3.5;
const DEFAULT_HEIGHT = 10;

const terrainProvider = await Cesium.createWorldTerrainAsync();

const viewer = new Cesium.Viewer("cesiumContainer", {
  terrainProvider,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false
});

viewer.scene.globe.depthTestAgainstTerrain = true;

/* ---------- Optional imagery ---------- */

if (IMAGERY_ASSET_ID) {
  viewer.imageryLayers.removeAll();

  viewer.imageryLayers.addImageryProvider(
    await Cesium.IonImageryProvider.fromAssetId(IMAGERY_ASSET_ID)
  );
}

/* ---------- Building properties ---------- */

function propertyValue(entity, field, time) {
  const property = entity.properties?.[field];

  if (!property) return undefined;

  try {
    return property.getValue(time);
  } catch {
    return undefined;
  }
}

function buildingHeight(entity, time) {
  for (const field of HEIGHT_FIELDS) {
    const value = parseFloat(propertyValue(entity, field, time));

    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  for (const field of LEVEL_FIELDS) {
    const value = parseFloat(propertyValue(entity, field, time));

    if (Number.isFinite(value) && value > 0) {
      return value * METERS_PER_LEVEL;
    }
  }

  return DEFAULT_HEIGHT;
}

function getBuildingName(entity, time) {
  for (const field of NAME_FIELDS) {
    const value = propertyValue(entity, field, time);

    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }

  return null;
}

/* ---------- Load buildings ---------- */

async function loadBuildings() {
  const dataSource = await Cesium.GeoJsonDataSource.load(
    "Buildings.geojson"
  );

  const time = Cesium.JulianDate.now();

  const entities = dataSource.entities.values.filter(
    entity => entity.polygon
  );

  console.log(`Building polygons loaded: ${entities.length}`);

  for (const entity of entities) {
    const hierarchy = entity.polygon.hierarchy.getValue(time);

    if (!hierarchy?.positions?.length) continue;

    const cartographics = hierarchy.positions.map(position =>
      Cesium.Cartographic.fromCartesian(position)
    );

    try {
      await Cesium.sampleTerrainMostDetailed(
        terrainProvider,
        cartographics
      );
    } catch (error) {
      console.warn("Terrain sampling failed:", error);
    }

    const baseHeight = Math.min(
      ...cartographics.map(point => point.height ?? 0)
    );

    entity.polygon.height = baseHeight - 1;
    entity.polygon.extrudedHeight =
      baseHeight + buildingHeight(entity, time);

    entity.polygon.heightReference = Cesium.HeightReference.NONE;
    entity.polygon.extrudedHeightReference = Cesium.HeightReference.NONE;

    entity.polygon.material =
      Cesium.Color.fromCssColorString("#FFE5B4");

    entity.polygon.outline = true;
    entity.polygon.outlineColor =
      Cesium.Color.fromCssColorString("#475569");
  }

  await viewer.dataSources.add(dataSource);

  return dataSource;
}

/* ---------- Load pathways ---------- */

async function loadPaths() {
  const dataSource = await Cesium.GeoJsonDataSource.load(
    "Pathways.geojson",
    { clampToGround: true }
  );

  for (const entity of dataSource.entities.values) {
    if (!entity.polyline) continue;

    entity.polyline.material =
      new Cesium.PolylineOutlineMaterialProperty({
        color: Cesium.Color.fromCssColorString("#24fb5a"),
        outlineColor: Cesium.Color.fromCssColorString("#78350f"),
        outlineWidth: 2
      });

    entity.polyline.width = 6;
    entity.polyline.clampToGround = true;
  }

  await viewer.dataSources.add(dataSource);

  return dataSource;
}

/* ---------- Load campus boundary ---------- */

async function loadAoi() {
  const red = Cesium.Color.fromCssColorString("#ef4444");

  const dataSource = await Cesium.GeoJsonDataSource.load(
    "campus_aoi.geojson",
    {
      fill: red.withAlpha(0.1),
      clampToGround: true
    }
  );

  const time = Cesium.JulianDate.now();

  for (const entity of [...dataSource.entities.values]) {
    if (!entity.polygon) continue;

    const hierarchy = entity.polygon.hierarchy.getValue(time);
    if (!hierarchy?.positions?.length) continue;

    const positions = hierarchy.positions;

    dataSource.entities.add({
      polyline: {
        positions: [...positions, positions[0]],
        width: 4,
        material: red,
        clampToGround: true
      }
    });
  }

  await viewer.dataSources.add(dataSource);

  return dataSource;
}

/* ---------- Initialise layers ---------- */

const [buildings, paths, aoi] = await Promise.all([
  loadBuildings(),
  loadPaths(),
  loadAoi()
]);

const home = () => viewer.flyTo(aoi, {
  duration: 2,
  offset: new Cesium.HeadingPitchRange(
    0,
    Cesium.Math.toRadians(-35),
    0
  )
});

document.getElementById("btnHome").onclick = home;

document.getElementById("tglBuildings").onchange = event => {
  buildings.show = event.target.checked;
};

document.getElementById("tglPaths").onchange = event => {
  paths.show = event.target.checked;
};

document.getElementById("tglAoi").onchange = event => {
  aoi.show = event.target.checked;
};

home();

/* ---------- Hover tooltip ---------- */

const tooltip = document.getElementById("tooltip");

const hoverHandler = new Cesium.ScreenSpaceEventHandler(
  viewer.scene.canvas
);

hoverHandler.setInputAction(movement => {
  const picked = viewer.scene.pick(movement.endPosition);

  if (Cesium.defined(picked)) {
    if (picked.id?.polygon) {
      const name = getBuildingName(
        picked.id,
        Cesium.JulianDate.now()
      );

      if (name) {
        tooltip.style.display = "block";
        tooltip.style.left = `${movement.endPosition.x + 15}px`;
        tooltip.style.top = `${movement.endPosition.y + 15}px`;
        tooltip.textContent = name;
        return;
      }
    } else if (picked.id?.polyline) {
      const time = Cesium.JulianDate.now();
      const roadName = propertyValue(picked.id, "Road Name", time) || propertyValue(picked.id, "name", time);
      const roadType = propertyValue(picked.id, "Road Type", time) || "";

      if (roadName) {
        tooltip.style.display = "block";
        tooltip.style.left = `${movement.endPosition.x + 15}px`;
        tooltip.style.top = `${movement.endPosition.y + 15}px`;
        tooltip.textContent = `${roadName} (${roadType})`;
        return;
      }
    }
  }

  tooltip.style.display = "none";
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

/* ---------- Selected entity information ---------- */

viewer.selectedEntityChanged.addEventListener(entity => {
  const info = document.getElementById("info");

  if (!entity) {
    info.textContent = "Click a building or pathway to see attributes.";
    return;
  }

  const time = Cesium.JulianDate.now();

  if (entity.polygon) {
    const name = getBuildingName(entity, time);
    if (!name) {
      info.textContent = "No building name available.";
      return;
    }

    info.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = `Building: ${name}`;
    info.appendChild(heading);
    return;
  }

  if (entity.polyline) {
    const roadName = propertyValue(entity, "Road Name", time) || propertyValue(entity, "name", time) || "Unnamed Pathway";
    const roadType = propertyValue(entity, "Road Type", time) || "N/A";
    const campus = propertyValue(entity, "Campus", time) || "N/A";
    const surface = propertyValue(entity, "Surface", time) || "N/A";

    info.replaceChildren();

    const heading = document.createElement("strong");
    heading.textContent = `Road Name: ${roadName}`;
    info.appendChild(heading);

    const details = document.createElement("ul");
    details.style.margin = "4px 0 0 16px";
    details.style.padding = "0";

    for (const [label, val] of [
      ["Road Type", roadType],
      ["Campus", campus],
      ["Surface", surface]
    ]) {
      const li = document.createElement("li");
      li.textContent = `${label}: ${val}`;
      details.appendChild(li);
    }

    info.appendChild(details);
  }
});

/* ==========================================================
   NAVIGATION & PATHWAY ROUTING
   ========================================================== */

const startSelect = document.getElementById("startBuilding");
const endSelect = document.getElementById("endBuilding");
const routeStatus = document.getElementById("routeStatus");

const navigation = {
  buildings: [],
  graph: new Map(),
  nodes: [],
  routeEntity: null,
  startMarker: null,
  endMarker: null,
  pickMode: null
};

const START_COLOR = Cesium.Color.fromCssColorString("#22c55e");
const END_COLOR = Cesium.Color.fromCssColorString("#ef4444");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#ec4899"); // High-visibility neon pink

function buildingCenter(entity) {
  const time = Cesium.JulianDate.now();
  const hierarchy = entity.polygon?.hierarchy.getValue(time);

  if (!hierarchy?.positions?.length) return null;

  let x = 0;
  let y = 0;
  let minHeight = Infinity;

  for (const position of hierarchy.positions) {
    const cartographic = Cesium.Cartographic.fromCartesian(position);

    x += cartographic.longitude;
    y += cartographic.latitude;
    if (cartographic.height < minHeight) {
      minHeight = cartographic.height;
    }
  }

  const count = hierarchy.positions.length;

  return Cesium.Cartesian3.fromRadians(
    x / count,
    y / count,
    Number.isFinite(minHeight) ? minHeight : 0
  );
}

function populateBuildingDropdowns() {
  const time = Cesium.JulianDate.now();

  navigation.buildings = buildings.entities.values
    .filter(entity => entity.polygon)
    .map((entity, index) => {
      const center = buildingCenter(entity);

      return {
        entity,
        id: `building-${index}`,
        name: getBuildingName(entity, time) || `Building ${index + 1}`,
        center
      };
    })
    .filter(building => building.center)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const select of [startSelect, endSelect]) {
    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = select === startSelect
      ? "Select starting building"
      : "Select destination building";

    select.appendChild(placeholder);

    for (const building of navigation.buildings) {
      const option = document.createElement("option");

      option.value = building.id;
      option.textContent = building.name;

      select.appendChild(option);
    }
  }

  routeStatus.textContent =
    `${navigation.buildings.length} buildings available. Choose start and destination to route via pathways.`;
}

function connectNodes(a, b) {
  if (a.key === b.key) return;

  const distance = Cesium.Cartesian3.distance(
    a.position,
    b.position
  );

  if (!Number.isFinite(distance) || distance <= 0) return;

  a.neighbors.set(b.key, distance);
  b.neighbors.set(a.key, distance);
}

function heuristic(a, b) {
  return Cesium.Cartesian3.distance(a.position, b.position);
}

/* ---------- Graph building (metre-based, proper junctions) ---------- */

const SNAP_TOLERANCE = 1.5; // metres: gaps smaller than this are treated as connected
let graphOrigin = null;

function toXY(position) {
  const c = Cesium.Cartographic.fromCartesian(position);
  return {
    x: (c.longitude - graphOrigin.lon) * Math.cos(graphOrigin.lat) * 6378137,
    y: (c.latitude - graphOrigin.lat) * 6378137
  };
}

function segmentIntersectionT(a1, a2, b1, b2) {
  const rx = a2.x - a1.x, ry = a2.y - a1.y;
  const sx = b2.x - b1.x, sy = b2.y - b1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null; // parallel

  const qx = b1.x - a1.x, qy = b1.y - a1.y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;

  return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : null;
}

function projectOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0, dist: Math.hypot(p.x - a.x, p.y - a.y) };

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  return {
    t,
    dist: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
  };
}

function buildGraph() {
  navigation.graph.clear();
  navigation.nodes = [];

  const time = Cesium.JulianDate.now();
  const segments = [];

  for (const entity of paths.entities.values) {
    const positions = entity.polyline?.positions?.getValue(time);
    if (!positions || positions.length < 2) continue;

    if (!graphOrigin) {
      const c = Cesium.Cartographic.fromCartesian(positions[0]);
      graphOrigin = { lon: c.longitude, lat: c.latitude };
    }

    for (let i = 0; i < positions.length - 1; i++) {
      segments.push({
        a: positions[i],
        b: positions[i + 1],
        a2: toXY(positions[i]),
        b2: toXY(positions[i + 1])
      });
    }
  }

  function getOrCreateNode(position) {
    const xy = toXY(position);

    for (const node of navigation.nodes) {
      if (Math.hypot(node.xy.x - xy.x, node.xy.y - xy.y) <= SNAP_TOLERANCE) {
        return node;
      }
    }

    const node = {
      key: `n${navigation.nodes.length}`,
      position,
      xy,
      neighbors: new Map()
    };

    navigation.graph.set(node.key, node);
    navigation.nodes.push(node);
    return node;
  }

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const ts = [0, 1];

    for (let j = 0; j < segments.length; j++) {
      if (i === j) continue;
      const o = segments[j];

      // True crossings
      const t = segmentIntersectionT(s.a2, s.b2, o.a2, o.b2);
      if (t !== null) ts.push(t);

      // T-junctions / near-misses: other segment's endpoints touching this one
      for (const end of [o.a2, o.b2]) {
        const proj = projectOnSegment(end, s.a2, s.b2);
        if (proj.dist <= SNAP_TOLERANCE && proj.t > 0 && proj.t < 1) {
          ts.push(proj.t);
        }
      }
    }

    ts.sort((p, q) => p - q);

    let prevNode = null;
    for (const t of ts) {
      const point = Cesium.Cartesian3.lerp(s.a, s.b, t, new Cesium.Cartesian3());
      const node = getOrCreateNode(point);
      if (prevNode) connectNodes(prevNode, node);
      prevNode = node;
    }
  }

  console.log(`Pathway graph built: ${navigation.nodes.length} nodes.`);
}

/* ---------- Snap a point onto the nearest EDGE (not node) ---------- */

function snapToGraph(target) {
  const p = toXY(target);
  let best = null;

  for (const node of navigation.nodes) {
    for (const key of node.neighbors.keys()) {
      if (node.key > key) continue; // visit each edge once
      const other = navigation.graph.get(key);
      const proj = projectOnSegment(p, node.xy, other.xy);

      if (!best || proj.dist < best.dist) {
        best = { a: node, b: other, t: proj.t, dist: proj.dist };
      }
    }
  }

  if (!best) return null;

  best.point = Cesium.Cartesian3.lerp(
    best.a.position, best.b.position, best.t, new Cesium.Cartesian3()
  );
  return best;
}

function link(a, b) {
  const d = Math.max(Cesium.Cartesian3.distance(a.position, b.position), 1e-6);
  a.neighbors.set(b.key, d);
  b.neighbors.set(a.key, d);
}

function addVirtualNode(key, snap) {
  const node = {
    key,
    position: snap.point,
    xy: toXY(snap.point),
    neighbors: new Map()
  };
  navigation.graph.set(key, node);
  link(node, snap.a);
  link(node, snap.b);
  return node;
}

function removeVirtualNode(node) {
  for (const key of node.neighbors.keys()) {
    navigation.graph.get(key)?.neighbors.delete(node.key);
  }
  navigation.graph.delete(node.key);
}

function sameEdge(s1, s2) {
  return (s1.a === s2.a && s1.b === s2.b) || (s1.a === s2.b && s1.b === s2.a);
}

/* ---------- A* ---------- */

function calculateShortestPath(start, end) {
  if (!start || !end) return null;

  const gScore = new Map([[start.key, 0]]);
  const fScore = new Map([[start.key, heuristic(start, end)]]);
  const previous = new Map();
  const openSet = new Set([start.key]);

  while (openSet.size > 0) {
    let currentKey = null;
    let lowestF = Infinity;

    for (const key of openSet) {
      const score = fScore.get(key) ?? Infinity;
      if (score < lowestF) {
        lowestF = score;
        currentKey = key;
      }
    }

    if (currentKey === null) break;

    if (currentKey === end.key) {
      const route = [];
      let k = currentKey;
      while (k !== undefined) {
        route.push(navigation.graph.get(k));
        k = previous.get(k);
      }
      route.reverse();
      return { nodes: route, distance: gScore.get(end.key) };
    }

    openSet.delete(currentKey);
    const current = navigation.graph.get(currentKey);

    for (const [neighborKey, edgeDistance] of current.neighbors) {
      const tentative = gScore.get(currentKey) + edgeDistance;

      if (tentative < (gScore.get(neighborKey) ?? Infinity)) {
        previous.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentative);
        fScore.set(
          neighborKey,
          tentative + heuristic(navigation.graph.get(neighborKey), end)
        );
        openSet.add(neighborKey);
      }
    }
  }

  return null;
}

/* ---------- QR code for the 2D map ---------- */

const GEONEXUS_CFG = window.GEONEXUS || {};
const qrBox = document.getElementById("qrBox");
const qrTarget = document.getElementById("qrcode");
const qrLink = document.getElementById("qrLink");
const qrWarn = document.getElementById("qrWarn");

function routePageUrl() {
  const page = GEONEXUS_CFG.ROUTE_PAGE || "route.html";

  if (GEONEXUS_CFG.PUBLIC_BASE_URL) {
    return GEONEXUS_CFG.PUBLIC_BASE_URL.replace(/\/?$/, "/") + page;
  }

  return new URL(page, window.location.href).href;
}

function isPrivateHost() {
  const h = window.location.hostname;

  return (
    window.location.protocol === "file:" ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

function hideQR() {
  qrBox.hidden = true;
  qrTarget.replaceChildren();
  qrLink.textContent = "";
  qrLink.removeAttribute("href");
  qrWarn.hidden = true;
}

function showQR(startBuilding, endBuilding) {
  hideQR();

  if (typeof QRCode === "undefined") {
    console.warn("QR library did not load.");
    return;
  }

  // Building ids are "building-<index>"; the 2D page uses the same index.
  const s = startBuilding.id.replace("building-", "");
  const d = endBuilding.id.replace("building-", "");
  const url = `${routePageUrl()}?s=${encodeURIComponent(s)}&d=${encodeURIComponent(d)}`;

  new QRCode(qrTarget, {
    text: url,
    width: 200,
    height: 200,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  qrLink.href = url;
  qrLink.textContent = url;

  if (!GEONEXUS_CFG.PUBLIC_BASE_URL && isPrivateHost()) {
    qrWarn.textContent =
      "This page is not on a public address, so a phone cannot open this QR code. " +
      "Set PUBLIC_BASE_URL in config.js or open the deployed site.";
    qrWarn.hidden = false;
  }

  qrBox.hidden = false;
}

/* ---------- Route display ---------- */

function clearRoute() {
  for (const entity of [
    navigation.routeEntity,
    navigation.startMarker,
    navigation.endMarker
  ]) {
    if (entity) viewer.entities.remove(entity);
  }

  navigation.routeEntity = null;
  navigation.startMarker = null;
  navigation.endMarker = null;

  hideQR();
}

function displayRoute(result, startBuilding, endBuilding) {
  clearRoute();

  const positions = [
    startBuilding.center,
    ...result.nodes.map(node => node.position), // already starts/ends at the snap points
    endBuilding.center
  ];

  navigation.routeEntity = viewer.entities.add({
    name: "Highlighted Campus Route",
    polyline: {
      positions,
      width: 14,
      material: new Cesium.PolylineOutlineMaterialProperty({
        color: ROUTE_COLOR,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3
      }),
      clampToGround: true
    }
  });

  navigation.startMarker = viewer.entities.add({
    name: "Route Start",
    position: startBuilding.center,
    point: {
      pixelSize: 16,
      color: START_COLOR,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: `START: ${startBuilding.name}`,
      font: "14px sans-serif",
      fillColor: START_COLOR,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -25),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });

  navigation.endMarker = viewer.entities.add({
    name: "Route Destination",
    position: endBuilding.center,
    point: {
      pixelSize: 16,
      color: END_COLOR,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: `END: ${endBuilding.name}`,
      font: "14px sans-serif",
      fillColor: END_COLOR,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -25),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });

  routeStatus.textContent =
    `Route found: ${startBuilding.name} → ${endBuilding.name}. ` +
    `Approximate pathway distance: ${result.distance.toFixed(1)} m.`;

  showQR(startBuilding, endBuilding);

  viewer.flyTo(
    [
      navigation.routeEntity,
      navigation.startMarker,
      navigation.endMarker
    ],
    {
      duration: 2,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-35),
        0
      )
    }
  );
}

/* ---------- Find route ---------- */

function findRoute() {
  const start = navigation.buildings.find(b => b.id === startSelect.value);
  const end = navigation.buildings.find(b => b.id === endSelect.value);

  if (!start || !end) {
    routeStatus.textContent = "Please select both the starting building and destination.";
    return;
  }
  if (start.id === end.id) {
    routeStatus.textContent = "Please choose two different buildings.";
    return;
  }
  if (!navigation.nodes.length) {
    routeStatus.textContent = "No pathway lines were found. Check Pathways.geojson.";
    return;
  }

  // Snap both first, then insert, so they can't snap onto each other's temp edges
  const snapS = snapToGraph(start.center);
  const snapE = snapToGraph(end.center);

  if (!snapS || !snapE) {
    clearRoute();
    routeStatus.textContent = "Could not snap the buildings to the pathway network.";
    return;
  }

  const vStart = addVirtualNode("__start", snapS);
  const vEnd = addVirtualNode("__end", snapE);
  if (sameEdge(snapS, snapE)) link(vStart, vEnd);

  const result = calculateShortestPath(vStart, vEnd);

  removeVirtualNode(vStart);
  removeVirtualNode(vEnd);

  if (!result) {
    clearRoute();
    routeStatus.textContent =
      "No connected route found. Check that the pathway features connect to one another.";
    return;
  }

  displayRoute(result, start, end);
}

/* ---------- UI wiring ---------- */

document.getElementById("findRoute").onclick = findRoute;

document.getElementById("resetRoute").onclick = () => {
  clearRoute();
  navigation.pickMode = null;

  routeStatus.textContent =
    "Route cleared. Select your starting building and destination.";
};

startSelect.addEventListener("change", clearRoute);
endSelect.addEventListener("change", clearRoute);

document.getElementById("pickStart").onclick = () => {
  navigation.pickMode = "start";

  routeStatus.textContent =
    "Click the starting building directly on the 3D model.";
};

document.getElementById("pickEnd").onclick = () => {
  navigation.pickMode = "end";

  routeStatus.textContent =
    "Click the destination building directly on the 3D model.";
};

const clickHandler = new Cesium.ScreenSpaceEventHandler(
  viewer.scene.canvas
);

clickHandler.setInputAction(click => {
  if (!navigation.pickMode) return;

  const picked = viewer.scene.pick(click.position);
  const entity = picked?.id;

  const building = navigation.buildings.find(
    item => item.entity === entity
  );

  if (!Cesium.defined(picked) || !building) {
    routeStatus.textContent =
      "Please click on a building, not the ground or a pathway.";
    return;
  }

  if (navigation.pickMode === "start") {
    startSelect.value = building.id;
  } else {
    endSelect.value = building.id;
  }

  navigation.pickMode = null;
  clearRoute();

  routeStatus.textContent =
    `Selected ${building.name}. Select the other building and click Find Route.`;
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

populateBuildingDropdowns();
buildGraph();

console.log("GEONEXUS campus navigation initialised.");