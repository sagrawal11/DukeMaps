// Connectivity validation. Reports connected components and dangling stubs so I can see
// islands in the graph. Union-find and degree counting are plain utilities here, NOT the
// showcased search algorithms (those are hand-written in Phase 5).
import type { Graph } from './types'
import type { Feature, FeatureCollection } from 'geojson'

export interface Components {
  count: number
  sizes: number[] // descending
  componentOf: Map<number, number> // node id -> component index (0 = largest)
}

// Disjoint-set (union-find) over node ids, with path compression.
export function connectedComponents(graph: Graph): Components {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = x
    while (c !== r) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const n of graph.nodes) parent.set(n.id, n.id)
  for (const e of graph.edges) if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to)

  const sizeByRoot = new Map<number, number>()
  for (const n of graph.nodes) {
    const r = find(n.id)
    sizeByRoot.set(r, (sizeByRoot.get(r) ?? 0) + 1)
  }
  const roots = [...sizeByRoot.entries()].sort((a, b) => b[1] - a[1])
  const indexByRoot = new Map<number, number>()
  roots.forEach(([root], i) => indexByRoot.set(root, i))

  const componentOf = new Map<number, number>()
  for (const n of graph.nodes) componentOf.set(n.id, indexByRoot.get(find(n.id))!)

  return { count: roots.length, sizes: roots.map(([, s]) => s), componentOf }
}

// Degree-1 nodes: dead-end stubs worth eyeballing (often unconnected way ends).
export function danglingStubs(graph: Graph): number[] {
  const degree = new Map<number, number>()
  for (const n of graph.nodes) degree.set(n.id, 0)
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  return [...degree.entries()].filter(([, d]) => d === 1).map(([id]) => id)
}

// GeoJSON for rendering islands: each edge as a LineString tagged with its component, plus
// stub nodes as Points.
export function toValidationGeoJSON(graph: Graph): FeatureCollection {
  const { componentOf } = connectedComponents(graph)
  const stubs = new Set(danglingStubs(graph))
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const features: Feature[] = []

  for (const e of graph.edges) {
    features.push({
      type: 'Feature',
      properties: { id: e.id, component: componentOf.get(e.from) ?? -1, kind: e.kind, source: e.source },
      geometry: { type: 'LineString', coordinates: e.geometry },
    })
  }
  for (const id of stubs) {
    const n = nodeById.get(id)
    if (n) features.push({ type: 'Feature', properties: { stub: true, id }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } })
  }
  return { type: 'FeatureCollection', features }
}
