# Nested-dissection experiments (CCH node order)

Graph **10484 nodes / 12639 edges**. 1000 eval pairs/distribution, base metric. Correctness holds for any order (self-checks ✓). `npx tsx scripts/experiment-dissection.ts`, 2026-10-30.

Region sizes: `athletic`=319, `graduate`=192, `apartments`=112, `east`=901, `west`=1883, `__connector`=7077. Importance (asc): athletic < hospital < graduate < apartments < east < west.

**realistic** = 70% of pairs both-endpoints-in-a-region (importance-weighted, west likeliest) + 30% uniform; 173/1000 fell within one region. Query-aware orders learn node usage from a **separate** 3000-query training sample (hot=7989 nodes ever on a path, cold=2495 never).

## Realistic distribution (what actually gets searched)

| strategy | shortcuts | up/node | settled/query | climb avg·max | query µs | vs base | self-check |
|---|--:|--:|--:|--:|--:|--:|:--:|
| geometric | 61027 | 7.02 | 194 | 153·259 | 167 | — | ✓ |
| region-imp, conn-last | 104009 | 11.12 | 566 | 460·960 | 461 | +192% | ✓ |
| boundary-sep last | 78953 | 8.73 | 303 | 171·367 | 293 | +56% | ✓ |
| query-aware hot/cold | 78684 | 8.71 | 313 | 291·620 | 235 | +61% | ✓ |
| query-aware graded | 87573 | 9.56 | 363 | 208·648 | 352 | +87% | ✓ |
| query-aware hot-ND, cold-flat | 79323 | 8.77 | 313 | 291·624 | 233 | +61% | ✓ |

## Uniform distribution (reference)

| strategy | shortcuts | up/node | settled/query | climb avg·max | query µs | vs base | self-check |
|---|--:|--:|--:|--:|--:|--:|:--:|
| geometric | 61027 | 7.02 | 200 | 153·259 | 149 | — | ✓ |
| region-imp, conn-last | 104009 | 11.12 | 446 | 379·950 | 372 | +122% | ✓ |
| boundary-sep last | 78953 | 8.73 | 349 | 169·378 | 327 | +74% | ✓ |
| query-aware hot/cold | 78684 | 8.71 | 310 | 279·620 | 233 | +55% | ✓ |
| query-aware graded | 87573 | 9.56 | 452 | 264·662 | 419 | +125% | ✓ |
| query-aware hot-ND, cold-flat | 79323 | 8.77 | 311 | 279·618 | 233 | +55% | ✓ |

## Findings

- **Realistic winner: `geometric`** (194 settled/query, — vs geometric). Uniform winner: `geometric`.
- Query-aware orders learn the real traffic network from a training sample and rank those nodes high; the geographic region blocks (28% of nodes in regions, 72% outlying connectors) can't, which is why they trail.

## How each was dissected

- **geometric** — baseline: geometric nested dissection over the whole graph (current production)
- **region-imp, conn-last** — regions least→most important (athletic→west), geometric within; connectors (outside all polygons) LAST
- **boundary-sep last** — interiors (by importance, geometric) first; every inter-region boundary node LAST
- **query-aware hot/cold** — QUERY-AWARE: nodes never on a sampled realistic shortest path (cold) contracted FIRST (geometric); nodes that are (hot) LAST (geometric). The real traffic network becomes the high-rank core.
- **query-aware graded** — QUERY-AWARE: rank strictly by usage (rarely-on-a-path first → most-used last); geometric order breaks ties within equal usage.
- **query-aware hot-ND, cold-flat** — QUERY-AWARE: cold nodes coord-sorted (cheap, they barely matter), hot nodes get a full geometric sub-dissection and go LAST.

_settled/query_ = nodes finalized per query (deterministic). _climb_ = elimination-tree climb |s→apex|+|t→apex|. _query µs_ includes trace building (matches the app's number).
