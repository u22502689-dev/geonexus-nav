// GeoNexus 3D page config (read by app.js to build the QR code link).
//
// PUBLIC_BASE_URL: the public folder that holds route.html, e.g.
//   "https://<username>.github.io/<repo>/"
// Leave it "" to use the folder the 3D page was opened from. That only works when
// the 3D page is opened from the public site (NOT localhost / file://), otherwise
// the QR code will point at an address phones cannot reach.
window.GEONEXUS = {
  PUBLIC_BASE_URL: "https://u22502689-dev.github.io/geonexus-nav/",
  ROUTE_PAGE: "route.html"
};
