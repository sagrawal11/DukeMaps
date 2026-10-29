import { describe, it, expect } from 'vitest'
import { densifyGraph, splitPolyline } from '../src/graph/densify'
import { haversineM } from '../src/graph/geo'
import type { Graph, GraphEdge } from '../src/graph/types'

const mkEdge = (id: string, from: number, to: number, geom: [number, number][]): GraphEdge => {
  const lengthM = geom.slice(1).reduce((d, p, i) => d + haversineM(geom[i][1], geom[i][0], p[1], p[0]), 0)
  return { id, source: 'osm', from, to, kind: 'footway', stepFree: true, geometry: geom, lengthM, weightS: lengthM / 1.4 }
}

describe('densifyGraph', () => {
  it('splits a long straight edge into ~maxSegM sub-edges, preserving endpoints, shape, and total weight', () => {
    const A: [number, number] = [-78.94, 36.0]
    const B: [number, number] = [-78.94, 36.0009] // ~100 m due north
    const g: Graph = {
      nodes: [{ id: 1, lon: A[0], lat: A[1] }, { id: 2, lon: B[0], lat: B[1] }],
      edges: [mkEdge('e0', 1, 2, [A, B])],
      meta: { nodeCount: 2, edgeCount: 1 },
    }
    const orig = g.edges[0]
    const n = Math.ceil(orig.lengthM / 25)
    const out = densifyGraph(g, 25)

    expect(out.edges.length).toBe(n) // one long edge -> n sub-edges
    expect(out.nodes.length).toBe(2 + (n - 1)) // n-1 new pass-through nodes
    expect(out.edges[0].from).toBe(1) // original endpoints preserved...
    expect(out.edges.at(-1)!.to).toBe(2)
    for (let i = 1; i < out.edges.length; i++) expect(out.edges[i].from).toBe(out.edges[i - 1].to) // connected chain
    const wSum = out.edges.reduce((s, e) => s + e.weightS, 0)
    expect(wSum).toBeCloseTo(orig.weightS, 6) // total walking cost preserved exactly
    for (const e of out.edges) expect(e.lengthM).toBeLessThanOrEqual(25 * 1.02) // each within the cap
    expect(out.edges.reduce((s, e) => s + e.lengthM, 0)).toBeCloseTo(orig.lengthM, 1)
  })

  it('leaves short edges untouched', () => {
    const A: [number, number] = [-78.94, 36.0]
    const B: [number, number] = [-78.9399, 36.0] // ~9 m
    const g: Graph = { nodes: [{ id: 1, lon: A[0], lat: A[1] }, { id: 2, lon: B[0], lat: B[1] }], edges: [mkEdge('e0', 1, 2, [A, B])], meta: { nodeCount: 2, edgeCount: 1 } }
    const out = densifyGraph(g, 25)
    expect(out.edges.length).toBe(1)
    expect(out.edges[0].id).toBe('e0')
    expect(out.nodes.length).toBe(2)
  })

  it('splitPolyline returns n contiguous parts that join seamlessly', () => {
    const geom: [number, number][] = [[-78.94, 36.0], [-78.94, 36.001]]
    const parts = splitPolyline(geom, 4)
    expect(parts.length).toBe(4)
    expect(parts[0][0]).toEqual(geom[0]) // starts at the start
    expect(parts.at(-1)!.at(-1)).toEqual(geom[1]) // ends at the end
    for (let i = 1; i < parts.length; i++) expect(parts[i][0]).toEqual(parts[i - 1].at(-1)) // shared cut points
  })
})
