  // Public GitHub Pages deployment URL
    PUBLIC_BASE_URL: "https://u22502689-dev.github.io/geonexus-nav/",

    // Routing page
    ROUTE_PAGE: "route.html",

    // Geospatial datasets
    DATA: {
        BUILDINGS: "Buildings.geojson",
        PATHWAYS: "Pathways.geojson",
        AOI: "campus_aoi.geojson"
    },

    // Routing settings
    ROUTING: {
        WALK_SPEED_MS: 1.4,
        ROUTE_COLOR: "#ec4899",
        START_COLOR: "#22c55e",
        DESTINATION_COLOR: "#ef4444"
    }
};


/* ==========================================
   GEONEXUS PATH ROUTER
   Campus pedestrian network routing engine
========================================== */

window.PathRouter = (function () {
    "use strict";

    class PathNetwork {
        constructor(geojson) {
            this.graph = new Map();
            this.buildGraph(geojson);
        }

        // Calculate distance between two coordinates
        distance(a, b) {
            const R = 6371000;
            const toRad = Math.PI / 180;

            const lat1 = a[1] * toRad;
            const lat2 = b[1] * toRad;

            const dLat = (b[1] - a[1]) * toRad;
            const dLon = (b[0] - a[0]) * toRad;

            const h =
                Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1) *
                Math.cos(lat2) *
                Math.sin(dLon / 2) ** 2;

            return 2 * R * Math.asin(Math.sqrt(h));
        }

        // Create a unique identifier for each coordinate
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
                coord: b,
                weight
            });

            this.graph.get(keyB).push({
                node: keyA,
                coord: a,
                weight
            });
        }

        // Build the pedestrian network
        buildGraph(geojson) {
            const features = geojson.features || [];

            features.forEach(feature => {
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

        // Find closest network node to a building
        nearestNode(point) {
            let nearest = null;
            let minDistance = Infinity;

            for (const [key, edges] of this.graph.entries()) {
                const coord = edges.length
                    ? edges[0].coord
                    : key.split(",").map(Number);

                const d = this.distance(point, coord);

                if (d < minDistance) {
                    minDistance = d;
                    nearest = key;
                }
            }

            if (nearest === null) {
                throw new Error("The pathway network is empty.");
            }

            return {
                key: nearest,
                distance: minDistance
            };
        }

        // Dijkstra shortest-path algorithm
        shortestPath(start, end) {
            const distances = new Map();
            const previous = new Map();
            const unvisited = new Set(this.graph.keys());

            for (const node of unvisited) {
                distances.set(node, Infinity);
            }

            distances.set(start, 0);

            while (unvisited.size > 0) {
                let current = null;
                let bestDistance = Infinity;

                for (const node of unvisited) {
                    const d = distances.get(node);

                    if (d < bestDistance) {
                        bestDistance = d;
                        current = node;
                    }
                }

                if (current === null || bestDistance === Infinity) {
                    break;
                }

                if (current === end) {
                    break;
                }

                unvisited.delete(current);

                const neighbours = this.graph.get(current) || [];

                neighbours.forEach(edge => {
                    if (!unvisited.has(edge.node)) return;

                    const alternative =
                        distances.get(current) + edge.weight;

                    if (alternative < distances.get(edge.node)) {
                        distances.set(edge.node, alternative);
                        previous.set(edge.node, current);
                    }
                });
            }

            if (distances.get(end) === Infinity) {
                throw new Error(
                    "No connected walking route was found between these buildings."
                );
            }

            const path = [];
            let current = end;

            while (current !== undefined) {
                path.unshift(
                    current.split(",").map(Number)
                );

                current = previous.get(current);
            }

            return {
                path,
                distance: distances.get(end)
            };
        }

        // Public routing function
        route(startCoord, endCoord) {
            if (!this.graph.size) {
                throw new Error("No pathway data is available.");
            }

            const start = this.nearestNode(startCoord);
            const end = this.nearestNode(endCoord);

            const result = this.shortestPath(
                start.key,
                end.key
            );

            return {
                path: result.path,
                distance:
                    result.distance +
                    start.distance +
                    end.distance
            };
        }
    }

    return {
        PathNetwork
    };

})();
