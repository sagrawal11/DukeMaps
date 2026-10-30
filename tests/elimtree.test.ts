import { describe, it, expect } from 'vitest'
import { buildParents, upChain, elimPaths, layoutElimTree, layoutFullTree } from '../src/anim/elimtree'
import type { CHData, UpArc } from '../src/algorithms/ch'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { buildCCH, customize } from '../src/algorithms/cch'
import { ch } from '../src/algorithms/ch'
import { haversineM } from '../src/graph/geo'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

// A hand-built hierarchy (only the fields the elimination tree reads matter: nodeIds, rank, upArcs).
// Up-neighbours by routing index — rank[i] = i, so higher index = higher rank = contracted later:
//   0 -> {1,3}   parent = 1 (lowest rank)      2 -> {4}   parent = 4
//   1 -> {2}     parent = 2                     3 -> {4}   parent = 4
//   4 -> {}      root
const up = (...tos: number[]): UpArc[] => tos.map((to) => ({ to, w: 0, r: 0 }))
const TINY: CHData = {
  nodeIds: [100, 101, 102, 103, 104],
  rank: [0, 1, 2, 3, 4],
  upArcs: [up(1, 3), up(2), up(4), up(4), up()],
  shortcuts: [],
  meta: { builtAt: '', nodes: 5, origArcs: 0, shortcuts: 0, preprocMs: 0 },
}

describe('elimtree — structure', () => {
  it('parent = lowest-ranked up-neighbour; root has none', () => {
    expect([...buildParents(TINY)]).toEqual([1, 2, 4, 4, -1])
  })

  it('upChain climbs to the root', () => {
    const parent = buildParents(TINY)
    expect(upChain(parent, 0)).toEqual([0, 1, 2, 4])
    expect(upChain(parent, 3)).toEqual([3, 4])
    expect(upChain(parent, 4)).toEqual([4])
  })

  it('elimPaths truncates both chains at the apex (lowest common ancestor)', () => {
    const p = elimPaths(TINY, 0, 3)!
    expect(p.apex).toBe(4)
    expect(p.sPath).toEqual([0, 1, 2, 4])
    expect(p.tPath).toEqual([3, 4])
  })

  it('elimPaths handles s being an ancestor of t (apex = s)', () => {
    const p = elimPaths(TINY, 2, 3)! // 2's chain [2,4]; 3's chain [3,4]; apex 4
    expect(p.apex).toBe(4)
    expect(elimPaths(TINY, 1, 2)!.apex).toBe(2) // 2 is on 1's chain -> apex is 2 itself
    expect(elimPaths(TINY, 0, 0)).toBeNull() // s === t
  })
})

describe('elimtree — layout', () => {
  it('apex sits at top-center, leaves splay left/right, y rises toward the apex', () => {
    const layout = layoutElimTree(elimPaths(TINY, 0, 3)!, TINY)
    const apex = layout.nodes[layout.apexIndex]
    expect(apex.y).toBeCloseTo(0, 9)
    expect(apex.x).toBeCloseTo(0.5, 9)
    expect(apex.side).toBe('apex')

    const sLeaf = layout.nodes[layout.sLeafIndex]
    const tLeaf = layout.nodes[layout.tLeafIndex]
    expect(sLeaf.x).toBeLessThan(0.5)
    expect(tLeaf.x).toBeGreaterThan(0.5)
    expect(sLeaf.y).toBeCloseTo(1, 9) // leaves at the bottom
    expect(tLeaf.y).toBeCloseTo(1, 9)

    // Along the s-chain, y strictly decreases (climbs) as depth increases.
    const sChain = layout.nodes.filter((n) => n.side === 'f').sort((a, b) => a.depth - b.depth)
    for (let i = 1; i < sChain.length; i++) expect(sChain[i].y).toBeLessThan(sChain[i - 1].y)

    // Every chain edge connects into the node list, and every chain reaches the apex.
    expect(layout.edges.every((e) => e.from < layout.nodes.length && e.to < layout.nodes.length)).toBe(true)
    expect(layout.edges.some((e) => e.to === layout.apexIndex)).toBe(true)
  })
})

// --- integration: the tree must match what the real query does (mirrors tests/cch.test.ts) ---
function randomGraph(n: number, extraEdges: number): Graph {
  const nodes: GraphNode[] = []
  for (let id = 1; id <= n; id++) nodes.push({ id, lon: -78.95 + Math.random() * 0.03, lat: 36.0 + Math.random() * 0.02 })
  const edges: GraphEdge[] = []
  const add = (a: number, b: number): void => {
    const na = nodes[a - 1]
    const nb = nodes[b - 1]
    const lengthM = haversineM(na.lat, na.lon, nb.lat, nb.lon)
    edges.push({ id: `e${edges.length}`, source: 'osm', from: a, to: b, kind: 'footway', stepFree: true, geometry: [[na.lon, na.lat], [nb.lon, nb.lat]], lengthM, weightS: lengthM / 1.4 })
  }
  for (let i = 2; i <= n; i++) add(i, 1 + Math.floor(Math.random() * (i - 1))) // spanning tree -> connected
  for (let k = 0; k < extraEdges; k++) {
    const a = 1 + Math.floor(Math.random() * n)
    const b = 1 + Math.floor(Math.random() * n)
    if (a !== b) add(a, b)
  }
  return { nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } }
}

describe('elimtree — matches the real CCH query', () => {
  it("the query's meeting node is a common ancestor in the elimination tree", () => {
    const g = randomGraph(90, 170)
    const rg = buildRoutingGraph(g)
    const weight = makeWeight(rg)
    const chData = customize(buildCCH(rg), rg, weight)
    const parent = buildParents(chData)
    let checked = 0
    for (let k = 0; k < 120 && checked < 60; k++) {
      const s = 1 + Math.floor(Math.random() * 90)
      const t = 1 + Math.floor(Math.random() * 90)
      if (s === t) continue
      const trace = ch(rg, chData, s, t, { weight })
      if (!trace.stats.found) continue
      const meets = trace.events.filter((e) => e.type === 'meet')
      if (!meets.length) continue
      checked++
      const meetId = meets[meets.length - 1].node! // the final (best) meeting node
      const sIdx = rg.indexOf.get(s)!
      const tIdx = rg.indexOf.get(t)!
      const sChainIds = new Set(upChain(parent, sIdx).map((i) => chData.nodeIds[i]))
      const tChainIds = new Set(upChain(parent, tIdx).map((i) => chData.nodeIds[i]))
      expect(sChainIds.has(meetId)).toBe(true) // reachable upward from s == on s's chain
      expect(tChainIds.has(meetId)).toBe(true) // ...and from t
      // ...and the structural apex is itself a common ancestor
      const apexId = chData.nodeIds[elimPaths(chData, sIdx, tIdx)!.apex]
      expect(sChainIds.has(apexId) && tChainIds.has(apexId)).toBe(true)
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('elimtree — full-tree layout (the click-to-expand whole map)', () => {
  it('places every node: root at the top, leaves at the bottom, parents centred over children', () => {
    const fl = layoutFullTree(TINY)
    expect(fl.n).toBe(5)
    expect(fl.maxDepth).toBe(3)
    expect([...fl.parent]).toEqual([1, 2, 4, 4, -1]) // mirrors the elimination tree
    expect(fl.ys[4]).toBeCloseTo(0, 9) // root (index 4, no parent) at the top
    expect(fl.ys[0]).toBeCloseTo(1, 9) // deepest leaf (index 0) at the bottom
    for (let i = 0; i < fl.n; i++) {
      expect(fl.xs[i]).toBeGreaterThanOrEqual(0)
      expect(fl.xs[i]).toBeLessThanOrEqual(1)
      expect(fl.ys[i]).toBeGreaterThanOrEqual(0)
      expect(fl.ys[i]).toBeLessThanOrEqual(1)
    }
    expect(fl.xs[4]).toBeCloseTo((fl.xs[2] + fl.xs[3]) / 2, 9) // root centres over its two children
  })
})
