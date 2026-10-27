# DukeMaps — project guide for Claude

DukeMaps is a walking-directions web app for Duke's campus and a **portfolio piece**: its
job is to show deep understanding of the search algorithms behind Google Maps. A visitor
searches two campus places, watches each routing algorithm explore the map, then sees the
final route with walk time, distance, and directions. Full spec: `BRIEF.md`.

## Non-negotiables (do not violate)
- **Write the algorithms, not a library.** Implement the graph, BFS, DFS, Dijkstra, A\*,
  bidirectional Dijkstra, contraction hierarchies, and the spatial index by hand in
  TypeScript. No routing / graph / spatial-index libraries. A map-rendering library for
  the basemap is fine.
- **Algorithms emit traces** — an ordered list of events (node pushed to frontier, node
  settled, edge relaxed, edge skipped for access, shortcut used). The UI replays traces for
  the animation. Algorithms stay pure and testable; animation is purely a frontend concern.
- **Correctness is tested.** Dijkstra, A\*, bidirectional, and CH must return identical
  costs on thousands of random pairs under every access profile. Each algorithm also has a
  tiny hand-built graph test with a known answer. No route may ever use an edge the active
  profile can't traverse — including inside unpacked CH shortcuts.
- **Fully static site.** Runs entirely in the browser, deploys to GitHub Pages. No backend,
  no API keys.
- **Never map building interiors.** Buildings and dorms are modeled as door-to-door passage
  edges between entrances.
- **Don't invent Duke facts.** Bounding boxes, building names, class end times, dorm swipe
  rules, and which paths are real all come from the user. Ask; never guess. The
  `config/*.json` files are placeholders the user fills in.

## Stack
- TypeScript + Vite. Vitest for tests. Node scripts (via `tsx`) for the data pipeline.
- MapLibre GL basemap over a Protomaps PMTiles extract of Duke, hosted as a static file (no
  tile API key). Draw the graph and animations on an overlay (canvas/WebGL) so thousands of
  nodes animate smoothly. (MapLibre/PMTiles get added in Phase 1 when the map is wired.)
- Graph data, user edits, configs, and prebuilt hierarchies are committed as JSON so builds
  are reproducible.

## Layout
`src/` app · `src/algorithms/` · `src/graph/` · `scripts/` pipeline · `editor/` dev-only
editor · `data/raw` (gitignored, re-fetchable) · `data/processed` (committed) · `config/` ·
`notes/` · `tests/`.

## npm scripts
`dev`, `editor`, `build`, `preview`, `test`, `typecheck`, `fetch` (OSM import), `build:graph`
(merge OSM + edits), `build:ch` (hierarchies), `bench`, `rebuild` (fetch → build:graph →
build:ch), `deploy` (GitHub Pages — wired in Phase 7).

## How to work with the user
- **One phase at a time.** Start each phase in **plan mode**; show the plan before coding.
- At the end of each phase: tests pass → a short summary of what was built + any decisions →
  a descriptive commit → **stop and wait for the user to say "next."**
- Explain non-obvious algorithm code in comments and in the phase summary — the user must be
  able to rebuild each algorithm on paper and explain it in the article.
- Keep `notes/measurements.md` updated with real numbers (nodes explored, query times,
  preprocessing time, speedups, data sizes) and the command that produced each.
- Keep `notes/google-vs-dukemaps.md`: per technique, what Google has publicly documented
  (with a source link) vs what's an industry-standard technique Google may or may not use.
  Never blur the two.
- Include OpenStreetMap (ODbL) attribution in the app.

## Phases
0 Scaffold (done) · 1 OSM import + graph · 2 Editor · 3 Time: crowding + hours · 4 Places +
spatial index · 5 Algorithms · 6 The show · 7 Polish + ship. See `BRIEF.md` for each phase's
detail and the definition of done.
