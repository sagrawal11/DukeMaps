import { describe, it, expect } from 'vitest'
import { Quadtree, planarProjector, pointToPolylineDist, type BBoxItem, type XY } from '../src/spatial/quadtree'
import { buildNodeIndex, buildEdgeIndex } from '../src/spatial/snap'
import { polylineLengthM } from '../src/graph/geo'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

describe('planarProjector', () => {
  it('maps the origin to (0,0) and a 0.001° latitude step to ~111 m', () => {
    const p = planarProjector(-78.9, 36.0)
    expect(p(-78.9, 36.0)).toEqual({ x: 0, y: 0 })
    const north = p(-78.9, 36.001)
    expect(north.x).toBeCloseTo(0, 6)
    expect(north.y).toBeCloseTo(111.19, 0) // 0.001° latitude ≈ 111 m everywhere
  })
})

describe('Quadtree.nearest vs linear scan (the correctness guarantee)', () => {
  it('returns the same nearest node as brute force on 2000 random queries', () => {
    const nodes: GraphNode[] = []
    for (let i = 0; i < 1500; i++) {
      nodes.push({ id: i, lon: -78.95 + Math.random() * 0.06, lat: 35.98 + Math.random() * 0.05 })
    }
    const idx = buildNodeIndex(nodes)
    const pts = nodes.map((n) => idx.project(n.lon, n.lat)) // brute force in the index's own frame
    for (let t = 0; t < 2000; t++) {
      const lon = -78.95 + Math.random() * 0.06
      const lat = 35.98 + Math.random() * 0.05
      const q = idx.project(lon, lat)
      let bi = -1
      let bd = Infinity
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - q.x, pts[i].y - q.y)
        if (d < bd) {
          bd = d
          bi = i
        }
      }
      const got = idx.nearestNode(lon, lat)
      expect(got).not.toBeNull()
      expect(got!.distM).toBeCloseTo(bd, 6)
      expect(got!.node.id).toBe(nodes[bi].id)
    }
  })
})

describe('Quadtree.within', () => {
  it('returns exactly the brute-force set inside the radius', () => {
    const pts: { x: number; y: number }[] = []
    const items: BBoxItem<{ i: number; x: number; y: number }>[] = []
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * 1000
      const y = Math.random() * 1000
      pts.push({ x, y })
      items.push({ ref: { i, x, y }, minx: x, miny: y, maxx: x, maxy: y })
    }
    const qt = new Quadtree(items)
    const dist = (ref: { x: number; y: number }, qx: number, qy: number): number => Math.hypot(ref.x - qx, ref.y - qy)
    for (let t = 0; t < 200; t++) {
      const qx = Math.random() * 1000
      const qy = Math.random() * 1000
      const r = 50 + Math.random() * 150
      const got = new Set(qt.within(qx, qy, r, dist).map((o) => o.i))
      const want = new Set(pts.map((p, i) => ({ p, i })).filter(({ p }) => Math.hypot(p.x - qx, p.y - qy) <= r).map(({ i }) => i))
      expect(got).toEqual(want)
    }
  })
})

describe('pointToPolylineDist', () => {
  it('is zero on the polyline and the perpendicular distance off it', () => {
    const line: XY[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(pointToPolylineDist(line, 50, 0)).toBeCloseTo(0, 9)
    expect(pointToPolylineDist(line, 50, 7)).toBeCloseTo(7, 9)
    expect(pointToPolylineDist(line, -10, 0)).toBeCloseTo(10, 9) // clamps to the near endpoint
  })
})

function vedge(id: string, from: number, to: number, geom: [number, number][]): GraphEdge {
  return { id, source: 'osm', from, to, kind: 'footway', stepFree: true, geometry: geom, lengthM: polylineLengthM(geom), weightS: 0 }
}

describe('snap to nearest edge', () => {
  // Two parallel vertical edges ~90 m apart (0.001° lon at 36°N ≈ 90 m).
  const nodes: GraphNode[] = [
    { id: 1, lon: -78.9, lat: 36.0 },
    { id: 2, lon: -78.9, lat: 36.002 },
    { id: 3, lon: -78.899, lat: 36.0 },
    { id: 4, lon: -78.899, lat: 36.002 },
  ]
  const graph: Graph = {
    nodes,
    edges: [
      vedge('e1', 1, 2, [
        [-78.9, 36.0],
        [-78.9, 36.002],
      ]),
      vedge('e2', 3, 4, [
        [-78.899, 36.0],
        [-78.899, 36.002],
      ]),
    ],
    meta: { nodeCount: 4, edgeCount: 2 },
  }
  const idx = buildEdgeIndex(graph)

  it('snaps a tap to the closer edge, the right point, and the nearer endpoint', () => {
    const r = idx.snap(-78.9001, 36.0005) // just west of e1, near its south end
    expect(r).not.toBeNull()
    expect(r!.edgeId).toBe('e1')
    expect(r!.point[0]).toBeCloseTo(-78.9, 4)
    expect(r!.distM).toBeLessThan(15)
    expect(r!.node.id).toBe(1) // south endpoint
  })

  it('honours the isUsable filter by skipping the closer edge', () => {
    const r = idx.snap(-78.9001, 36.001, (e) => e.id !== 'e1')
    expect(r).not.toBeNull()
    expect(r!.edgeId).toBe('e2')
  })
})
