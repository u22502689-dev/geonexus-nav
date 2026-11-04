// ==========================================
// GEONEXUS CONFIGURATION (settings only; routing logic lives in routing.js)
// ==========================================

window.GEONEXUS = {
    PUBLIC_BASE_URL: "https://u22502689-dev.github.io/geonexus-nav/",
    ROUTE_PAGE: "route.html",

    // Your NEW Cesium Ion token. Rotate the old one and restrict the new one
    // to your site's URL (and only the assets you need) in the Cesium Ion dashboard.
    CESIUM_TOKEN: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjF4NEQ2RXVIdnhEU3ZVQ0wiLCJqdGkiOiIzNjViYjNhMS04ODJlLTRkYWItYmVkMC0xN2I1NTdjZjgxYjIiLCJpZCI6NTEyMTU0LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTA3NzY3MDl9.NcMiDOBCqxHQfxRQC35kOslp0cXZeyWPPo9m-MklGpY",

    DATA: {
        BUILDINGS: "Buildings.geojson",
        PATHWAYS: "Pathways.geojson",
        AOI: "campus_aoi.geojson",
        SCREENS: "Dashboard_loc.geojson",
        ENTRANCES: "building_entrances.geojson"
    },

    ROUTING: {
        WALK_SPEED_MS: 1.4,
        ROUTE_COLOR: "#ec4899",
        START_COLOR: "#22c55e",
        DESTINATION_COLOR: "#ef4444"
        // Optional tuning (defaults shown):
        // SNAP_TOLERANCE_M: 1.5,   // merge pathway nodes closer than this
        // MAX_SNAP_M: 75,          // max distance from a screen/entrance to a pathway
        // MAX_GPS_SNAP_M: 100,     // max distance from a GPS fix to a pathway
        // GPS_MIN_MOVE_M: 3        // re-route only after moving this far
    }

    // Optional:
    // TILE_URL: "https://your-tile-provider/{z}/{x}/{y}.png",
    // TILE_ATTRIBUTION: "...",
    // ALLOW_EXTERNAL_QR: false
};
