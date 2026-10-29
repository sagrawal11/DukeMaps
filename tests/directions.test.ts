// Directions are a pure route→text transform, so they get a hand-built graph with known geometry and
// exact expected maneuvers: a right-angle turn, a stairs callout, and straight-run aggregation (the
// thing that keeps a 150-edge route from becoming 150 steps).
import { describe, it, expect } from 'vitest'
import { makeDirections } from '../src/directions'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'
import type { RouteResult } from '../src/algorithms/trace'

const node = (id: number, lat: number, lon: number): GraphNode => ({ id, lat, lon })
const edge = (id: string, from: number, to: number, geometry: [number, number][], lengthM: number, kind: GraphEdge['kind'] = 'footway'): GraphEdge => ({
  id,
  source: 'osm',
  from,
  to,
  kind,
  stepFree: kind !== 'stairs',
  geometry,
  lengthM,
  weightS: lengthM,
})
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): Graph => ({ nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } })
const route = (nodes: number[], edges: string[]): RouteResult => ({ nodes, edges, costS: 0, distanceM: 0 })

describe('directions — geometry-derived turn-by-turn', () => {
  it('an L-shaped route: depart east, then turn left (north), then arrive', () => {
    const nodes = [node(1, 36.0, -78.9), node(2, 36.0, -78.898), node(3, 36.002, -78.898)]
    const edges = [
      edge('e1', 1, 2, [[-78.9, 36.0], [-78.898, 36.0]], 100), // due east
      edge('e2', 2, 3, [[-78.898, 36.0], [-78.898, 36.002]], 80), // due north
    ]
    const steps = makeDirections(graphOf(nodes, edges))(route([1, 2, 3], ['e1', 'e2']))
    expect(steps.map((s) => s.maneuver)).toEqual(['depart', 'left', 'arrive'])
    expect(steps[0].text).toBe('Head east')
    expect(steps[1].text).toBe('Turn left')
    expect(steps.map((s) => s.distanceM)).toEqual([100, 80, 0])
  })

  it('a flight of stairs becomes its own "Take the stairs" step', () => {
    const nodes = [node(1, 36.0, -78.9), node(2, 36.0, -78.898), node(3, 36.0, -78.896)]
    const edges = [
      edge('e1', 1, 2, [[-78.9, 36.0], [-78.898, 36.0]], 100), // footway, east
      edge('e2', 2, 3, [[-78.898, 36.0], [-78.896, 36.0]], 20, 'stairs'), // stairs, straight on
    ]
    const steps = makeDirections(graphOf(nodes, edges))(route([1, 2, 3], ['e1', 'e2']))
    expect(steps.map((s) => s.maneuver)).toEqual(['depart', 'stairs', 'arrive'])
    expect(steps[1].text).toBe('Take the stairs')
    expect(steps[1].distanceM).toBe(20)
  })

  it('straight consecutive edges aggregate into a single leg', () => {
    const nodes = [node(1, 36.0, -78.9), node(2, 36.0, -78.898), node(3, 36.0, -78.896), node(4, 36.0, -78.894)]
    const edges = [
      edge('e1', 1, 2, [[-78.9, 36.0], [-78.898, 36.0]], 50),
      edge('e2', 2, 3, [[-78.898, 36.0], [-78.896, 36.0]], 60),
      edge('e3', 3, 4, [[-78.896, 36.0], [-78.894, 36.0]], 70),
    ]
    const steps = makeDirections(graphOf(nodes, edges))(route([1, 2, 3, 4], ['e1', 'e2', 'e3']))
    expect(steps.map((s) => s.maneuver)).toEqual(['depart', 'arrive'])
    expect(steps[0].distanceM).toBe(180) // 50 + 60 + 70, one merged leg
  })

  it('an empty route is just an arrival', () => {
    const steps = makeDirections(graphOf([], []))(route([], []))
    expect(steps).toEqual([{ maneuver: 'arrive', text: 'Arrive at your destination', distanceM: 0 }])
  })
})
