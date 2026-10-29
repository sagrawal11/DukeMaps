# Measurements

Real numbers to cite in the article. For each, record the value, the date, and the exact
command that produced it. Keep this honest — measured, not estimated.

| Metric | Value | Command | Date |
|--------|-------|---------|------|
| OSM elements fetched (Duke bounds) | 26,252 | `npm run fetch` | 2026-10-28 |
| Graph nodes (after pruning islands) | 6,178 | `npm run build:graph` | 2026-10-28 |
| Graph edges | 8,325 | `npm run build:graph` | 2026-10-28 |
| Named buildings (places) | 313 | `npm run build:graph` | 2026-10-28 |
| Connected components | 1 (pruned 27 off-campus islands = 71 nodes) | `npm run build:graph` | 2026-10-28 |
| Dangling stubs (degree-1) | 1,023 | `npm run build:graph` | 2026-10-28 |
| Basemap extract size | 1.7 MB | `npm run fetch:basemap` | 2026-10-28 |
| Base graph — pre-prune (what the editor edits against) | 6,249 nodes / 8,375 edges | `npm run build:graph` → `data/processed/graph.base.json` | 2026-10-29 |
| Island pruning delta (base → shipped) | −71 nodes / −50 edges (27 components) | `npm run build:graph` | 2026-10-29 |
| Base graph file size | 2.6 MB | `ls -lh data/processed/graph.base.json` | 2026-10-29 |
| Unit tests (graph + editor + time helpers) | 56 passing | `npm test` | 2026-10-29 |
| Crowdable edges (within 120 m of an academic building) | 0 — none configured yet | `npm run build:crowding` | 2026-10-29 |

Phase 2 (the editor) is complete: the dev-only editor edits the base graph and autosaves a
replayable edit log (`data/my_edits.json`); `npm run build:graph` replays it, then prunes to
the largest connected component. No new routing-algorithm numbers here — those arrive in
Phases 4–6.

Phase 3 (time): the card-access model was removed (every campus path is freely accessible);
`requires`/permissions/profiles are gone. Added the time-dependent cost model (`src/graph/time.ts`:
class-change crowding + hours gating, arrival-time evaluation, FIFO-safe) and `build:crowding`.
Crowding is **inert until `config/schedule.json` is filled** with real `classEndTimes` +
`academicBuildings`; once filled, re-run `build:crowding` (crowdable-edge count, build time) and
`scripts/find-presets.ts` (route-changing pairs) and record the numbers here.

## What to capture
- **Phase 4 — spatial index:** nearest-edge query time, linear scan vs quadtree/R-tree, speedup.
- **Phase 5 — algorithms:** nodes explored, edges relaxed, query time, route cost per algorithm.
- **Phase 5 — contraction hierarchies:** preprocessing time, shortcuts added, query time vs Dijkstra, data size per profile.
- **Phase 6 — the show:** animation frame rate on a mid-range phone.
