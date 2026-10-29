// Breadth-first search: explores the graph in rings of equal hop-count, so the path it finds uses
// the FEWEST EDGES. On a walking network that's usually NOT the fastest route — a 2-hop path along
// two long roads beats a 5-hop path of short cut-throughs in hop-count while losing badly on time.
// That gap is the whole point of showing BFS first. Access-aware: unusable edges are skipped (and
// recorded), evaluated at departure since BFS doesn't track arrival time.
import type { RoutingGraph, WeightFn } from './routing'
import { reconstruct } from './path'
import type { Trace, TraceEvent, AlgoStats } from './trace'

export function bfs(rg: RoutingGraph, sourceId: number, targetId: number, opts: { weight: WeightFn }): Trace {
  const events: TraceEvent[] = []
  const stats: AlgoStats = { nodesSettled: 0, edgesRelaxed: 0, pushes: 0, skipped: 0, found: false }
  const sIdx = rg.indexOf.get(sourceId)
  const tIdx = rg.indexOf.get(targetId)
  const n = rg.nodes.length
  if (sIdx === undefined || tIdx === undefined) return { algo: 'bfs', events, stats, route: null }

  const prev = new Int32Array(n).fill(-1)
  const prevEdge = new Int32Array(n).fill(-1)
  const seen = new Uint8Array(n)
  const queue: number[] = [sIdx]
  seen[sIdx] = 1
  events.push({ type: 'push', node: sourceId })
  stats.pushes++

  let head = 0 // index into queue = FIFO without shift()
  while (head < queue.length) {
    const u = queue[head++]
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
      seen[arc.to] = 1
      prev[arc.to] = u
      prevEdge[arc.to] = arc.edgeIdx
      events.push({ type: 'relax', edge: rg.edges[arc.edgeIdx].id })
      stats.edgesRelaxed++
      events.push({ type: 'push', node: rg.nodes[arc.to].id })
      stats.pushes++
      queue.push(arc.to)
    }
  }
  return { algo: 'bfs', events, stats, route: stats.found ? reconstruct(rg, prev, prevEdge, sIdx, tIdx, opts.weight) : null }
}
