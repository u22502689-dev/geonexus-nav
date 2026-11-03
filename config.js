// ==========================================
// GEONEXUS CONFIGURATION
// ==========================================

window.GEONEXUS = {
    PUBLIC_BASE_URL: "https://u22502689-dev.github.io/geonexus-nav/",
    ROUTE_PAGE: "route.html",

    DATA: {
        BUILDINGS: "Buildings.geojson",
        PATHWAYS: "Pathways.geojson",
        AOI: "campus_aoi.geojson"
    },

    ROUTING: {
        WALK_SPEED_MS: 1.4,
        ROUTE_COLOR: "#ec4899",
        START_COLOR: "#22c55e",
        DESTINATION_COLOR: "#ef4444"
    },

    // ADD THIS FUNCTION HERE:
    getRouteUrl: function (destId, startId = "USER_GPS_LOCATION") {
        const base = this.PUBLIC_BASE_URL.endsWith("/")
            ? `${this.PUBLIC_BASE_URL}${this.ROUTE_PAGE}`
            : `${this.PUBLIC_BASE_URL}/${this.ROUTE_PAGE}`;
        return `${base}?s=${encodeURIComponent(startId)}&d=${encodeURIComponent(destId)}`;
    }
};

// ==========================================
// GEONEXUS PATH ROUTER
// ==========================================

window.PathRouter = (function () {
    "use strict";

    class PathNetwork {

        constructor(geojson) {
            this.graph = new Map();
            this.buildGraph(geojson);
        }

        distance(a, b) {
            const R = 6371000;
            const rad = Math.PI / 180;

            const lat1 = a[1] * rad;
            const lat2 = b[1] * rad;

            const dLat = (b[1] - a[1]) * rad;
            const dLon = (b[0] - a[0]) * rad;

            const h =
                Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1) *
                Math.cos(lat2) *
                Math.sin(dLon / 2) ** 2;

            return 2 * R * Math.asin(Math.sqrt(h));
        }

        nodeKey(coord) {
            return coord[0].toFixed(7) + "," +
                   coord[1].toFixed(7);
        }

        addEdge(a, b) {
            const keyA = this.nodeKey(a);
            const keyB = this.nodeKey(b);

            if (!this.graph.has(keyA)) {
                this.graph.set(keyA, []);
            }

            if (!this.graph.has(keyB)) {
                this.graph.set(keyB, []);
            }

            const weight = this.distance(a, b);

            this.graph.get(keyA).push({
                node: keyB,
                weight
            });

            this.graph.get(keyB).push({
                node: keyA,
                weight
            });
        }

        buildGraph(geojson) {
            (geojson.features || []).forEach(feature => {

                const geometry = feature.geometry;
                if (!geometry) return;

                let lines = [];

                if (geometry.type === "LineString") {
                    lines = [geometry.coordinates];
                }

                if (geometry.type === "MultiLineString") {
                    lines = geometry.coordinates;
                }

                lines.forEach(line => {
                    for (let i = 0; i < line.length - 1; i++) {
                        this.addEdge(line[i], line[i + 1]);
                    }
                });
            });
        }

        nearestNode(point) {
            let nearest = null;
            let minDistance = Infinity;

            for (const key of this.graph.keys()) {
                const coord = key.split(",").map(Number);
                const d = this.distance(point, coord);

                if (d < minDistance) {
                    minDistance = d;
                    nearest = key;
                }
            }

            if (!nearest) {
                throw new Error("Pathway network is empty.");
            }

            return { key: nearest, distance: minDistance };
        }

        shortestPath(start, end) {
            const distances = new Map();
            const previous = new Map();
            const unvisited = new Set(this.graph.keys());

            for (const node of unvisited) {
                distances.set(node, Infinity);
            }

            distances.set(start, 0);

            while (unvisited.size) {

                let current = null;
                let best = Infinity;

                for (const node of unvisited) {
                    if (distances.get(node) < best) {
                        best = distances.get(node);
                        current = node;
                    }
                }

                if (current === null || best === Infinity) break;
                if (current === end) break;

                unvisited.delete(current);

                for (const edge of this.graph.get(current)) {

                    if (!unvisited.has(edge.node)) continue;

                    const alt = distances.get(current) + edge.weight;

                    if (alt < distances.get(edge.node)) {
                        distances.set(edge.node, alt);
                        previous.set(edge.node, current);
                    }
                }
            }

            if (distances.get(end) === Infinity) {
                throw new Error("No connected walking route found.");
            }

            const path = [];
            let current = end;

            while (current !== undefined) {
                path.unshift(current.split(",").map(Number));
                current = previous.get(current);
            }

            return {
                path,
                distance: distances.get(end)
            };
        }

        route(startCoord, endCoord) {
            const start = this.nearestNode(startCoord);
            const end = this.nearestNode(endCoord);

            const result = this.shortestPath(start.key, end.key);

            return {
                path: result.path,
                distance:
                    result.distance +
                    start.distance +
                    end.distance
            };
        }
    }

    return { PathNetwork };

})();
