// Bidirectional search: grow a frontier forward from the source and another backward from the
// target at the same time, stopping once they provably can't beat the best meeting found. Walking
// edges are undirected, so the backward search reuses the same adjacency. Meeting in the middle
// explores far fewer nodes than one search sweeping all the way across.
//
// biDijkstra uses zero potentials. biAStar guides each side — and here's the subtlety worth a whole
// article paragraph: the "obvious" bidirectional A* (forward keyed by distance-to-target, backward
// by distance-to-source) runs the two halves on INCOMPATIBLE cost landscapes and its stopping rule
// is wrong. The fix is BALANCED potentials pF(v) = (h_t(v) − h_s(v)) / 2 and pB(v) = −pF(v). Because
// pF + pB = 0 everywhere, the halves share one consistent landscape and the clean stop
// "min keyF + min keyB ≥ best-so-far" is valid for both algorithms.
//
// Note: bidirectional (like CH) prices edges at the DEPARTURE-time metric snapshot (elapsed = 0) —
// the backward search can't know the walker's arrival time at a mid-path node. True time-dependent
// bidirectional routing is the job of CCH customization in Phase 5c.
import type { RoutingGraph, WeightFn, Heuristic } from './routing'
import { makeHeuristic } from './routing'
import { MinHeap } from './heap'
import type { Trace, TraceEvent, AlgoStats, RouteResult } from './trace'

const ZERO: Heuristic = () => 0

function bidirectional(
  rg: RoutingGraph,
  sourceId: number,
  targetId: number,
  weight: WeightFn,
  pF: Heuristic,
  pB: Heuristic,
  algo: string,
): Trace {
  const events: TraceEvent[] = []
  const stats: AlgoStats = { nodesSettled: 0, edgesRelaxed: 0, pushes: 0, skipped: 0, found: false }
  const sIdx = rg.indexOf.get(sourceId)
  const tIdx = rg.indexOf.get(targetId)
  const n = rg.nodes.length
  if (sIdx === undefined || tIdx === undefined) return { algo, events, stats, route: null }

  const distF = new Float64Array(n).fill(Infinity)
  const distB = new Float64Array(n).fill(Infinity)
  const settledF = new Uint8Array(n)
  const settledB = new Uint8Array(n)
  const prevF = new Int32Array(n).fill(-1)
  const prevEdgeF = new Int32Array(n).fill(-1)
  const prevB = new Int32Array(n).fill(-1)
  const prevEdgeB = new Int32Array(n).fill(-1)
  const heapF = new MinHeap()
  const heapB = new MinHeap()

  distF[sIdx] = 0
  heapF.push(sIdx, pF(sIdx))
  events.push({ type: 'push', node: sourceId, side: 'f' })
  distB[tIdx] = 0
  heapB.push(tIdx, pB(tIdx))
  events.push({ type: 'push', node: targetId, side: 'b' })
  stats.pushes += 2

  let mu = Infinity // best s-t cost found so far (an upper bound that tightens to the optimum)
  let meetF = -1
  let meetB = -1
  let meetEdge = -1 // the edge joining the two halves, or -1 when they meet at a single node

  const expand = (side: 'f' | 'b'): void => {
    const heap = side === 'f' ? heapF : heapB
    const dist = side === 'f' ? distF : distB
    const settled = side === 'f' ? settledF : settledB
    const otherSettled = side === 'f' ? settledB : settledF
    const otherDist = side === 'f' ? distB : distF
    const prev = side === 'f' ? prevF : prevB
    const prevEdge = side === 'f' ? prevEdgeF : prevEdgeB
    const pot = side === 'f' ? pF : pB

    const u = heap.pop() as number
    if (settled[u]) return
    settled[u] = 1
    events.push({ type: 'settle', node: rg.nodes[u].id, side })
    stats.nodesSettled++

    if (otherSettled[u] && dist[u] + otherDist[u] < mu) {
      mu = dist[u] + otherDist[u] // the two halves settled the same node
      meetF = u
      meetB = u
      meetEdge = -1
      events.push({ type: 'meet', node: rg.nodes[u].id, side })
    }

    for (const arc of rg.adj[u]) {
      const w = weight(arc.edgeIdx, 0) // departure-time snapshot (see header note)
      if (!Number.isFinite(w)) {
        events.push({ type: 'skip', edge: rg.edges[arc.edgeIdx].id, side })
        stats.skipped++
        continue
      }
      if (otherSettled[arc.to] && dist[u] + w + otherDist[arc.to] < mu) {
        mu = dist[u] + w + otherDist[arc.to] // meeting across the edge u -> arc.to
        if (side === 'f') {
          meetF = u
          meetB = arc.to
        } else {
          meetF = arc.to
          meetB = u
        }
        meetEdge = arc.edgeIdx
        events.push({ type: 'meet', node: rg.nodes[arc.to].id, side })
      }
      if (settled[arc.to]) continue
      const nd = dist[u] + w
      if (nd < dist[arc.to]) {
        dist[arc.to] = nd
        prev[arc.to] = u
        prevEdge[arc.to] = arc.edgeIdx
        heap.push(arc.to, nd + pot(arc.to))
        events.push({ type: 'relax', edge: rg.edges[arc.edgeIdx].id, side })
        stats.edgesRelaxed++
        events.push({ type: 'push', node: rg.nodes[arc.to].id, side })
        stats.pushes++
      }
    }
  }

  while (heapF.size > 0 && heapB.size > 0) {
    if (heapF.peekPriority() + heapB.peekPriority() >= mu) break // neither frontier can improve on mu
    if (heapF.peekPriority() <= heapB.peekPriority()) expand('f')
    else expand('b')
  }

  stats.found = meetF >= 0
  const route = meetF >= 0 ? buildRoute(rg, meetF, meetB, meetEdge, prevF, prevEdgeF, prevB, prevEdgeB, sIdx, tIdx, weight) : null
  return { algo, events, stats, route }
}

// Stitch the forward half (source -> meetF) to the backward half (meetB -> target), optionally
// joined by meetEdge, then re-price the whole path forward so the reported cost is consistent.
function buildRoute(
  rg: RoutingGraph,
  meetF: number,
  meetB: number,
  meetEdge: number,
  prevF: Int32Array,
  prevEdgeF: Int32Array,
  prevB: Int32Array,
  prevEdgeB: Int32Array,
  sIdx: number,
  tIdx: number,
  weight: WeightFn,
): RouteResult {
  const empty: RouteResult = { nodes: [], edges: [], costS: Infinity, distanceM: 0 }

  const fNodes: number[] = []
  const fEdges: number[] = []
  let cur = meetF
  while (cur !== sIdx) {
    fNodes.push(cur)
    fEdges.push(prevEdgeF[cur])
    cur = prevF[cur]
    if (cur === -1) return empty
  }
  fNodes.push(sIdx)
  fNodes.reverse()
  fEdges.reverse()

  const bNodes: number[] = []
  const bEdges: number[] = []
  cur = meetB
  while (cur !== tIdx) {
    bEdges.push(prevEdgeB[cur])
    cur = prevB[cur]
    bNodes.push(cur)
    if (cur === -1) return empty
  }

  // meetEdge === -1 means the halves met at a single node (meetF === meetB): no joining edge.
  const nodeSeq = meetEdge === -1 ? [...fNodes, ...bNodes] : [...fNodes, meetB, ...bNodes]
  const edgeSeq = meetEdge === -1 ? [...fEdges, ...bEdges] : [...fEdges, meetEdge, ...bEdges]

  const nodes = nodeSeq.map((i) => rg.nodes[i].id)
  const edges: string[] = []
  let costS = 0
  let distanceM = 0
  for (const ei of edgeSeq) {
    const e = rg.edges[ei]
    costS += weight(ei, costS)
    distanceM += e.lengthM
    edges.push(e.id)
  }
  return { nodes, edges, costS, distanceM }
}

export function biDijkstra(rg: RoutingGraph, sourceId: number, targetId: number, opts: { weight: WeightFn }): Trace {
  return bidirectional(rg, sourceId, targetId, opts.weight, ZERO, ZERO, 'bidijkstra')
}

export function biAStar(rg: RoutingGraph, sourceId: number, targetId: number, opts: { weight: WeightFn }): Trace {
  const hT = makeHeuristic(rg, targetId) // estimated remaining cost to the target
  const hS = makeHeuristic(rg, sourceId) // ...and to the source, for the backward half
  const pF: Heuristic = (v) => (hT(v) - hS(v)) / 2 // balanced potentials: pF + pB = 0 everywhere
  const pB: Heuristic = (v) => (hS(v) - hT(v)) / 2
  return bidirectional(rg, sourceId, targetId, opts.weight, pF, pB, 'biastar')
}
