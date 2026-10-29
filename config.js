// GeoNexus deployment config (loaded by index.html and route.html).
//
// PUBLIC_BASE_URL: the public folder that holds route.html, e.g.
//   "https://<username>.github.io/<repo>/"
// Leave it "" to use the folder the 3D page was opened from. That only works when
// the 3D page is opened from the public site (NOT localhost / file://), otherwise
// the QR code will point at an address phones cannot reach.
window.GEONEXUS = {
  PUBLIC_BASE_URL: "",
  ROUTE_PAGE: "route.html",
  BUILDINGS_URL: "Buildings.geojson",
  PATHWAYS_URL: "Pathways.geojson",
  AOI_URL: "campus_aoi.geojson",
  WALK_SPEED_MS: 1.4 // metres per second, used for the estimated walking time
};
