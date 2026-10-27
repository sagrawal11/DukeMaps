# DukeMaps — build brief

## What this is
DukeMaps is a walking-directions web app for Duke's campus. It is a portfolio piece. Its job is
to show that I deeply understand the search algorithms and techniques behind Google Maps.

A visitor searches two places on campus. They then watch the routing algorithms work: each
algorithm's exploration animates across the campus map. Then the final route appears with walk
time, distance, and directions.

DukeMaps improves on Google Maps for campus in three ways:
- It uses paths Google doesn't know about: cut-throughs, dorm and building passages,
  informal paths.
- It models crowding around academic buildings when classes let out.
- It has Duke-specific route toggles, like Google's "avoid tolls," driven by where the user
  lives and what their card can open.

It links to my Substack, Fundamental Stack (fundamentalstack.substack.com), where my article
"How Google Maps Works" explains everything in depth. It should feel like a polished, finished
product someone can use on their phone, not a demo notebook.

## Non-negotiables
- **I write the algorithms, not a library.** Implement the graph, BFS, DFS, Dijkstra, A*,
  bidirectional Dijkstra, contraction hierarchies, and the spatial index yourself in TypeScript.
  No routing, graph, or spatial-index libraries. A map-rendering library for the basemap is fine.
- **Algorithms emit traces.** An ordered list of events: node pushed to frontier, node settled,
  edge relaxed, edge skipped for access, shortcut used. The UI replays traces for the animation.
  Algorithms stay pure and testable; animation is purely a frontend concern.
- **Correctness is tested.**
  - Dijkstra, A*, bidirectional, and CH must return identical costs on thousands of random pairs
    under every access profile.
  - Every algorithm has a tiny hand-built graph test with a known answer.
  - No route may ever use an edge the active profile can't traverse, including inside unpacked
    CH shortcuts.
- **Fully static site.** Runs entirely in the browser and deploys to GitHub Pages. No backend,
  no API keys.
- **Never map building interiors.** Buildings and dorms are modeled as door-to-door passage
  edges between entrances.
- **Don't invent Duke facts.** Bounding boxes, building names, class end times, dorm swipe rules,
  and which paths are real all come from me. Ask; never guess.

## Stack
- TypeScript + Vite. Vitest for tests. Node scripts for the data pipeline.
- MapLibre GL for the basemap, using a Protomaps PMTiles extract of the Duke area, hosted as a
  static file (no tile API key). Draw the graph and animations on an overlay layer (canvas or
  WebGL) so thousands of nodes animate smoothly.
- Graph data, my edits, configs, and prebuilt hierarchies are committed as JSON so builds are
  reproducible.

## How to work with me
- One phase at a time. Start each phase in plan mode and show me the plan before coding.
- At the end of each phase:
  - tests pass,
  - a short summary of what was built and any decisions I should know about,
  - a commit with a descriptive message,
  - stop and wait for me to say "next."
- Explain non-obvious algorithm code in comments and in the phase summary. I need to be able to
  rebuild each algorithm on paper and explain it in my article.
- Keep `notes/measurements.md` updated with real numbers (nodes explored, query times,
  preprocessing time, speedups, data sizes) and the command that produced them. I'll cite these.
- Keep `notes/google-vs-dukemaps.md`: for each technique, what Google has publicly documented
  (with a source link) versus what's an industry-standard technique Google may or may not use.
  Never blur the two.

## Configs I will fill in (create them with clear placeholders and comments)
- `config/campus.json`: bounding boxes for West, Central, East.
- `config/schedule.json`:
  - class end times (the same every weekday),
  - crowding window length, ramp shape, peak multiplier, radius,
  - the list of academic buildings that cause crowding.
- `config/access.json`:
  - permissions (e.g., "west_dorm_access", "east_dorm_access", "duke_card", "after_hours_card"),
  - housing profiles (single select: e.g., East, West, Central, Off-campus, Visitor), each
    granting a set of permissions,
  - independent toggles (e.g., "Duke card," "Step-free only," "Avoid indoor routes").
- `config/aliases.json`: campus nicknames mapped to places (e.g., "WU," "the Chapel").
- `config/presets.json`: demo routes for the landing screen.

## Phases

### Phase 0 — Scaffold
- Repo layout:
  - `src/` (app),
  - `src/algorithms/`,
  - `src/graph/`,
  - `scripts/` (pipeline),
  - `editor/` (dev-only editor),
  - `data/raw`, `data/processed`,
  - `config/`, `notes/`, `tests/`.
- npm scripts:
  - `fetch` (OSM import),
  - `build:graph` (merge OSM + my edits),
  - `build:ch` (hierarchies),
  - `dev`, `editor`, `test`, `bench`, `deploy`,
  - `rebuild` (all data steps in order).
- Write `CLAUDE.md` summarizing this brief, the phase rules, and the non-negotiables, so every
  future session stays consistent.
- Create the config files with placeholders.

### Phase 1 — Base map import and graph
- Pull walkable ways from the OpenStreetMap Overpass API for the bounding boxes in
  `config/campus.json`: footways, paths, steps, sidewalks, crossings, pedestrian/service roads,
  tagged indoor corridors. Also pull named buildings for the place index.
- Save raw responses with timestamps.
- Build the graph:
  - split ways at shared nodes so intersections are graph nodes,
  - haversine edge lengths,
  - base weight = walking time (configurable walking speed, stairs penalty).
- Edge schema:
  - `source` (osm | mine),
  - `kind` (sidewalk, stairs, indoor, passage, lawn, …),
  - `requires: string[]` (permissions needed; empty = public),
  - `hours` (optional open intervals),
  - `step_free: boolean`,
  - `geometry`.
- Store OSM data and my edits separately, merged at build time. My edits are a replayable edit
  log, so re-importing OSM never loses my work. If an edit references an OSM element that
  disappeared, report it rather than failing silently.
- Validate: report connected components and dangling stubs, and render the islands so I can see
  them.
- Include OpenStreetMap (ODbL) attribution in the app.

### Phase 2 — The editor (the longest part of this project happens here; make it fast and pleasant)
- A dev-only page with the basemap and the current graph drawn on top.
- Tools:
  - add node,
  - draw edge (snaps to nearby nodes),
  - split edge,
  - move node,
  - delete,
  - undo/redo.
- An edge inspector to set kind, requires, hours, and step_free. Must support multi-select and
  bulk edits.
- An entrance tool:
  - place entrance nodes on a building outline,
  - connect pairs with a passage edge,
  - set requires/hours/step_free in one panel.
  Permission choices come from `config/access.json`.
- Keyboard shortcuts for every tool.
- Autosave to `data/my_edits.json`.
- Audit view modes. Color edges by:
  - source,
  - required permission,
  - step-free status,
  - connected component.
  Also flag edges missing attributes.
- GPX import: load a track I recorded walking, preview where it diverges from the graph, and
  accept it as new edges.

### Phase 3 — Time: class-change crowding and hours
- Edges within the configured radius of academic buildings get a time-dependent multiplier. It
  ramps up, peaks right after each class end time, and decays. Weekends are off.
- Edges with `hours` are unusable outside their open intervals.
- Weights are evaluated at the time the walker reaches the edge (time-dependent routing), not
  just at departure. Explain which algorithms stay correct under this (FIFO property) and how.
- The app has a "Leave at" time control, defaulting to now.
- Find real pairs whose best route changes at class change or after hours, and propose them as
  presets.

### Phase 4 — Places and snapping
- A place index from OSM building names plus `config/aliases.json`. Search box with fuzzy
  matching and autocomplete.
- Tapping anywhere on the map also works: snap to the nearest point on the nearest usable edge.
- Build the spatial index yourself:
  - a linear-scan baseline,
  - then a quadtree or R-tree (pick one and justify it).
  Benchmark and record the speedup.

### Phase 5 — The algorithms
Implement each one with traces and stats (nodes explored, edges relaxed, time, route cost):
- **BFS:** fewest hops, which is not the fastest walk.
- **DFS:** finds a path, rarely a good one.
- **Dijkstra** with a binary heap.
- **A\*** with heuristic = straight-line distance ÷ max possible walking speed. Explain why
  this is admissible.
- **Bidirectional Dijkstra.**
- **Contraction hierarchies:**
  - node ordering via edge difference,
  - witness searches,
  - shortcut edges,
  - bidirectional upward query,
  - path unpacking.

Access rules:
- An edge counts as absent for a query if:
  - the active profile lacks any permission in its `requires`,
  - step-free is on and the edge isn't step-free,
  - "avoid indoor" is on and it's a passage/indoor edge, or
  - it's closed at the arrival time.
- Traces record skipped edges.

CH with access profiles:
- Build one hierarchy per housing profile × toggle combination at build time and ship them all.
  Report total build time and data size.
- If the combinations grow too large, stop and propose Customizable Contraction Hierarchies,
  with the tradeoff, before implementing.

CH with time-dependent weights:
- Propose an approach (e.g., CH on base weights with a time-dependent fallback) and explain the
  tradeoff to me before deciding.

### Phase 6 — The show (the core experience)
- After a search, replay each algorithm's trace on the map in sequence:
  - frontier nodes appear as discovered,
  - settled nodes fill in,
  - the current node is highlighted,
  - access-skipped edges briefly appear faded (not red),
  - then that algorithm's route draws.
- Each algorithm gets a one-sentence caption: what it's doing and why it beats the last one.
- A live stats panel per algorithm: nodes explored, time, and whether its route is optimal.
- End state: the final route on a clean map with walk time, distance, and step-by-step
  directions (including "enter Building X, exit by the east doors" for passages).
- Controls:
  - play/pause,
  - speed,
  - skip to result,
  - choose which algorithms to show,
  - "Race" mode with algorithms side by side on split panes.
- An "Instant" toggle for people who just want directions. Remember it locally.
- Route options:
  - a profile picker ("I live on…", default Visitor),
  - toggle chips like Google Maps' route options,
  - persist both locally.
- "What if?": the user's route next to the same trip under another profile, with the time
  difference.
- Honor prefers-reduced-motion.
- Smooth 60fps animation on a mid-range phone. Profile it and report.

### Phase 7 — Polish and ship
- Mobile-first layout and design. Clean, modern, distinctive; not a generic template look.
- An "About" panel: what DukeMaps is, the algorithms in a few sentences, and a link to my
  Substack article.
- "Google Maps vs DukeMaps": preset routes where my paths or toggles save time. Be honest; also
  include presets where they don't.
- Demo presets on the landing screen so a visitor sees something impressive in one tap.
- Lighthouse pass (performance and accessibility at 90+).
- README with screenshots, a GIF of the show, and an explanation of the architecture.
- Deploy to GitHub Pages via a GitHub Action.

## Definition of done
- Deployed URL works on desktop and phone.
- All tests pass, including:
  - cross-algorithm equal-cost tests under every profile,
  - the access-safety test.
- `npm run rebuild` re-imports OSM, replays my edits, rebuilds graphs and hierarchies, and
  `npm run deploy` ships it.
- `notes/measurements.md` and `notes/google-vs-dukemaps.md` are complete.

Start with Phase 0. Show me the plan first.