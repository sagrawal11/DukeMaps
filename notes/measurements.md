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
| Crowdable edges (within 120 m of an academic building) | 1,545 (8 academic buildings matched) | `npm run build:crowding` | 2026-10-29 |
| Spatial index build (quadtree over 6,189 nodes / 8,346 edges) | ~5 ms / ~9 ms | `npm run bench` | 2026-10-29 |
| Nearest node — linear scan | ~9.5 µs/query | `npm run bench` | 2026-10-29 |
| Nearest node — quadtree | ~2.3 µs/query | `npm run bench` | 2026-10-29 |
| Nearest node — speedup | **~4×** | `npm run bench` | 2026-10-29 |
| Snap to nearest edge — linear scan | ~122 µs/query | `npm run bench` | 2026-10-29 |
| Snap to nearest edge — quadtree | ~11 µs/query | `npm run bench` | 2026-10-29 |
| Snap to nearest edge — speedup | **~11×** | `npm run bench` | 2026-10-29 |
| Spatial index correctness | 0/5,000 random queries farther than brute force | `npm run bench` | 2026-10-29 |
| Routing benchmark pair (SW↔NE corners, 5.51 km straight-line) | node 8279911448 → 170522148 | `npm run bench:algo` | 2026-10-29 |
| Optimal walk cost / distance (Dijkstra = A\* = biDijkstra = biA\*) | 81.76 min / 6,868 m / 156 hops | `npm run bench:algo` | 2026-10-29 |
| Dijkstra — nodes settled (far corner ⇒ sweeps whole graph) | 6,189 / 6,189 | `npm run bench:algo` | 2026-10-29 |
| A\* — nodes settled vs Dijkstra | 4,533 (**0.73×**) | `npm run bench:algo` | 2026-10-29 |
| biDijkstra — nodes settled vs Dijkstra | 5,399 (**0.87×**) | `npm run bench:algo` | 2026-10-29 |
| biA\* — nodes settled vs Dijkstra | 3,335 (**0.54×**, fewest) | `npm run bench:algo` | 2026-10-29 |
| BFS — fewest hops but slower walk | 103 hops / **94.11 min** (vs optimal 81.76) | `npm run bench:algo` | 2026-10-29 |
| DFS — finds *a* path, a bad one | 366 hops / **185.55 min** / 15,582 m | `npm run bench:algo` | 2026-10-29 |
| Unit tests (graph + editor + time + spatial + algorithms) | 85 passing | `npm test` | 2026-10-29 |

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

Phase 4 (spatial index): a hand-written region quadtree (`src/spatial/quadtree.ts`) with
branch-and-bound nearest-neighbour, queried two ways (`src/spatial/snap.ts`): nearest graph node
and snap-to-nearest-edge. Numbers above, from `npm run bench`. Takeaway for the article: the index
earns its keep on **edge snapping** (~11×, because the linear baseline projects + measures 8,346
polylines per tap); nearest-**node** is a modest ~4× because a 6k-point linear scan is already sub-10 µs.
Correctness is enforced, not assumed — the bench fails if the quadtree ever returns a farther hit
than brute force (0/5,000 here).

Phase 5a (the five searches + bidirectional): all six hand-written, traced, run on the real graph by
`npm run bench:algo` over one fixed far pair (the nodes nearest the SW and NE corners of the campus
bounding box — a reproducible ~5.5 km diagonal). Base walking weight, off-peak, so crowding is 1×
everywhere and the comparison is apples-to-apples. Full table (2026-10-29):

| algorithm | nodes settled | edges relaxed | pushes | cost (min) | distance (m) | hops | median ms |
|-----------|--------------:|--------------:|-------:|-----------:|-------------:|-----:|----------:|
| BFS        | 6,182 | 6,186 | 6,187 |  94.11 |  7,906 | 103 | 0.464 |
| DFS        | 5,710 | 5,919 | 7,915 | 185.55 | 15,582 | 366 | 0.389 |
| Dijkstra   | 6,189 | 7,057 | 7,058 |  81.76 |  6,868 | 156 | 2.181 |
| A\*        | 4,533 | 5,530 | 5,531 |  81.76 |  6,868 | 156 | 2.025 |
| biDijkstra | 5,399 | 6,247 | 6,249 |  81.76 |  6,868 | 156 | 2.001 |
| biA\*      | 3,335 | 4,194 | 4,196 |  81.76 |  6,868 | 156 | 1.535 |

Takeaways for the article:
- **The four optimal searches return the identical cost (81.76 min / 6,868 m / 156 hops)** — the
  guarantee the equal-cost test asserts on 800 random pairs, here shown on the headline pair.
- **BFS minimizes hops, not time:** its route is the fewest-edges path (103 hops) yet takes 94.11 min
  — ~15% slower than optimal — because fewest hops means long edges, not fast ones.
- **DFS is the cautionary tale:** 185.55 min and 15.6 km, 2.3× the optimal walk. It finds *a* path by
  plunging down whatever adjacency order led, never a good one.
- **A\* and bidirectional settle fewer nodes than Dijkstra.** This pair is Dijkstra's worst case —
  the target is the far corner, so its uniform frontier settles the *entire* graph (6,189/6,189). A\*'s
  heuristic pulls toward the target (0.73×); biA\* (heuristic *and* meet-in-the-middle) settles the
  fewest, 0.54×. Honest wrinkle worth noting: here plain A\* (4,533) beats plain biDijkstra (5,399) —
  a good heuristic prunes more than zero-potential meeting does; bidirectional's edge shows up most
  when combined with the heuristic (biA\*).
- **Node count ≠ wall-clock, and the table says so:** A\* settles 27% fewer nodes than Dijkstra but is
  only ~7% faster in median ms, because its heuristic calls haversine (trig) on every relax — the
  pruning isn't free. biA\* is still the fastest of the optimal four (1.535 ms). BFS/DFS look "fast"
  per run (0.39–0.46 ms: no heap, cheaper per node) but produce worse-or-wrong routes — speed without
  optimality is the point of showing them first. (Query time is the *traced* call — building the
  animation event stream — which is what the Phase 6 app actually runs.)

The bench also asserts five invariants and exits non-zero if any breaks (costs agree, BFS ≤ Dijkstra
hops, A\* settles ≤ Dijkstra, BFS/DFS no faster-in-time than optimal) — a benchmark that's silently
wrong is worse than none.

## What to capture
- **Phase 4 — spatial index:** captured above.
- **Phase 5 — algorithms:** captured above (5a). CH/CCH still to come in 5b/5c.
- **Phase 5 — contraction hierarchies:** preprocessing time, shortcuts added, query time vs Dijkstra, data size per profile.
- **Phase 6 — the show:** animation frame rate on a mid-range phone.
