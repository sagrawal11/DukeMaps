import { describe, it, expect } from 'vitest'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { dijkstra } from '../src/algorithms/dijkstra'
import { ch } from '../src/algorithms/ch'
import { buildCCH, customize, nestedDissectionOrder } from '../src/algorithms/cch'
import { haversineM } from '../src/graph/geo'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

// --- helpers (mirror tests/algorithms.test.ts) ---
type EdgeSpec = [string, number, number, number, boolean?]
function mkGraph(ids: number[], specs: EdgeSpec[]): Graph {
  const nodes: GraphNode[] = ids.map((id) => ({ id, lon: -78.9 + id * 0.001, lat: 36.0 + id * 0.0007 }))
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

describe('CCH — nested dissection + metric-independent structure', () => {
  it('produces a valid node order (a permutation) and ranks separators', () => {
    const g = randomGraph(80, 140)
    const rg = buildRoutingGraph(g)
    const rank = nestedDissectionOrder(rg)
    expect(rank.length).toBe(g.nodes.length)
    expect([...rank].sort((a, b) => a - b)).toEqual(Array.from({ length: g.nodes.length }, (_, i) => i))
  })

  it('up-graph has the clique property (each node’s up-neighbours are pairwise connected)', () => {
    const g = randomGraph(70, 120)
    const s = buildCCH(buildRoutingGraph(g))
    const arcExists = (x: number, y: number): boolean => {
      const lo = s.rank[x] < s.rank[y] ? x : y
      const hi = lo === x ? y : x
      return s.upTo[lo].includes(hi)
    }
    for (let v = 0; v < s.upTo.length; v++) {
      const ups = s.upTo[v]
      for (const u of ups) expect(s.rank[u]).toBeGreaterThan(s.rank[v]) // up-arcs only go upward
      for (let i = 0; i < ups.length; i++) for (let j = i + 1; j < ups.length; j++) expect(arcExists(ups[i], ups[j])).toBe(true)
    }
    expect(s.meta.shortcuts).toBeGreaterThan(0)
  })
})

describe('CCH — customization + query (reuses ch())', () => {
  it('matches Dijkstra on a tiny hand-built graph', () => {
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
    const chData = customize(buildCCH(rg), rg, weight)
    const c = ch(rg, chData, 1, 5, { weight })
    expect(c.route?.costS).toBeCloseTo(9, 9)
    expect(c.route?.nodes).toEqual([1, 3, 4, 5])
  })

  it('== Dijkstra cost on 300 random pairs under the BASE metric', () => {
    const g = randomGraph(90, 170)
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg)
    const chData = customize(buildCCH(rg), rg, weight)
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

  it('== Dijkstra under the STEP-FREE metric, and routes stay step-free even inside shortcuts', () => {
    const g = randomGraph(90, 180)
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg, { stepFreeOnly: true })
    const struct = buildCCH(rg) // one structure...
    const chData = customize(struct, rg, weight) // ...re-weighted for step-free only (no re-contract)
    const stepFreeId = new Set(g.edges.filter((e) => e.stepFree).map((e) => e.id))
    let checked = 0
    for (let k = 0; k < 300; k++) {
      const s = 1 + Math.floor(Math.random() * 90)
      const t = 1 + Math.floor(Math.random() * 90)
      if (s === t) continue
      const d = dijkstra(rg, s, t, { weight })
      const c = ch(rg, chData, s, t, { weight })
      expect(c.stats.found).toBe(d.stats.found)
      if (!d.stats.found) continue
      checked++
      expect(c.route!.costS).toBeCloseTo(d.route!.costS, 6)
      for (const id of c.route!.edges) expect(stepFreeId.has(id)).toBe(true) // access-safety inside unpacked shortcuts
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('unpacking integrity: routes use only real edges, costs sum, path connected', () => {
    const g = randomGraph(80, 150)
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg)
    const chData = customize(buildCCH(rg), rg, weight)
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
      for (const id of r.edges) expect(edgeIds.has(id)).toBe(true)
      expect(r.nodes[0]).toBe(s)
      expect(r.nodes.at(-1)).toBe(t)
      expect(isValidPath(g, r.nodes)).toBe(true)
      expect(r.costS).toBeCloseTo(
        r.edges.reduce((acc, id) => acc + (weightOf.get(id) as number), 0),
        6,
      )
    }
    expect(checked).toBeGreaterThan(0)
  })
})
