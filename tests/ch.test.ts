import { describe, it, expect } from 'vitest'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { dijkstra } from '../src/algorithms/dijkstra'
import { buildCH, ch } from '../src/algorithms/ch'
import { haversineM } from '../src/graph/geo'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

// --- helpers (mirror tests/algorithms.test.ts so CH is tested the same way the other six are) ---
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

describe('Contraction Hierarchies — preprocessing', () => {
  it('creates shortcuts on a graph that needs them', () => {
    const g = randomGraph(60, 120)
    const rg = buildRoutingGraph(g)
    const chData = buildCH(rg, makeWeight(rg))
    expect(chData.shortcuts.length).toBeGreaterThan(0)
    for (const sc of chData.shortcuts) {
      expect(sc.via).not.toBe(sc.from)
      expect(sc.via).not.toBe(sc.to)
      expect(sc.w).toBeGreaterThan(0)
    }
    expect(chData.rank.every((r) => r >= 0)).toBe(true) // every node got contracted
  })

  it('adds NO shortcut when a direct witness is as short (triangle)', () => {
    // 1-2-3 = 10, but the direct 1-3 edge costs 8 < 10, so contracting any corner needs no shortcut.
    const g = mkGraph(
      [1, 2, 3],
      [
        ['a', 1, 2, 5],
        ['b', 2, 3, 5],
        ['c', 1, 3, 8],
      ],
    )
    const rg = buildRoutingGraph(g)
    const chData = buildCH(rg, makeWeight(rg))
    expect(chData.shortcuts.length).toBe(0)
    expect(ch(rg, chData, 1, 3, { weight: makeWeight(rg) }).route?.costS).toBeCloseTo(8, 9)
  })
})

describe('Contraction Hierarchies — query', () => {
  it('matches Dijkstra on a tiny hand-built graph (fewest-cost, not fewest-hop)', () => {
    // 1-2-5 is 2 hops costing 20; 1-3-4-5 is 3 hops costing 9. The optimum is the 3-hop route.
    const g = mkGraph(
      [1, 2, 3, 4, 5],
      [
        ['a', 1, 2, 10],
        ['b', 2, 5, 10],
        ['c', 1, 3, 3],
        ['d', 3, 4, 3],
        ['e', 4, 5, 3],
      ],
    )
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg)
    const c = ch(rg, buildCH(rg, weight), 1, 5, { weight })
    expect(c.stats.found).toBe(true)
    expect(c.route?.costS).toBeCloseTo(9, 9)
    expect(c.route?.nodes).toEqual([1, 3, 4, 5])
  })

  it('== Dijkstra cost on hundreds of random pairs (the correctness anchor)', () => {
    const g = randomGraph(90, 170)
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg)
    const chData = buildCH(rg, weight)
    for (let k = 0; k < 300; k++) {
      const s = 1 + Math.floor(Math.random() * 90)
      const t = 1 + Math.floor(Math.random() * 90)
      if (s === t) continue
      const d = dijkstra(rg, s, t, { weight })
      const c = ch(rg, chData, s, t, { weight })
      expect(c.stats.found).toBe(d.stats.found)
      if (d.stats.found) expect(c.route!.costS).toBeCloseTo(d.route!.costS, 6)
    }
  })

  it('unpacking integrity: CH routes use only real edges, costs sum, path is connected', () => {
    const g = randomGraph(80, 150)
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg)
    const chData = buildCH(rg, weight)
    const edgeIds = new Set(g.edges.map((e) => e.id))
    const weightOf = new Map(g.edges.map((e) => [e.id, e.weightS] as const))
    let checked = 0
    for (let k = 0; k < 60 && checked < 40; k++) {
      const s = 1 + Math.floor(Math.random() * 80)
      const t = 1 + Math.floor(Math.random() * 80)
      if (s === t) continue
      const c = ch(rg, chData, s, t, { weight })
      if (!c.stats.found) continue
      checked++
      const r = c.route!
      for (const id of r.edges) expect(edgeIds.has(id)).toBe(true) // nothing phantom hides in a shortcut
      expect(r.nodes[0]).toBe(s)
      expect(r.nodes.at(-1)).toBe(t)
      expect(isValidPath(g, r.nodes)).toBe(true)
      const summed = r.edges.reduce((acc, id) => acc + (weightOf.get(id) as number), 0)
      expect(r.costS).toBeCloseTo(summed, 6)
    }
    expect(checked).toBeGreaterThan(0)
  })
})
