import { describe, it, expect } from 'vitest'
import { haversineM, polylineLengthM } from '../src/graph/geo'
import { edgeWeightS, WALK_SPEED_MPS, STAIRS_PENALTY } from '../src/graph/weights'
import { buildGraph } from '../src/graph/build'
import { connectedComponents, danglingStubs } from '../src/graph/validate'
import { applyEdits, type EditOp } from '../src/graph/edits'
import type { OsmResponse } from '../src/osm/overpass'

// Tiny synthetic OSM network (no real Duke data needed):
//  - way 100 [1,2,3] and way 101 [4,2,5] cross at node 2 (an intersection).
//  - way 102 [6,7,8] is a disconnected flight of steps; node 7 is a shape point, not a split.
//  - way 200 is a named building (not walkable) -> becomes a place.
const osm: OsmResponse = {
  elements: [
    { type: 'node', id: 1, lat: 36.0, lon: -78.9 },
    { type: 'node', id: 2, lat: 36.001, lon: -78.9 },
    { type: 'node', id: 3, lat: 36.002, lon: -78.9 },
    { type: 'node', id: 4, lat: 36.001, lon: -78.901 },
    { type: 'node', id: 5, lat: 36.001, lon: -78.899 },
    { type: 'node', id: 6, lat: 36.01, lon: -78.91 },
    { type: 'node', id: 7, lat: 36.0105, lon: -78.91 },
    { type: 'node', id: 8, lat: 36.011, lon: -78.91 },
    { type: 'way', id: 100, nodes: [1, 2, 3], tags: { highway: 'footway' } },
    { type: 'way', id: 101, nodes: [4, 2, 5], tags: { highway: 'path' } },
    { type: 'way', id: 102, nodes: [6, 7, 8], tags: { highway: 'steps' } },
    { type: 'way', id: 200, nodes: [1, 3, 5], tags: { building: 'yes', name: 'Test Hall' } },
  ],
}

describe('geo', () => {
  it('haversine is ~111.2km per degree of latitude', () => {
    expect(haversineM(0, 0, 1, 0)).toBeCloseTo(111195, -1) // within ~10m
  })
  it('haversine is zero for identical points', () => {
    expect(haversineM(36, -78, 36, -78)).toBe(0)
  })
  it('polylineLength sums segments', () => {
    const d = haversineM(36.0, -78.9, 36.001, -78.9)
    expect(polylineLengthM([[-78.9, 36.0], [-78.9, 36.001], [-78.9, 36.002]])).toBeCloseTo(2 * d, 5)
  })
})

describe('weights', () => {
  it('flat time = length / speed', () => {
    expect(edgeWeightS(WALK_SPEED_MPS * 100, 'footway')).toBeCloseTo(100, 10)
  })
  it('stairs cost the penalty multiple', () => {
    expect(edgeWeightS(140, 'stairs')).toBeCloseTo((140 / WALK_SPEED_MPS) * STAIRS_PENALTY, 10)
  })
})

describe('buildGraph', () => {
  const { graph, places } = buildGraph(osm)

  it('splits ways at the shared node', () => {
    // way100 -> 1-2, 2-3 ; way101 -> 4-2, 2-5 ; way102 -> 6-8 (1 edge). Total 5 edges.
    expect(graph.edges.length).toBe(5)
    // graph nodes: 1,2,3,4,5,6,8 (node 7 is an intermediate shape point). 7 nodes.
    expect(graph.nodes.length).toBe(7)
    expect(graph.nodes.find((n) => n.id === 7)).toBeUndefined()
  })

  it('the intersection node has degree 4', () => {
    const deg = graph.edges.filter((e) => e.from === 2 || e.to === 2).length
    expect(deg).toBe(4)
  })

  it('keeps intermediate shape points in edge geometry', () => {
    const steps = graph.edges.find((e) => e.osmWayId === 102)!
    expect(steps.geometry.length).toBe(3) // 6 -> 7 -> 8
  })

  it('classifies kind and step-free from tags', () => {
    const steps = graph.edges.find((e) => e.osmWayId === 102)!
    expect(steps.kind).toBe('stairs')
    expect(steps.stepFree).toBe(false)
    const footway = graph.edges.find((e) => e.osmWayId === 100)!
    expect(footway.stepFree).toBe(true)
  })

  it('all OSM edges start public (no requires)', () => {
    expect(graph.edges.every((e) => e.requires.length === 0)).toBe(true)
  })

  it('extracts named buildings as places', () => {
    expect(places).toHaveLength(1)
    expect(places[0].name).toBe('Test Hall')
  })
})

describe('validate', () => {
  const { graph } = buildGraph(osm)

  it('finds the two disconnected components', () => {
    const c = connectedComponents(graph)
    expect(c.count).toBe(2)
    expect(c.sizes).toEqual([5, 2]) // {1,2,3,4,5} and {6,8}
  })

  it('finds dangling stubs (every leaf, not the intersection)', () => {
    const stubs = danglingStubs(graph).sort((a, b) => a - b)
    expect(stubs).toEqual([1, 3, 4, 5, 6, 8])
  })
})

describe('applyEdits', () => {
  const { graph } = buildGraph(osm)

  it('replays add/update/delete and reports dangling refs', () => {
    const ops: EditOp[] = [
      { op: 'add_node', id: -1, lat: 36.0, lon: -78.898 },
      { op: 'add_edge', id: 'mine:0', from: 5, to: -1, kind: 'passage', requires: ['duke_card'] },
      { op: 'update_edge', id: '100:0', set: { requires: ['east_dorm_access'] } },
      { op: 'delete_edge', id: '102:0' },
      { op: 'update_edge', id: 'does-not-exist', set: { stepFree: false } },
    ]
    const { graph: merged, dangling } = applyEdits(graph, ops)

    expect(merged.nodes.find((n) => n.id === -1)).toBeDefined()
    const mine = merged.edges.find((e) => e.id === 'mine:0')!
    expect(mine.source).toBe('mine')
    expect(mine.requires).toEqual(['duke_card'])
    expect(merged.edges.find((e) => e.id === '100:0')!.requires).toEqual(['east_dorm_access'])
    expect(merged.edges.find((e) => e.id === '102:0')).toBeUndefined()

    expect(dangling).toHaveLength(1)
    expect(dangling[0].reason).toContain('does-not-exist')
  })

  it('does not mutate the input graph', () => {
    const before = graph.edges.length
    applyEdits(graph, [{ op: 'delete_edge', id: '100:0' }])
    expect(graph.edges.length).toBe(before)
  })
})
