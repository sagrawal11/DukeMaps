# Nested-dissection experiments (CCH node order)

Graph **15304 nodes / 17459 edges**. 1000 eval pairs/distribution, base metric. Correctness holds for any order (self-checks ✓). `npx tsx scripts/experiment-dissection.ts`, 2026-10-30.

Region sizes: `athletic`=416, `graduate`=316, `apartments`=170, `east`=970, `west`=2379, `__connector`=11053. Importance (asc): athletic < hospital < graduate < apartments < east < west.

**realistic** = 70% of pairs both-endpoints-in-a-region (importance-weighted, west likeliest) + 30% uniform; 177/1000 fell within one region. Query-aware orders learn node usage from a **separate** 3000-query training sample (hot=11322 nodes ever on a path, cold=3982 never).

## Realistic distribution (what actually gets searched)

| strategy | shortcuts | up/node | settled/query | climb avg·max | query µs | vs base | self-check |
|---|--:|--:|--:|--:|--:|--:|:--:|
| geometric | 76552 | 6.14 | 210 | 158·272 | 161 | — | ✓ |
| region-imp, conn-last | 116659 | 8.76 | 539 | 425·925 | 444 | +157% | ✓ |
| boundary-sep last | 94810 | 7.34 | 318 | 170·379 | 317 | +52% | ✓ |
| query-aware hot/cold | 123696 | 9.22 | 430 | 466·1117 | 348 | +105% | ✓ |
| query-aware graded | 95063 | 7.35 | 391 | 235·660 | 378 | +86% | ✓ |
| query-aware hot-ND, cold-flat | 124475 | 9.27 | 431 | 466·1117 | 355 | +105% | ✓ |

## Uniform distribution (reference)

| strategy | shortcuts | up/node | settled/query | climb avg·max | query µs | vs base | self-check |
|---|--:|--:|--:|--:|--:|--:|:--:|
| geometric | 76552 | 6.14 | 227 | 163·266 | 191 | — | ✓ |
| region-imp, conn-last | 116659 | 8.76 | 397 | 341·912 | 332 | +75% | ✓ |
| boundary-sep last | 94810 | 7.34 | 399 | 169·404 | 416 | +76% | ✓ |
| query-aware hot/cold | 123696 | 9.22 | 498 | 508·1156 | 399 | +119% | ✓ |
| query-aware graded | 95063 | 7.35 | 530 | 309·711 | 488 | +134% | ✓ |
| query-aware hot-ND, cold-flat | 124475 | 9.27 | 499 | 509·1178 | 412 | +120% | ✓ |

## Findings

- **Realistic winner: `geometric`** (210 settled/query, — vs geometric). Uniform winner: `geometric`.
- Query-aware orders learn the real traffic network from a training sample and rank those nodes high; the geographic region blocks (28% of nodes in regions, 72% outlying connectors) can't, which is why they trail.

## How each was dissected

- **geometric** — baseline: geometric nested dissection over the whole graph (current production)
- **region-imp, conn-last** — regions least→most important (athletic→west), geometric within; connectors (outside all polygons) LAST
- **boundary-sep last** — interiors (by importance, geometric) first; every inter-region boundary node LAST
- **query-aware hot/cold** — QUERY-AWARE: nodes never on a sampled realistic shortest path (cold) contracted FIRST (geometric); nodes that are (hot) LAST (geometric). The real traffic network becomes the high-rank core.
- **query-aware graded** — QUERY-AWARE: rank strictly by usage (rarely-on-a-path first → most-used last); geometric order breaks ties within equal usage.
- **query-aware hot-ND, cold-flat** — QUERY-AWARE: cold nodes coord-sorted (cheap, they barely matter), hot nodes get a full geometric sub-dissection and go LAST.

_settled/query_ = nodes finalized per query (deterministic). _climb_ = elimination-tree climb |s→apex|+|t→apex|. _query µs_ includes trace building (matches the app's number).
