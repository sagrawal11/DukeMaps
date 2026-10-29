// Depth-first search (explicit stack): plunges down one branch as far as it can, backtracking only
// when stuck. It finds *a* path but almost never a good one — the route wanders wherever adjacency
// order happened to lead. It's here purely as the worst case the cost-aware algorithms improve on.
// Access-aware: unusable edges are skipped (and recorded).
import type { RoutingGraph, WeightFn } from './routing'
import { reconstruct } from './path'
import type { Trace, TraceEvent, AlgoStats } from './trace'

export function dfs(rg: RoutingGraph, sourceId: number, targetId: number, opts: { weight: WeightFn }): Trace {
  const events: TraceEvent[] = []
  const stats: AlgoStats = { nodesSettled: 0, edgesRelaxed: 0, pushes: 0, skipped: 0, found: false }
  const sIdx = rg.indexOf.get(sourceId)
  const tIdx = rg.indexOf.get(targetId)
  const n = rg.nodes.length
  if (sIdx === undefined || tIdx === undefined) return { algo: 'dfs', events, stats, route: null }

  const prev = new Int32Array(n).fill(-1)
  const prevEdge = new Int32Array(n).fill(-1)
  const seen = new Uint8Array(n)
  const stack: number[] = [sIdx]
  events.push({ type: 'push', node: sourceId })
  stats.pushes++

  while (stack.length > 0) {
    const u = stack.pop() as number
    if (seen[u]) continue // may have been pushed more than once before first visit
    seen[u] = 1
    events.push({ type: 'settle', node: rg.nodes[u].id })
    stats.nodesSettled++
    if (u === tIdx) {
      stats.found = true
      events.push({ type: 'found', node: targetId })
      break
    }
    for (const arc of rg.adj[u]) {
      if (!Number.isFinite(opts.weight(arc.edgeIdx, 0))) {
        events.push({ type: 'skip', edge: rg.edges[arc.edgeIdx].id })
        stats.skipped++
        continue
      }
      if (seen[arc.to]) continue
      if (arc.to !== sIdx && prev[arc.to] === -1) {
        prev[arc.to] = u // first discovery wins; the prev chain is one valid s–t path
        prevEdge[arc.to] = arc.edgeIdx
        events.push({ type: 'relax', edge: rg.edges[arc.edgeIdx].id })
        stats.edgesRelaxed++
      }
      events.push({ type: 'push', node: rg.nodes[arc.to].id })
      stats.pushes++
      stack.push(arc.to)
    }
  }
  return { algo: 'dfs', events, stats, route: stats.found ? reconstruct(rg, prev, prevEdge, sIdx, tIdx, opts.weight) : null }
}
