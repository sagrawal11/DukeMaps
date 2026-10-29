import { describe, it, expect } from 'vitest'
import { MinHeap } from '../src/algorithms/heap'
import { buildRoutingGraph, makeWeight, makeHeuristic } from '../src/algorithms/routing'
import { bfs } from '../src/algorithms/bfs'
import { dfs } from '../src/algorithms/dfs'
import { dijkstra } from '../src/algorithms/dijkstra'
import { astar } from '../src/algorithms/astar'
import { biDijkstra, biAStar } from '../src/algorithms/bidirectional'
import { haversineM } from '../src/graph/geo'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

describe('MinHeap', () => {
  it('pops items in ascending priority order (random stress)', () => {
    const h = new MinHeap()
    const entries = Array.from({ length: 500 }, (_, i) => ({ item: i, p: Math.random() }))
    for (const { item, p } of entries) h.push(item, p)
    const out: number[] = []
    while (h.size > 0) out.push(h.pop() as number)
    const expected = [...entries].sort((a, b) => a.p - b.p).map((e) => e.item)
    expect(out).toEqual(expected)
  })

  it('decrease-key: a smaller re-push floats an item to the top', () => {
    const h = new MinHeap()
    h.push(1, 10)
    h.push(2, 20)
    h.push(3, 30)
    h.push(3, 5) // decrease key of item 3 below everything
    expect(h.pop()).toBe(3)
    expect(h.pop()).toBe(1)
    expect(h.pop()).toBe(2)
  })

  it('ignores a re-push with a larger priority and never duplicates an item', () => {
    const h = new MinHeap()
    h.push(1, 10)
    h.push(1, 99)
    expect(h.size).toBe(1)
    expect(h.pop()).toBe(1)
    expect(h.pop()).toBeUndefined()
  })
})

// A tiny hand-built graph. Node ids sit on a line for coordinates; edge weights are given directly.
// EdgeSpec = [id, from, to, weightS, stepFree?].
type EdgeSpec = [string, number, number, number, boolean?]
function mkGraph(ids: number[], specs: EdgeSpec[]): Graph {
  const nodes: GraphNode[] = ids.map((id) => ({ id, lon: -78.9 + id * 0.001, lat: 36.0 }))
  const edges: GraphEdge[] = specs.map(([id, from, to, weightS, stepFree = true]) => ({
    id,
    source: 'osm',
    from,
    to,
    kind: 'footway',
    stepFree,
    geometry: [
      [-78.9 + from * 0.001, 36.0],
      [-78.9 + to * 0.001, 36.0],
    ],
    lengthM: weightS,
    weightS,
  }))
  return { nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } }
}

function isValidPath(graph: Graph, nodes: number[]): boolean {
  if (nodes.length === 0) return false
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i]
    const b = nodes[i + 1]
    if (!graph.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))) return false
  }
  return true
}

// Two routes from 1 to 5: a short-hop expensive one (1-2-5: 2 hops, cost 20) and a many-hop cheap
// one (1-3-4-5: 3 hops, cost 9). BFS must take the fewest hops; Dijkstra later takes the cheaper.
const hopGraph = mkGraph(
  [1, 2, 3, 4, 5],
  [
    ['a', 1, 2, 10],
    ['b', 2, 5, 10, false], // not step-free — exercises the access test
    ['c', 1, 3, 3],
    ['d', 3, 4, 3],
    ['e', 4, 5, 3],
  ],
)

describe('BFS', () => {
  it('finds the fewest-hop path, even when it costs more time', () => {
    const rg = buildRoutingGraph(hopGraph)
    const t = bfs(rg, 1, 5, { weight: makeWeight(rg) })
    expect(t.route?.nodes).toEqual([1, 2, 5]) // 2 hops, not the cheaper 3-hop route
    expect(t.route?.costS).toBe(20)
    expect(t.stats.found).toBe(true)
  })

  it('skips an edge the step-free toggle forbids (and records the skip)', () => {
    const rg = buildRoutingGraph(hopGraph)
    const t = bfs(rg, 1, 5, { weight: makeWeight(rg, { stepFreeOnly: true }) })
    expect(t.route?.edges).not.toContain('b') // 'b' isn't step-free -> avoided
    expect(t.route?.nodes).toEqual([1, 3, 4, 5]) // forced onto the step-free detour
    expect(t.events.some((e) => e.type === 'skip' && e.edge === 'b')).toBe(true)
  })
})

describe('DFS', () => {
  it('finds a valid source-to-target path', () => {
    const rg = buildRoutingGraph(hopGraph)
    const t = dfs(rg, 1, 5, { weight: makeWeight(rg) })
    expect(t.stats.found).toBe(true)
    expect(t.route?.nodes[0]).toBe(1)
    expect(t.route?.nodes.at(-1)).toBe(5)
    expect(isValidPath(hopGraph, t.route?.nodes ?? [])).toBe(true)
  })
})

// A random connected graph with geographically-consistent weights (weightS = length / 1.4), so the
// great-circle A* heuristic is admissible. A random spanning tree guarantees connectivity, plus
// extra random edges for alternative routes.
function randomGraph(n: number, extraEdges: number): Graph {
  const nodes: GraphNode[] = []
  for (let id = 1; id <= n; id++) nodes.push({ id, lon: -78.95 + Math.random() * 0.03, lat: 36.0 + Math.random() * 0.02 })
  const edges: GraphEdge[] = []
  const add = (a: number, b: number): void => {
    const na = nodes[a - 1]
    const nb = nodes[b - 1]
    const lengthM = haversineM(na.lat, na.lon, nb.lat, nb.lon)
    edges.push({
      id: `e${edges.length}`,
      source: 'osm',
      from: a,
      to: b,
      kind: 'footway',
      stepFree: Math.random() < 0.8,
      geometry: [
        [na.lon, na.lat],
        [nb.lon, nb.lat],
      ],
      lengthM,
      weightS: lengthM / 1.4,
    })
  }
  for (let i = 2; i <= n; i++) add(i, 1 + Math.floor(Math.random() * (i - 1))) // spanning tree -> connected
  for (let k = 0; k < extraEdges; k++) {
    const a = 1 + Math.floor(Math.random() * n)
    const b = 1 + Math.floor(Math.random() * n)
    if (a !== b) add(a, b)
  }
  return { nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } }
}

describe('Dijkstra', () => {
  it('finds the cheapest path, not the fewest-hop one', () => {
    const rg = buildRoutingGraph(hopGraph)
    const d = dijkstra(rg, 1, 5, { weight: makeWeight(rg) })
    expect(d.route?.nodes).toEqual([1, 3, 4, 5]) // cost 9, vs BFS's 2-hop cost-20 route
    expect(d.route?.costS).toBe(9)
  })
})

describe('A* equals Dijkstra (optimality)', () => {
  it('returns identical costs on hundreds of random pairs, settling no more nodes', () => {
    const rg = buildRoutingGraph(randomGraph(80, 140))
    const w = makeWeight(rg)
    let compared = 0
    for (let trial = 0; trial < 400; trial++) {
      const s = 1 + Math.floor(Math.random() * 80)
      const t = 1 + Math.floor(Math.random() * 80)
      if (s === t) continue
      const d = dijkstra(rg, s, t, { weight: w })
      const a = astar(rg, s, t, { weight: w, heuristic: makeHeuristic(rg, t) })
      expect(!!a.route).toBe(!!d.route)
      if (d.route && a.route) {
        expect(a.route.costS).toBeCloseTo(d.route.costS, 6)
        expect(a.stats.nodesSettled).toBeLessThanOrEqual(d.stats.nodesSettled) // the heuristic only helps
        compared++
      }
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('still agrees under the step-free toggle (cost and reachability)', () => {
    const rg = buildRoutingGraph(randomGraph(80, 140))
    const w = makeWeight(rg, { stepFreeOnly: true })
    for (let trial = 0; trial < 300; trial++) {
      const s = 1 + Math.floor(Math.random() * 80)
      const t = 1 + Math.floor(Math.random() * 80)
      if (s === t) continue
      const d = dijkstra(rg, s, t, { weight: w })
      const a = astar(rg, s, t, { weight: w, heuristic: makeHeuristic(rg, t) })
      expect(!!a.route).toBe(!!d.route)
      if (d.route && a.route) expect(a.route.costS).toBeCloseTo(d.route.costS, 6)
    }
  })
})

describe('bidirectional Dijkstra (hand graph)', () => {
  it('finds the cheapest path', () => {
    const rg = buildRoutingGraph(hopGraph)
    const bd = biDijkstra(rg, 1, 5, { weight: makeWeight(rg) })
    expect(bd.route?.costS).toBe(9)
    expect(bd.route?.nodes.at(0)).toBe(1)
    expect(bd.route?.nodes.at(-1)).toBe(5)
    expect(isValidPath(hopGraph, bd.route?.nodes ?? [])).toBe(true)
  })
})

describe('all four optimal algorithms agree (equal-cost)', () => {
  it('Dijkstra == A* == bidirectional Dijkstra == bidirectional A* on random pairs', () => {
    const rg = buildRoutingGraph(randomGraph(90, 170))
    const w = makeWeight(rg)
    let compared = 0
    for (let trial = 0; trial < 500; trial++) {
      const s = 1 + Math.floor(Math.random() * 90)
      const t = 1 + Math.floor(Math.random() * 90)
      if (s === t) continue
      const d = dijkstra(rg, s, t, { weight: w })
      const bd = biDijkstra(rg, s, t, { weight: w })
      const ba = biAStar(rg, s, t, { weight: w })
      expect(!!bd.route).toBe(!!d.route)
      expect(!!ba.route).toBe(!!d.route)
      if (d.route) {
        expect(bd.route!.costS).toBeCloseTo(d.route.costS, 6)
        expect(ba.route!.costS).toBeCloseTo(d.route.costS, 6) // validates the balanced-potential stop
        compared++
      }
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('still agree under the step-free toggle', () => {
    const rg = buildRoutingGraph(randomGraph(90, 170))
    const w = makeWeight(rg, { stepFreeOnly: true })
    for (let trial = 0; trial < 300; trial++) {
      const s = 1 + Math.floor(Math.random() * 90)
      const t = 1 + Math.floor(Math.random() * 90)
      if (s === t) continue
      const d = dijkstra(rg, s, t, { weight: w })
      const bd = biDijkstra(rg, s, t, { weight: w })
      const ba = biAStar(rg, s, t, { weight: w })
      expect(!!bd.route).toBe(!!d.route)
      expect(!!ba.route).toBe(!!d.route)
      if (d.route) {
        expect(bd.route!.costS).toBeCloseTo(d.route.costS, 6)
        expect(ba.route!.costS).toBeCloseTo(d.route.costS, 6)
      }
    }
  })
})
