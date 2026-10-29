// Shared route reconstruction. Every search records, per node, the previous node + the edge used to
// reach it; this walks that chain from target back to source, then a forward pass re-prices each
// edge at the time it's reached (elapsed-so-far) so the reported route cost is self-consistent with
// time-dependent weights. Storing the edge (not just the node) keeps it correct across parallel
// edges. Used by all six algorithms.
import type { RoutingGraph, WeightFn } from './routing'
import type { RouteResult } from './trace'

export function reconstruct(
  rg: RoutingGraph,
  prev: Int32Array,
  prevEdge: Int32Array,
  sIdx: number,
  tIdx: number,
  weight: WeightFn,
): RouteResult {
  const empty: RouteResult = { nodes: [], edges: [], costS: Infinity, distanceM: 0 }
  if (tIdx !== sIdx && prev[tIdx] === -1) return empty

  const idxRev: number[] = []
  const edgeRev: number[] = []
  let cur = tIdx
  while (cur !== sIdx) {
    idxRev.push(cur)
    edgeRev.push(prevEdge[cur])
    cur = prev[cur]
    if (cur === -1) return empty // chain broke (shouldn't happen for a reached target)
  }
  idxRev.push(sIdx)
  const pathIdx = idxRev.reverse()
  const edgeSeq = edgeRev.reverse()

  const nodes = pathIdx.map((i) => rg.nodes[i].id)
  const edges: string[] = []
  let costS = 0
  let distanceM = 0
  for (const ei of edgeSeq) {
    const e = rg.edges[ei]
    costS += weight(ei, costS) // price this edge at the time the walker reaches it
    distanceM += e.lengthM
    edges.push(e.id)
  }
  return { nodes, edges, costS, distanceM }
}
