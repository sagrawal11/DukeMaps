// Dijkstra's algorithm with a binary min-heap. Settles nodes in increasing order of best-known cost
// from the source; because edge costs are non-negative, the first time a node is popped its cost is
// final. This is the optimum baseline every later algorithm is measured against. Time-dependent:
// each edge is priced at dist[u] — the instant the walker reaches it — which stays correct because
// the crowding model is FIFO (see src/graph/time.ts).
import type { RoutingGraph, WeightFn } from './routing'
import { MinHeap } from './heap'
import { reconstruct } from './path'
import type { Trace, TraceEvent, AlgoStats } from './trace'

export function dijkstra(rg: RoutingGraph, sourceId: number, targetId: number, opts: { weight: WeightFn }): Trace {
  const events: TraceEvent[] = []
  const stats: AlgoStats = { nodesSettled: 0, edgesRelaxed: 0, pushes: 0, skipped: 0, found: false }
  const sIdx = rg.indexOf.get(sourceId)
  const tIdx = rg.indexOf.get(targetId)
  const n = rg.nodes.length
  if (sIdx === undefined || tIdx === undefined) return { algo: 'dijkstra', events, stats, route: null }

  const dist = new Float64Array(n).fill(Infinity)
  const settled = new Uint8Array(n)
  const prev = new Int32Array(n).fill(-1)
  const prevEdge = new Int32Array(n).fill(-1)
  const heap = new MinHeap()

  dist[sIdx] = 0
  heap.push(sIdx, 0)
  events.push({ type: 'push', node: sourceId })
  stats.pushes++

  while (heap.size > 0) {
    const u = heap.pop() as number
    if (settled[u]) continue // guard (decrease-key keeps the heap clean, but belt-and-suspenders)
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
      const w = opts.weight(arc.edgeIdx, dist[u]) // priced at the arrival time at u
      if (!Number.isFinite(w)) {
        events.push({ type: 'skip', edge: rg.edges[arc.edgeIdx].id })
        stats.skipped++
        continue
      }
      const nd = dist[u] + w
      if (nd < dist[arc.to]) {
        dist[arc.to] = nd
        prev[arc.to] = u
        prevEdge[arc.to] = arc.edgeIdx
        heap.push(arc.to, nd) // push or decrease-key
        events.push({ type: 'relax', edge: rg.edges[arc.edgeIdx].id })
        stats.edgesRelaxed++
        events.push({ type: 'push', node: rg.nodes[arc.to].id })
        stats.pushes++
      }
    }
  }
  return { algo: 'dijkstra', events, stats, route: stats.found ? reconstruct(rg, prev, prevEdge, sIdx, tIdx, opts.weight) : null }
}
