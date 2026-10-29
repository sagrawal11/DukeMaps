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
| CH preprocessing (6,189 nodes, static base metric) | 0.59 s · 11,110 shortcuts | `npm run build:ch` | 2026-10-29 |
| CH hierarchy size (`public/data/ch.json`) | 1.71 MB · avg 3.12 up-arcs/node, max 18 | `npm run build:ch` | 2026-10-29 |
| CH query vs Dijkstra — far pair, nodes settled | **140 vs 6,189 (44× fewer)**, same 81.76 min | `npm run bench:ch` | 2026-10-29 |
| CH query vs Dijkstra — avg over 300 random pairs, settled | **134 vs 2,965 (22× fewer)** | `npm run bench:ch` | 2026-10-29 |
| CH query vs Dijkstra — avg query time | **0.067 ms vs 0.974 ms (~15× faster)** | `npm run bench:ch` | 2026-10-29 |
| CH correctness | CH == Dijkstra cost on every sampled real pair (0 mismatches) | `npm run build:ch` / `bench:ch` | 2026-10-29 |
| CCH structure (nested dissection + unconditional contraction) | 0.05 s · 45,240 shortcuts · `cch.json` 0.35 MB | `npm run build:cch` | 2026-10-29 |
| CCH customization (re-weight the WHOLE hierarchy per metric) | ~22–41 ms/metric (base / step-free / crowding snapshot) | `npm run build:cch` / `bench:cch` | 2026-10-29 |
| CCH shortcuts vs CH | 45,240 vs 11,110 (**4.1×** — the metric-independence trade) | `npm run bench:cch` | 2026-10-29 |
| CCH correctness (3 metrics) | CCH == Dijkstra on every sampled pair; step-free routes stay step-free inside shortcuts | `npm test` / `build:cch` | 2026-10-29 |
| Unit tests (graph + editor + time + spatial + algorithms + CH + CCH) | 96 passing | `npm test` | 2026-10-29 |

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

Phase 5b (contraction hierarchies): hand-written CH on the static base metric. Preprocessing
(`npm run build:ch` → `public/data/ch.json`) contracts all 6,189 nodes in **0.59 s**, adding **11,110
shortcuts** on top of 8,244 original up-arcs (avg 3.12 up-arcs/node, max 18); the shipped `ch.json` is
1.71 MB. The query (`npm run bench:ch`) is a bidirectional *upward* search that climbs the hierarchy
from both ends:

| pair set | metric | Dijkstra | CH | speedup |
|----------|--------|---------:|---:|--------:|
| far pair (SW↔NE) | nodes settled | 6,189 | **140** | **44×** |
| far pair (SW↔NE) | median query ms | 2.405 | **0.151** | ~16× |
| 300 random pairs | avg nodes settled | 2,965 | **134** | **22×** |
| 300 random pairs | avg query ms | 0.974 | **0.067** | **~15×** |

Takeaways for the article:
- **Same answer, a fraction of the work.** CH returns the *exact* optimal cost (81.76 min on the far
  pair; `CH == Dijkstra` on every sampled real pair, 0 mismatches — guarded in both `build:ch` and
  `bench:ch`), while touching ~140 nodes instead of sweeping thousands. On the far-corner pair, which
  forces Dijkstra to settle the whole graph, that's a **44× reduction** in nodes settled.
- **Preprocessing is a one-time cost paid at build.** 0.59 s to contract the campus graph; the result
  ships as a 1.71 MB static file, no backend. That's the CH bargain: spend time once offline so every
  query is cheap.
- **Shortcuts are the mechanism.** 11,110 of them — each one a precomputed "skip past a less-important
  node" edge. A query rides shortcuts to leap across the map, then unpacks them back to real paths
  (the unpacking-integrity test proves no phantom edge hides inside one).
- **Honest ceiling:** this is CH on the *static base metric* (departure snapshot). It does not yet
  react to crowding or `hours` — making it do so without rebuilding from scratch is exactly what
  Customizable CH buys in 5c. Numbers above are off-peak/base-weight, directly comparable to the 5a
  table.

Phase 5c (Customizable CH + nested dissection): the mechanism, not a speed race. The showcase is the
*separation* — build the hierarchy's structure once from the graph's shape, then re-weight it per
metric cheaply, without re-contracting.

| step | what | number |
|------|------|--------|
| nested dissection + contraction | metric-INDEPENDENT structure (built once) | 0.05 s · 45,240 shortcuts · `cch.json` **0.35 MB** |
| customization | re-weight the WHOLE hierarchy for a metric | **~22–41 ms** (base / step-free / crowding snapshot) |
| query | same bidirectional upward search as CH | CCH == Dijkstra cost on every sampled pair |

Takeaways for the article:
- **Structure vs weights is the whole idea.** CH bakes the metric into its shortcuts (edge-difference
  ordering + witness searches both need the weights), so a new metric means re-contracting. CCH orders
  nodes by graph *structure* alone — **nested dissection**: recursively split the map with a small
  separator, rank the separator highest — then contracts without weights. The weights arrive later, in
  **customization**: a bottom-up triangle pass fills every shortcut's weight in ~tens of ms. Swap the
  metric, re-run customization, done.
- **This is the honest answer to "how does a router handle crowding / a toggle / a different time?"**
  One structure, customized three ways here (base, step-free, a 09:45 class-change crowding snapshot),
  each verified == Dijkstra. Changing the "Leave at" time in Phase 6 is a re-customization, not a
  rebuild. (Time is handled as a **departure-time snapshot** — frozen at departure, the user-approved
  approach; the arrival-time-accurate router stays the unidirectional Dijkstra/A*.)
- **The step-free access-safety test lands here** (deferred from 5b): customize with the step-free
  metric and every route — including the edges hidden inside unpacked shortcuts — is step-free, because
  a non-step-free edge is priced at Infinity and never survives customization.
- **The trade CCH makes:** 45,240 shortcuts vs plain CH's 11,110 (4.1×), because it adds shortcuts
  unconditionally (no witness pruning) on a structure-only order. That's the cost of metric
  independence — and at campus scale it's cheap (a 0.35 MB structure). Per the project's framing, the
  point is the mechanism, not shaving query time.

## What to capture
- **Phase 4 — spatial index:** captured above.
- **Phase 5 — algorithms:** captured above (5a).
- **Phase 5 — contraction hierarchies:** captured above — plain CH (5b) + Customizable CH & nested dissection (5c, mechanism-focused).
- **Phase 6 — the show:** animation frame rate on a mid-range phone.
