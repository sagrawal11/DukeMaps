// A* = Dijkstra guided by a heuristic. The frontier is ordered by g + h, where g is the best-known
// cost from the source and h is the estimated remaining cost to the target. With an admissible,
// consistent heuristic — here great-circle distance ÷ max walking speed, which never overestimates
// remaining time even under crowding — A* returns Dijkstra's exact optimal cost while settling far
// fewer nodes, because the g+h ordering pulls the search toward the target instead of expanding
// uniformly in all directions.
//
// Consistency (why no node needs reopening): for any edge u->v, h(u) - h(v) <= straight-line(u,v) /
// v_max <= cost(u,v). So h never drops faster than real cost accrues, and the first time A* settles
// a node its g is already optimal — exactly like Dijkstra.
import type { RoutingGraph, WeightFn, Heuristic } from './routing'
import { MinHeap } from './heap'
import { reconstruct } from './path'
import type { Trace, TraceEvent, AlgoStats } from './trace'

export function astar(
  rg: RoutingGraph,
  sourceId: number,
  targetId: number,
  opts: { weight: WeightFn; heuristic: Heuristic },
): Trace {
  const events: TraceEvent[] = []
  const stats: AlgoStats = { nodesSettled: 0, edgesRelaxed: 0, pushes: 0, skipped: 0, found: false }
  const sIdx = rg.indexOf.get(sourceId)
  const tIdx = rg.indexOf.get(targetId)
  const n = rg.nodes.length
  if (sIdx === undefined || tIdx === undefined) return { algo: 'astar', events, stats, route: null }

  const g = new Float64Array(n).fill(Infinity) // best-known cost from the source
  const settled = new Uint8Array(n)
  const prev = new Int32Array(n).fill(-1)
  const prevEdge = new Int32Array(n).fill(-1)
  const heap = new MinHeap()

  g[sIdx] = 0
  heap.push(sIdx, opts.heuristic(sIdx)) // priority = g + h, and g=0 here
  events.push({ type: 'push', node: sourceId })
  stats.pushes++

  while (heap.size > 0) {
    const u = heap.pop() as number
    if (settled[u]) continue
    settled[u] = 1
    events.push({ type: 'settle', node: rg.nodes[u].id })
    stats.nodesSettled++
    if (u === tIdx) {
      stats.found = true
      events.push({ type: 'found', node: targetId })
      break
    }
    for (const arc of rg.adj[u]) {
      if (settled[arc.to]) continue
      const w = opts.weight(arc.edgeIdx, g[u])
      if (!Number.isFinite(w)) {
        events.push({ type: 'skip', edge: rg.edges[arc.edgeIdx].id })
        stats.skipped++
        continue
      }
      const ng = g[u] + w
      if (ng < g[arc.to]) {
        g[arc.to] = ng
        prev[arc.to] = u
        prevEdge[arc.to] = arc.edgeIdx
        heap.push(arc.to, ng + opts.heuristic(arc.to)) // f = g + h
        events.push({ type: 'relax', edge: rg.edges[arc.edgeIdx].id })
        stats.edgesRelaxed++
        events.push({ type: 'push', node: rg.nodes[arc.to].id })
        stats.pushes++
      }
    }
  }
  return { algo: 'astar', events, stats, route: stats.found ? reconstruct(rg, prev, prevEdge, sIdx, tIdx, opts.weight) : null }
}
