# Nested-dissection experiments (CCH node order)

Graph: **15304 nodes / 17459 edges**. Measured over **1000 random pairs**, base metric. Correctness holds for any order (all self-checks below pass), so the order only changes efficiency. Produced by `npx tsx scripts/experiment-dissection.ts` on 2026-10-30.

Region sizes (nodes): `athletic`=416, `graduate`=316, `apartments`=170, `east`=970, `west`=2379, `__connector`=11053. Importance (ascending, user-given): athletic < hospital < graduate < apartments < east < west.

| strategy | shortcuts | up/node | settled/query | climb avg·max | query µs | vs base (settled) | self-check |
|---|--:|--:|--:|--:|--:|--:|:--:|
| geometric | 76552 | 6.14 | 228 | 167·269 | 450 | — | ✓ |
| region-imp, conn-last | 116659 | 8.76 | 400 | 338·921 | 410 | +75% | ✓ |
| region-imp, conn-first | 136265 | 10.04 | 738 | 288·902 | 710 | +223% | ✓ |
| region-imp-REV, conn-last | 116114 | 8.73 | 402 | 340·926 | 353 | +76% | ✓ |
| region, NO geo-within | 621326 | 41.74 | 5016 | 3148·9444 | 6011 | +2097% | ✓ |
| boundary-sep last | 94810 | 7.34 | 396 | 170·406 | 406 | +73% | ✓ |
| sweep (no dissection) | 427487 | 29.07 | 5982 | 3873·11243 | 7534 | +2520% | ✓ |

## Findings

- **Winner: `geometric`** — 228 settled/query, 76552 shortcuts. The campus-aware orders do NOT beat it.
- The drawn regions cover only **28%** of nodes; **72%** fall outside every polygon ("connectors"). Forcing that large a set to the TOP of the hierarchy is backwards for CH (it wants a small important core), which is why every campus-aware variant loses to plain geometric.
- Importance direction barely matters (conn-last vs REV are within noise). Geometric-within is essential (removing it explodes shortcuts/settled ~8×+). connectors-last beats connectors-first.
- Takeaway: geometric nested dissection already finds near-optimal SMALL separators automatically. To beat it, regions would have to tightly partition ALL nodes (no big connector gap) with small boundaries between them — hand-drawn campus outlines don't.

## How each was dissected

- **geometric** — baseline: geometric nested dissection over the whole graph (current production)
- **region-imp, conn-last** — regions least→most important (athletic→west), geometric within each; connectors (outside all polygons) contracted LAST
- **region-imp, conn-first** — control: same as above but connectors contracted FIRST (lowest rank)
- **region-imp-REV, conn-last** — control: regions most→least important (west→athletic), connectors last
- **region, NO geo-within** — control: regions by importance + connectors last, but nodes WITHIN a block only coord-sorted (no recursive bisection)
- **boundary-sep last** — true separator: interiors (grouped by importance, geometric) first; every inter-region boundary node contracted LAST
- **sweep (no dissection)** — control: contract west→east by longitude with no dissection at all (shows what order discipline buys)

_shortcuts_ = extra arcs beyond the original graph (fewer = leaner hierarchy, faster customize). _settled/query_ = nodes the CH search finalizes per query (the deterministic measure of search work). _climb_ = elimination-tree climb length |s→apex|+|t→apex| (avg·max; the inset-tree depth). _query µs_ includes trace building (matches the app's on-screen number), so it's noisier than _settled_.
