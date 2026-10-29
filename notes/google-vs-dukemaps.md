# Google Maps vs DukeMaps — techniques

For each technique, separate what Google has **publicly documented** (with a source link)
from what is an **industry-standard** technique Google may or may not use. Never blur the
two.

| Technique | Google — publicly documented (source) | Industry-standard (Google may/may not use) | DukeMaps implementation |
|-----------|----------------------------------------|---------------------------------------------|-------------------------|
| Graph model of the map | | | |
| Dijkstra | | | |
| A\* (straight-line heuristic) | | | |
| Bidirectional search | | | |
| Contraction hierarchies | | | |
| Spatial index (quadtree / R-tree) | | | |
| Time-dependent weights | Predictive + live **traffic** for *driving* ETAs (ML/graph nets). Google does **not** publicly document pedestrian class-change crowding. Source: DeepMind, "Traffic prediction with advanced Graph Neural Networks" (2020) — _confirm exact URL_. | Time-dependent shortest paths on **FIFO** networks: Dijkstra/A\* stay optimal iff the network is no-overtaking (classical: Dreyfus 1969; Orda & Rom 1990). | A crowding multiplier near academic buildings that peaks just after class-end times, plus `hours` gating, evaluated at **arrival** time. FIFO is preserved because the bump's decay slope stays above −1/base for short campus edges (derivation in `src/graph/time.ts`). |

_Fill in with sources as each technique lands (Phases 4-6)._
