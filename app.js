// GEONEXUS SMART CAMPUS NAVIGATION DASHBOARD SYSTEM (3D)
//
// Load order in the HTML:  config.js  ->  routing.js  ->  app.js (type="module")
// routing.js provides PathRouter (config, stable IDs, routing, share URLs).
//
// Put your (rotated + URL-restricted) Cesium Ion token in config.js:
//   window.GEONEXUS = { CESIUM_TOKEN: "...", ... };

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
const on = (id, event, handler) => {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.warn(`Element #${id} not found; skipped binding "${event}".`);
};

if (!window.PathRouter) {
  setText("routeStatus", "routing.js failed to load. It must be included before app.js.");
  throw new Error("PathRouter is missing: include routing.js before app.js.");
}

const CFG = PathRouter.getConfig();
const ROUTING = CFG.routing;

const IMAGERY_ASSET_ID = null;

const HEIGHT_FIELDS = ["height", "Height", "HEIGHT", "building_height", "z", "Z"];
const LEVEL_FIELDS = ["building:levels", "levels", "Levels", "floors", "Floors"];
const NAME_FIELDS = ["Name", "name", "NAME", "building_name", "building:name", "title", "LCD Display Name", "Entrance Name"];
const GID_FIELD = "__gid"; // stable ID injected into each point feature (same IDs as the 2D page)

const METERS_PER_LEVEL = 3.5;
const DEFAULT_HEIGHT = 10;

// Entrance points are near-invisible by default. They stay in the scene so the
// dropdown, routing, hover tooltip and "Pick End" still work. (Fully
// transparent points can be discarded by the renderer and become unpickable,
// so we use a tiny alpha instead, and also reveal them while picking.)
const ENTRANCES_VISIBLE_BY_DEFAULT = false;
const ENTRANCE_COLOR = Cesium.Color.fromCssColorString("#3b82f6");
const ENTRANCE_HIDDEN_COLOR = Cesium.Color.WHITE.withAlpha(0.01);

/* ---------- Viewer ---------- */

if (CFG.cesiumToken) {
  Cesium.Ion.defaultAccessToken = CFG.cesiumToken;
} else {
  console.warn("No Cesium Ion token configured (GEONEXUS.CESIUM_TOKEN). World terrain may fail to load.");
}

let terrainProvider;
try {
  terrainProvider = await Cesium.createWorldTerrainAsync();
} catch (error) {
  console.warn("World terrain failed to load; using a flat ellipsoid.", error);
  terrainProvider = new Cesium.EllipsoidTerrainProvider();
  setText("routeStatus", "Terrain could not be loaded (check the Cesium Ion token). Using flat terrain.");
}

const viewer = new Cesium.Viewer("cesiumContainer", {
  terrainProvider,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  infoBox: false // we render our own info panel
});

viewer.scene.globe.depthTestAgainstTerrain = true;

if (IMAGERY_ASSET_ID) {
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(
    await Cesium.IonImageryProvider.fromAssetId(IMAGERY_ASSET_ID)
  );
}

/* ---------- Property Helpers ---------- */

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
    if (Number.isFinite(value) && value > 0) return value;
  }
  for (const field of LEVEL_FIELDS) {
    const value = parseFloat(propertyValue(entity, field, time));
    if (Number.isFinite(value) && value > 0) return value * METERS_PER_LEVEL;
  }
  return DEFAULT_HEIGHT;
}

function getEntityName(entity, time) {
  for (const field of NAME_FIELDS) {
    const value = propertyValue(entity, field, time);
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return null;
}

const gidOf = (entity) => {
  const v = propertyValue(entity, GID_FIELD, Cesium.JulianDate.now());
  return v === undefined || v === null ? null : String(v);
};

// Sample terrain for many cartographics in ONE request.
async function sampleTerrain(cartographics, label) {
  if (!cartographics.length) return;
  try {
    await Cesium.sampleTerrainMostDetailed(terrainProvider, cartographics);
  } catch (error) {
    console.warn(`${label} terrain sampling failed:`, error);
  }
}

// Writes the stable ID into each point feature so entities can be matched back.
function tagFeatures(json, points) {
  for (const p of points) {
    const feature = json.features[p.featureIndex];
    feature.properties = feature.properties || {};
    feature.properties[GID_FIELD] = p.id;
  }
}

/* ---------- Load Layers ---------- */

const pointData = { dashboards: [], entrances: [] };
let pathwaysJson = null;

async function loadBuildings() {
  const dataSource = await Cesium.GeoJsonDataSource.load(CFG.buildingsUrl);
  const time = Cesium.JulianDate.now();
  const items = [];
  const allCartographics = [];

  for (const entity of dataSource.entities.values) {
    if (!entity.polygon) continue;
    const hierarchy = entity.polygon.hierarchy.getValue(time);
    if (!hierarchy?.positions?.length) continue;
    const cartographics = hierarchy.positions.map((p) => Cesium.Cartographic.fromCartesian(p));
    items.push({ entity, cartographics });
    for (const c of cartographics) allCartographics.push(c);
  }

  await sampleTerrain(allCartographics, "Building"); // one request for all buildings

  for (const { entity, cartographics } of items) {
    let baseHeight = Infinity;
    for (const c of cartographics) baseHeight = Math.min(baseHeight, c.height ?? 0);
    if (!Number.isFinite(baseHeight)) baseHeight = 0;

    entity.polygon.height = baseHeight - 1;
    entity.polygon.extrudedHeight = baseHeight + buildingHeight(entity, time);
    entity.polygon.heightReference = Cesium.HeightReference.NONE;
    entity.polygon.extrudedHeightReference = Cesium.HeightReference.NONE;
    entity.polygon.material = Cesium.Color.fromCssColorString("#FFE5B4");
    entity.polygon.outline = true;
    entity.polygon.outlineColor = Cesium.Color.fromCssColorString("#475569");
  }

  await viewer.dataSources.add(dataSource);
  return dataSource;
}

async function loadPaths() {
  pathwaysJson = await PathRouter.fetchJSON(CFG.pathwaysUrl);
  const dataSource = await Cesium.GeoJsonDataSource.load(pathwaysJson, { clampToGround: true });
  for (const entity of dataSource.entities.values) {
    if (!entity.polyline) continue;
    entity.polyline.material = new Cesium.PolylineOutlineMaterialProperty({
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

async function loadAoi() {
  const red = Cesium.Color.fromCssColorString("#ef4444");
  const dataSource = await Cesium.GeoJsonDataSource.load(CFG.aoiUrl, {
    fill: red.withAlpha(0.1),
    clampToGround: true
  });

  const time = Cesium.JulianDate.now();
  for (const entity of [...dataSource.entities.values]) {
    if (!entity.polygon) continue;
    const hierarchy = entity.polygon.hierarchy.getValue(time);
    if (!hierarchy?.positions?.length) continue;

    dataSource.entities.add({
      polyline: {
        positions: [...hierarchy.positions, hierarchy.positions[0]],
        width: 4,
        material: red,
        clampToGround: true
      }
    });
  }
  await viewer.dataSources.add(dataSource);
  return dataSource;
}

async function loadDashboardLocations() {
  const json = await PathRouter.fetchJSON(CFG.screensUrl);
  pointData.dashboards = PathRouter.extractPoints(json, "LCD Display Name");
  tagFeatures(json, pointData.dashboards);

  const dataSource = await Cesium.GeoJsonDataSource.load(json, { clampToGround: true });
  const time = Cesium.JulianDate.now();

  const entities = dataSource.entities.values.filter((e) => e.position);
  const cartographics = entities.map((e) => Cesium.Cartographic.fromCartesian(e.position.getValue(time)));
  await sampleTerrain(cartographics, "Dashboard");

  entities.forEach((entity, i) => {
    const c = cartographics[i];
    // Position already carries the sampled terrain height, so no CLAMP is needed.
    entity.position = Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height ?? 0);
    entity.billboard = undefined;
    entity.point = undefined;
    entity.model = new Cesium.ModelGraphics({
      uri: "mapscreen.glb",
      scale: 1.0,
      minimumPixelSize: 20,
      maximumScale: 50,
      heightReference: Cesium.HeightReference.NONE,
      shadows: Cesium.ShadowMode.ENABLED
    });
  });

  await viewer.dataSources.add(dataSource);
  return dataSource;
}

function setEntrancesVisible(dataSource, visible) {
  for (const entity of dataSource.entities.values) {
    if (!entity.point) continue;
    entity.point.color = visible ? ENTRANCE_COLOR : ENTRANCE_HIDDEN_COLOR;
    entity.point.outlineColor = visible ? Cesium.Color.WHITE : ENTRANCE_HIDDEN_COLOR;
    entity.point.outlineWidth = visible ? 2 : 0;
  }
}

async function loadBuildingEntrances() {
  const json = await PathRouter.fetchJSON(CFG.entrancesUrl);
  pointData.entrances = PathRouter.extractPoints(json, "Entrance Name");
  tagFeatures(json, pointData.entrances);

  const dataSource = await Cesium.GeoJsonDataSource.load(json, { clampToGround: true });

  for (const entity of dataSource.entities.values) {
    if (!entity.position) continue;
    entity.billboard = undefined;
    entity.point = new Cesium.PointGraphics({
      pixelSize: 10,
      color: ENTRANCE_COLOR,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
    });
  }

  setEntrancesVisible(dataSource, ENTRANCES_VISIBLE_BY_DEFAULT);
  await viewer.dataSources.add(dataSource);
  return dataSource;
}

/* ---------- Layer Initialization (one failed layer no longer kills the app) ---------- */

const layerLoaders = [
  ["buildings", loadBuildings],
  ["paths", loadPaths],
  ["aoi", loadAoi],
  ["dashboards", loadDashboardLocations],
  ["entrances", loadBuildingEntrances]
];

const layerResults = await Promise.allSettled(layerLoaders.map(([, load]) => load()));
const failedLayers = [];
const sources = {};

for (let i = 0; i < layerResults.length; i++) {
  const name = layerLoaders[i][0];
  const result = layerResults[i];
  if (result.status === "fulfilled") {
    sources[name] = result.value;
  } else {
    console.error(`Layer "${name}" failed to load:`, result.reason);
    failedLayers.push(name);
    const empty = new Cesium.CustomDataSource(name); // keeps .show / .entities valid
    await viewer.dataSources.add(empty);
    sources[name] = empty;
  }
}

const { buildings, paths, aoi, dashboards, entrances } = sources;

/* ---------- Toolbar / toggles ---------- */

let entrancesUserVisible = ENTRANCES_VISIBLE_BY_DEFAULT;

const home = () => {
  const target = [aoi, buildings, paths].find((ds) => ds.entities.values.length > 0);
  if (!target) return;
  viewer.flyTo(target, {
    duration: 2,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), 0)
  });
};

on("btnHome", "click", home);
on("tglBuildings", "change", (e) => { buildings.show = e.target.checked; });
on("tglPaths", "change", (e) => { paths.show = e.target.checked; });
on("tglAoi", "change", (e) => { aoi.show = e.target.checked; });
if ($("tglDashboards")) on("tglDashboards", "change", (e) => { dashboards.show = e.target.checked; });
if ($("tglEntrances")) {
  $("tglEntrances").checked = ENTRANCES_VISIBLE_BY_DEFAULT;
  on("tglEntrances", "change", (e) => {
    entrancesUserVisible = e.target.checked;
    applyEntranceVisibility();
  });
}

home();

/* ---------- Navigation state ---------- */

const navigation = {
  dashboards: [],
  entrances: [],
  network: null,
  routeEntity: null,
  startMarker: null,
  endMarker: null,
  pickMode: null
};

function applyEntranceVisibility() {
  setEntrancesVisible(entrances, entrancesUserVisible || navigation.pickMode === "end");
}

function kindOf(entity) {
  if (entity === navigation.routeEntity) return "route";
  if (entity === navigation.startMarker) return "routeStart";
  if (entity === navigation.endMarker) return "routeEnd";
  const owner = entity.entityCollection?.owner;
  if (owner === dashboards) return "screen";
  if (owner === entrances) return "entrance";
  if (owner === buildings) return "building";
  if (owner === paths) return "path";
  if (owner === aoi) return "aoi";
  return "other";
}

/* ---------- Hover Tooltip (throttled to one pick per frame) ---------- */

const tooltip = $("tooltip");
const hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
let hoverPosition = null;
let hoverScheduled = false;

function tooltipText(entity, time) {
  switch (kindOf(entity)) {
    case "building":
      return getEntityName(entity, time);
    case "path": {
      const roadName = propertyValue(entity, "Road Name", time) || propertyValue(entity, "name", time);
      if (!roadName) return null;
      const roadType = propertyValue(entity, "Road Type", time);
      return roadType ? `${roadName} (${roadType})` : String(roadName);
    }
    case "screen":
      return `LCD: ${propertyValue(entity, "LCD Display Name", time) || propertyValue(entity, "Name", time) || "Dashboard Screen"}`;
    case "entrance":
      return `Entrance: ${propertyValue(entity, "Entrance Name", time) || propertyValue(entity, "Name", time) || "Building Entrance"}`;
    case "routeStart":
      return "Route start";
    case "routeEnd":
      return "Route destination";
    default:
      return null;
  }
}

function processHover() {
  hoverScheduled = false;
  if (!tooltip || !hoverPosition) return;

  const picked = viewer.scene.pick(hoverPosition);
  const entity = picked?.id instanceof Cesium.Entity ? picked.id : null;
  const text = entity ? tooltipText(entity, Cesium.JulianDate.now()) : null;

  if (text) {
    tooltip.style.display = "block";
    tooltip.style.left = `${hoverPosition.x + 15}px`;
    tooltip.style.top = `${hoverPosition.y + 15}px`;
    tooltip.textContent = text;
  } else {
    tooltip.style.display = "none";
  }
}

hoverHandler.setInputAction((movement) => {
  hoverPosition = Cesium.Cartesian2.clone(movement.endPosition);
  if (!hoverScheduled) {
    hoverScheduled = true;
    requestAnimationFrame(processHover);
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

/* ---------- Selected Entity Information ---------- */

const DEFAULT_INFO_TEXT = "Click a building, pathway, display screen, or entrance to see attributes.";

function renderInfo(title, rows = []) {
  const info = $("info");
  if (!info) return;
  info.replaceChildren();

  const heading = document.createElement("strong");
  heading.textContent = title;
  info.appendChild(heading);

  if (rows.length) {
    const table = document.createElement("table");
    for (const [key, value] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      const td = document.createElement("td");
      th.textContent = key;
      td.textContent = value;
      tr.append(th, td);
      table.appendChild(tr);
    }
    info.appendChild(table);
  }
}

function propertyRows(entity, time) {
  const rows = [];
  const names = entity.properties?.propertyNames || [];
  for (const name of names) {
    if (name === GID_FIELD) continue;
    const value = propertyValue(entity, name, time);
    if (value === undefined || value === null || value === "") continue;
    rows.push([name, typeof value === "object" ? JSON.stringify(value) : String(value)]);
  }
  return rows;
}

viewer.selectedEntityChanged.addEventListener((entity) => {
  const info = $("info");
  if (!entity) {
    if (info) info.textContent = DEFAULT_INFO_TEXT;
    return;
  }

  const time = Cesium.JulianDate.now();
  const name = getEntityName(entity, time);

  switch (kindOf(entity)) {
    case "screen":
      renderInfo(`Display Screen: ${name || "Dashboard Display"}`);
      break;
    case "entrance":
      renderInfo(`Entrance: ${name || "Building Entrance"}`);
      break;
    case "building":
      renderInfo(name || "Building", [
        ["Height (m)", buildingHeight(entity, time).toFixed(1)],
        ...propertyRows(entity, time)
      ]);
      break;
    case "path":
      renderInfo(
        propertyValue(entity, "Road Name", time) || name || "Pathway",
        propertyRows(entity, time)
      );
      break;
    case "aoi":
      renderInfo("Campus boundary");
      break;
    case "routeStart":
      renderInfo("Route start", [["Location", navigation.startItem?.name || ""]]);
      break;
    case "routeEnd":
      renderInfo("Route destination", [["Location", navigation.endItem?.name || ""]]);
      break;
    case "route":
      renderInfo("Highlighted campus route");
      break;
    default:
      renderInfo(entity.name || "Selected feature", entity.properties ? propertyRows(entity, time) : []);
  }
});

/* ---------- Routing UI ---------- */

const startSelect = $("startBuilding");
const endSelect = $("endBuilding");
const setRouteStatus = (msg) => setText("routeStatus", msg);

const START_COLOR = Cesium.Color.fromCssColorString(ROUTING.startColor);
const END_COLOR = Cesium.Color.fromCssColorString(ROUTING.destColor);
const ROUTE_COLOR = Cesium.Color.fromCssColorString(ROUTING.routeColor);

function buildItems(points, dataSource) {
  const time = Cesium.JulianDate.now();
  const byGid = new Map();
  for (const entity of dataSource.entities.values) {
    const gid = propertyValue(entity, GID_FIELD, time);
    if (gid !== undefined && gid !== null && !byGid.has(String(gid))) byGid.set(String(gid), entity);
  }
  return points
    .map((p) => ({ ...p, entity: byGid.get(p.id) || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fillDropdown(select, items, placeholder) {
  select.replaceChildren();
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  select.appendChild(ph);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    select.appendChild(option);
  }
}

function populateRoutingDropdowns() {
  navigation.dashboards = buildItems(pointData.dashboards, dashboards);
  navigation.entrances = buildItems(pointData.entrances, entrances);

  fillDropdown(startSelect, navigation.dashboards, "Select LCD Display Screen");
  fillDropdown(endSelect, navigation.entrances, "Select Building Entrance");

  let message = `${navigation.dashboards.length} screens & ${navigation.entrances.length} entrances loaded. Choose start screen and destination entrance.`;
  if (failedLayers.length) message += ` (Failed to load: ${failedLayers.join(", ")}.)`;
  setRouteStatus(message);
}

function buildNetwork() {
  if (!pathwaysJson) {
    navigation.network = null;
    return;
  }
  navigation.network = new PathRouter.PathNetwork(pathwaysJson, {
    snapTolerance: ROUTING.snapTolerance,
    maxSnapDistance: ROUTING.maxSnapDistance
  });
}

/* ---------- QR Code ---------- */

function hideQR() {
  const qrBox = $("qrBox");
  if (qrBox) qrBox.hidden = true;
  const target = $("qrcode");
  if (target) target.replaceChildren();
  const link = $("qrLink");
  if (link) {
    link.textContent = "";
    link.removeAttribute("href");
  }
  const warn = $("qrWarn");
  if (warn) warn.hidden = true;
}

function showQR(startItem, endItem) {
  hideQR();
  const qrBox = $("qrBox");
  if (!qrBox) return;

  const url = PathRouter.buildRouteUrl(startItem.id, endItem.id);

  const target = $("qrcode");
  if (target && typeof QRCode !== "undefined") {
    new QRCode(target, {
      text: url,
      width: 200,
      height: 200,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  const link = $("qrLink");
  if (link) {
    link.href = url;
    link.textContent = url;
  }

  // A QR pointing at localhost or file:// is useless from a phone.
  const warn = $("qrWarn");
  if (warn) warn.hidden = PathRouter.isShareableHost();

  qrBox.hidden = false;
}

/* ---------- Route Rendering ---------- */

function clearRoute() {
  for (const entity of [navigation.routeEntity, navigation.startMarker, navigation.endMarker]) {
    if (entity) viewer.entities.remove(entity);
  }
  navigation.routeEntity = null;
  navigation.startMarker = null;
  navigation.endMarker = null;
  navigation.startItem = null;
  navigation.endItem = null;
  hideQR();
}

function routeMarker(name, item, color, prefix) {
  return viewer.entities.add({
    name,
    position: Cesium.Cartesian3.fromDegrees(item.coordinates[0], item.coordinates[1]),
    point: {
      pixelSize: 16,
      color,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: `${prefix}: ${item.name}`,
      font: "14px sans-serif",
      fillColor: color,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -25),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });
}

function displayRoute(result, startItem, endItem) {
  clearRoute();
  navigation.startItem = startItem;
  navigation.endItem = endItem;

  const flat = [];
  for (const [lng, lat] of result.coordinates) flat.push(lng, lat);

  navigation.routeEntity = viewer.entities.add({
    name: "Highlighted Campus Route",
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flat),
      width: 14,
      material: new Cesium.PolylineOutlineMaterialProperty({
        color: ROUTE_COLOR,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3
      }),
      clampToGround: true
    }
  });

  navigation.startMarker = routeMarker("Route Start", startItem, START_COLOR, "START");
  navigation.endMarker = routeMarker("Route Destination", endItem, END_COLOR, "END");

  const mins = Math.max(1, Math.round(result.distance / ROUTING.walkSpeed / 60));
  setRouteStatus(
    `Route found: ${startItem.name} → ${endItem.name}. Approximate walking distance: ${Math.round(result.distance)} m (≈ ${mins} min).`
  );
  showQR(startItem, endItem);

  viewer.flyTo([navigation.routeEntity, navigation.startMarker, navigation.endMarker], {
    duration: 2,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), 0)
  });
}

function findRoute() {
  const start = navigation.dashboards.find((b) => b.id === startSelect.value);
  const end = navigation.entrances.find((b) => b.id === endSelect.value);

  if (!start || !end) {
    setRouteStatus("Please select both a start screen and a destination entrance.");
    return;
  }
  if (!navigation.network) {
    clearRoute();
    setRouteStatus("The pathway network failed to load, so routes are unavailable.");
    return;
  }

  let result;
  try {
    result = navigation.network.route(start.coordinates, end.coordinates, {
      startLabel: "The start screen",
      endLabel: "The destination entrance"
    });
  } catch (error) {
    clearRoute();
    setRouteStatus(error.message);
    return;
  }

  displayRoute(result, start, end);
}

/* ---------- Pick modes ---------- */

function setPickMode(mode) {
  navigation.pickMode = mode;
  applyEntranceVisibility(); // entrances are revealed while picking an end point
}

function wireRoutingUi() {
  on("findRoute", "click", findRoute);
  on("resetRoute", "click", () => {
    clearRoute();
    setPickMode(null);
    setRouteStatus("Route cleared. Choose starting screen and destination entrance.");
  });

  startSelect.addEventListener("change", clearRoute);
  endSelect.addEventListener("change", clearRoute);

  on("pickStart", "click", () => {
    setPickMode("start");
    setRouteStatus("Click a display screen model directly on the 3D map (Esc to cancel).");
  });

  on("pickEnd", "click", () => {
    setPickMode("end");
    setRouteStatus("Click a building entrance point directly on the 3D map (Esc to cancel).");
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navigation.pickMode) {
      setPickMode(null);
      setRouteStatus("Selection cancelled.");
    }
  });

  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction((click) => {
    if (!navigation.pickMode) return;
    const picked = viewer.scene.pick(click.position);
    const entity = picked?.id instanceof Cesium.Entity ? picked.id : null;
    if (!entity) return;

    const kind = kindOf(entity);
    const gid = gidOf(entity);

    if (navigation.pickMode === "start" && kind === "screen") {
      const item = navigation.dashboards.find((d) => d.id === gid);
      if (item) {
        startSelect.value = item.id;
        setPickMode(null);
        clearRoute();
        setRouteStatus(`Selected start display screen: ${item.name}. Now select an entrance.`);
      }
    } else if (navigation.pickMode === "end" && kind === "entrance") {
      const item = navigation.entrances.find((e) => e.id === gid);
      if (item) {
        endSelect.value = item.id;
        setPickMode(null);
        clearRoute();
        setRouteStatus(`Selected destination entrance: ${item.name}. Click Find Route.`);
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

if (startSelect && endSelect) {
  populateRoutingDropdowns();
  buildNetwork();
  wireRoutingUi();
} else {
  console.error("Routing UI skipped: #startBuilding and/or #endBuilding not found.");
}
