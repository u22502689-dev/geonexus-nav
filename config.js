// GeoNexus global config (loaded by index.html and route.html)
window.GEONEXUS = {
  // Base public deployment URL for QR codes
  PUBLIC_BASE_URL: "https://u22502689-dev.github.io/geonexus-nav/",
  ROUTE_PAGE: "route.html",

  // Dataset locations for the 2D router
  SCREENS_URL: "Dashboard_loc.geojson",
  ENTRANCES_URL: "building_entrances.geojson",
  PATHWAYS_URL: "Pathways.geojson",
  AOI_URL: "campus_aoi.geojson",

  // Average walking speed (1.4 m/s ≈ 5 km/h) for ETA calculations
  WALK_SPEED_MS: 1.4
};
