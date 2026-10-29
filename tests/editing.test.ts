import { describe, it, expect } from 'vitest'
import { projectPointOnSegment, projectPointOnPolyline, splitEdgeOps, snapToNearestNode } from '../src/graph/editing'
import { polylineLengthM } from '../src/graph/geo'
import { applyEdits, type EditOp } from '../src/graph/edits'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

// A vertical (constant-lon) edge is easy to reason about: t maps linearly to latitude.
const geom2: [number, number][] = [
  [-78.9, 36.0],
  [-78.9, 36.002],
]
const edge2: GraphEdge = {
  id: 'e2',
  source: 'osm',
  from: 1,
  to: 2,
  kind: 'footway',
  requires: ['duke_card'],
  stepFree: true,
  geometry: geom2,
  lengthM: polylineLengthM(geom2),
  weightS: 0,
}

describe('projectPointOnSegment', () => {
  it('projects the midpoint to t≈0.5 with ~0 distance', () => {
    const r = projectPointOnSegment([-78.9, 36.0], [-78.9, 36.002], [-78.9, 36.001])
    expect(r.t).toBeCloseTo(0.5, 5)
    expect(r.distM).toBeLessThan(0.1)
  })
  it('clamps t to [0,1] beyond the ends', () => {
    expect(projectPointOnSegment([-78.9, 36.0], [-78.9, 36.002], [-78.9, 36.003]).t).toBe(1)
    expect(projectPointOnSegment([-78.9, 36.0], [-78.9, 36.002], [-78.9, 35.999]).t).toBe(0)
  })
  it('measures the perpendicular offset distance', () => {
    const r = projectPointOnSegment([-78.9, 36.0], [-78.9, 36.002], [-78.901, 36.001])
    expect(r.point[0]).toBeCloseTo(-78.9, 5) // foot of perpendicular is back on the line
    expect(r.distM).toBeGreaterThan(50) // ~90 m west at this latitude
  })
})

describe('projectPointOnPolyline', () => {
  // L-shape: north up the west side, then east along the top.
  const L: [number, number][] = [
    [-78.9, 36.0],
    [-78.9, 36.002],
    [-78.897, 36.002],
  ]
  it('finds the nearest segment index', () => {
    expect(projectPointOnPolyline(L, [-78.9, 36.0005]).segIndex).toBe(0) // on the vertical arm
    expect(projectPointOnPolyline(L, [-78.8985, 36.0022]).segIndex).toBe(1) // on the horizontal arm
  })
})

describe('splitEdgeOps', () => {
  it('splits a 2-point edge into halves that meet at the split point', () => {
    const r = splitEdgeOps(edge2, [-78.9, 36.001], -1, 'mine:0', 'mine:1')
    expect('ops' in r).toBe(true)
    if (!('ops' in r)) return
    const adds = r.ops.filter((o): o is Extract<EditOp, { op: 'add_edge' }> => o.op === 'add_edge')
    const node = r.ops.find((o): o is Extract<EditOp, { op: 'add_node' }> => o.op === 'add_node')!
    expect(r.ops[0]).toEqual({ op: 'delete_edge', id: 'e2' })
    expect(adds).toHaveLength(2)
    // Halves share the split point as their joining endpoint.
    const split: [number, number] = [node.lon, node.lat]
    expect(adds[0].geometry![adds[0].geometry!.length - 1]).toEqual(split)
    expect(adds[1].geometry![0]).toEqual(split)
    // Attributes copied, with independent requires arrays (no aliasing).
    expect(adds[0].requires).toEqual(['duke_card'])
    expect(adds[1].requires).toEqual(['duke_card'])
    expect(adds[0].requires).not.toBe(adds[1].requires)
    expect(adds[0].kind).toBe('footway')
  })

  it('replays through applyEdits: original gone, two halves, lengths sum to the original', () => {
    const graph: Graph = {
      nodes: [
        { id: 1, lat: 36.0, lon: -78.9 },
        { id: 2, lat: 36.002, lon: -78.9 },
      ],
      edges: [edge2],
      meta: { nodeCount: 2, edgeCount: 1 },
    }
    const r = splitEdgeOps(edge2, [-78.9, 36.001], -1, 'mine:0', 'mine:1')
    if (!('ops' in r)) throw new Error('expected a split')
    const { graph: merged, dangling } = applyEdits(graph, r.ops)
    expect(dangling).toHaveLength(0)
    expect(merged.edges.find((e) => e.id === 'e2')).toBeUndefined()
    const a = merged.edges.find((e) => e.id === 'mine:0')!
    const b = merged.edges.find((e) => e.id === 'mine:1')!
    expect(merged.nodes.find((n) => n.id === -1)).toBeDefined()
    expect(a.lengthM + b.lengthM).toBeCloseTo(edge2.lengthM, 3)
  })

  it('distributes interior shape points to the correct half', () => {
    const geom4: [number, number][] = [
      [-78.9, 36.0],
      [-78.9, 36.001],
      [-78.9, 36.002],
      [-78.9, 36.003],
    ]
    const edge4: GraphEdge = { ...edge2, id: 'e4', geometry: geom4, lengthM: polylineLengthM(geom4) }
    const r = splitEdgeOps(edge4, [-78.9, 36.0025], -1, 'a', 'b') // on the last segment
    if (!('ops' in r)) throw new Error('expected a split')
    const adds = r.ops.filter((o): o is Extract<EditOp, { op: 'add_edge' }> => o.op === 'add_edge')
    // First half keeps the two interior vertices; second half is just [split, last].
    expect(adds[0].geometry).toContainEqual([-78.9, 36.001])
    expect(adds[0].geometry).toContainEqual([-78.9, 36.002])
    expect(adds[1].geometry!.length).toBe(2)
  })

  it('refuses a split too close to an endpoint', () => {
    const r = splitEdgeOps(edge2, [-78.9, 36.0], -1, 'a', 'b')
    expect('error' in r).toBe(true)
  })
})

describe('snapToNearestNode', () => {
  const nodes: GraphNode[] = [
    { id: 1, lat: 36.0, lon: -78.9 },
    { id: 2, lat: 36.0005, lon: -78.9 }, // ~55 m north of node 1
    { id: 3, lat: 36.02, lon: -78.9 }, // far away
  ]
  it('returns the nearest node within the radius', () => {
    expect(snapToNearestNode(nodes, -78.9, 36.00001, 20)?.id).toBe(1)
  })
  it('returns null when nothing is within the radius', () => {
    expect(snapToNearestNode(nodes, -78.95, 36.0, 20)).toBeNull()
  })
})
