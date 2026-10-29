// Densify long edges: split any edge longer than maxSegM into a chain of ~maxSegM sub-edges with
// pass-through intermediate nodes. The graph's SHAPE and total walking cost are preserved exactly — a
// sub-edge's weight is its share of the parent's weight (the last one absorbs rounding so the sum is
// identical) — only node density changes. Why: snapping anchors a tap to the nearest *node* (an edge
// endpoint); on a long straight (the real graph has edges up to ~1.9 km) that endpoint can be far away
// and on the wrong side, forcing a detour. More nodes → the anchor lands next to where you actually
// tapped. Pure + tested; runs once in the build pipeline.
import type { Graph, GraphNode, GraphEdge } from './types'
import { haversineM } from './geo'

const lenOf = (geom: [number, number][]): number => {
  let d = 0
  for (let i = 1; i < geom.length; i++) d += haversineM(geom[i - 1][1], geom[i - 1][0], geom[i][1], geom[i][0])
  return d
}

// Split a polyline into n contiguous sub-polylines of (approximately) equal length, cutting mid-segment
// where needed and carrying the original shape vertices. Returns exactly n parts (n >= 1).
export function splitPolyline(geom: [number, number][], n: number): [number, number][][] {
  if (n <= 1 || geom.length < 2) return [geom]
  const cum = [0]
  for (let i = 1; i < geom.length; i++) cum.push(cum[i - 1] + haversineM(geom[i - 1][1], geom[i - 1][0], geom[i][1], geom[i][0]))
  const total = cum[cum.length - 1]
  const step = total / n
  const cuts: number[] = []
  for (let k = 1; k < n; k++) cuts.push(k * step)

  const parts: [number, number][][] = []
  let cur: [number, number][] = [geom[0]]
  let ci = 0
  for (let i = 1; i < geom.length; i++) {
    while (ci < cuts.length && cuts[ci] <= cum[i] + 1e-9) {
      const span = cum[i] - cum[i - 1] || 1
      const t = (cuts[ci] - cum[i - 1]) / span
      const clon = geom[i - 1][0] + (geom[i][0] - geom[i - 1][0]) * t
      const clat = geom[i - 1][1] + (geom[i][1] - geom[i - 1][1]) * t
      cur.push([clon, clat])
      parts.push(cur)
      cur = [[clon, clat]]
      ci++
    }
    cur.push(geom[i])
  }
  parts.push(cur)
  return parts
}

export function densifyGraph(graph: Graph, maxSegM: number): Graph {
  const nodes: GraphNode[] = graph.nodes.map((n) => ({ ...n }))
  const edges: GraphEdge[] = []
  let nextId = nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1 // synthetic ids sit above every existing id

  for (const e of graph.edges) {
    if (e.lengthM <= maxSegM || e.geometry.length < 2) {
      edges.push(e)
      continue
    }
    const n = Math.ceil(e.lengthM / maxSegM)
    const parts = splitPolyline(e.geometry, n)
    let prev = e.from
    let accW = 0
    parts.forEach((geom, i) => {
      const last = i === parts.length - 1
      let to: number
      if (last) {
        to = e.to
      } else {
        const end = geom[geom.length - 1]
        to = nextId++
        nodes.push({ id: to, lon: end[0], lat: end[1] })
      }
      const segLen = lenOf(geom)
      const w = last ? e.weightS - accW : e.weightS * (segLen / e.lengthM) // last absorbs rounding → total preserved
      accW += w
      edges.push({ ...e, id: `${e.id}#${i}`, from: prev, to, geometry: geom, lengthM: segLen, weightS: w })
      prev = to
    })
  }

  return { nodes, edges, meta: { ...graph.meta, nodeCount: nodes.length, edgeCount: edges.length } }
}
