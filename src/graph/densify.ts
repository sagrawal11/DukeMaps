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

// `maxSegM` is the fine split length used NEAR searchable places (where a tap needs a close anchor). With
// `opts`, edges far from every place split only at the coarser `opts.coarseSegM` (or not at all): far-flung
// paths are rarely tapped, so leaving them sparse shrinks the routing graph without hurting snapping where
// it matters. Without `opts` the behaviour is the old uniform split (used by the tests).
export function densifyGraph(graph: Graph, maxSegM: number, opts?: { coarseSegM: number; places: { lat: number; lon: number }[]; nearM: number }): Graph {
  const nodes: GraphNode[] = graph.nodes.map((n) => ({ ...n }))
  const edges: GraphEdge[] = []
  let nextId = nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1 // synthetic ids sit above every existing id

  // An edge is "near" if any of its ends or midpoint is within nearM of a place — cheap and good enough
  // since places are dense in the tapped core; the sparse far paths fall through to the coarse split.
  const nearPlace = (e: GraphEdge): boolean => {
    if (!opts) return true
    const pts = [e.geometry[0], e.geometry[Math.floor(e.geometry.length / 2)], e.geometry[e.geometry.length - 1]]
    for (const [lon, lat] of pts) for (const p of opts.places) if (haversineM(lat, lon, p.lat, p.lon) <= opts.nearM) return true
    return false
  }

  for (const e of graph.edges) {
    const segM = opts && !nearPlace(e) ? opts.coarseSegM : maxSegM
    if (e.lengthM <= segM || e.geometry.length < 2) {
      edges.push(e)
      continue
    }
    const n = Math.ceil(e.lengthM / segM)
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
