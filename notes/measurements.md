# Measurements

Real numbers to cite in the article. For each, record the value, the date, and the exact
command that produced it. Keep this honest — measured, not estimated.

| Metric | Value | Command | Date |
|--------|-------|---------|------|
| OSM elements fetched (Duke bounds) | 26,252 | `npm run fetch` | 2026-10-28 |
| Graph nodes | 6,249 | `npm run build:graph` | 2026-10-28 |
| Graph edges | 8,375 | `npm run build:graph` | 2026-10-28 |
| Named buildings (places) | 313 | `npm run build:graph` | 2026-10-28 |
| Connected components | 28 (largest 6,178 = 98.9% of nodes) | `npm run build:graph` | 2026-10-28 |
| Dangling stubs (degree-1) | 1,079 | `npm run build:graph` | 2026-10-28 |
| Basemap extract size | 1.7 MB | `npm run fetch:basemap` | 2026-10-28 |

## What to capture
- **Phase 4 — spatial index:** nearest-edge query time, linear scan vs quadtree/R-tree, speedup.
- **Phase 5 — algorithms:** nodes explored, edges relaxed, query time, route cost per algorithm.
- **Phase 5 — contraction hierarchies:** preprocessing time, shortcuts added, query time vs Dijkstra, data size per profile.
- **Phase 6 — the show:** animation frame rate on a mid-range phone.
