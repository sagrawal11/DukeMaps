// Phase-4 spatial queries the app needs, built on the hand-written quadtree:
//   - nearestNode: closest graph node to a lon/lat (the routing anchor; benchmark headline).
//   - snap:        closest point on the closest usable edge to a tap (snap-anywhere).
// Both indexes share one planar frame centred on the graph, so their coordinates are comparable.
import type { Graph, GraphEdge, GraphNode } from '../graph/types'
import { Quadtree, planarProjector, pointToPolylineDist, type BBoxItem, type XY } from './quadtree'
import { projectPointOnPolyline } from '../graph/editing'
import { haversineM } from '../graph/geo'

function frameCenter(nodes: GraphNode[]): { lon0: number; lat0: number } {
  if (!nodes.length) return { lon0: 0, lat0: 0 }
  let slon = 0
  let slat = 0
  for (const n of nodes) {
    slon += n.lon
    slat += n.lat
  }
  return { lon0: slon / nodes.length, lat0: slat / nodes.length }
}

export interface NodeIndex {
  nearestNode(lon: number, lat: number): { node: GraphNode; distM: number } | null
  project(lon: number, lat: number): XY
}

// Index graph nodes as zero-size boxes; nearest-node is then a plain point NN query.
export function buildNodeIndex(nodes: GraphNode[]): NodeIndex {
  const { lon0, lat0 } = frameCenter(nodes)
  const project = planarProjector(lon0, lat0)
  const items: BBoxItem<{ node: GraphNode; p: XY }>[] = nodes.map((node) => {
    const p = project(node.lon, node.lat)
    return { ref: { node, p }, minx: p.x, miny: p.y, maxx: p.x, maxy: p.y }
  })
  const qt = new Quadtree(items)
  const dist = (ref: { node: GraphNode; p: XY }, qx: number, qy: number): number =>
    Math.hypot(ref.p.x - qx, ref.p.y - qy)
  return {
    project,
    nearestNode(lon, lat) {
      const q = project(lon, lat)
      const r = qt.nearest(q.x, q.y, dist)
      return r ? { node: r.ref.node, distM: r.distM } : null
    },
  }
}

export interface SnapResult {
  edgeId: string
  point: [number, number] // [lon,lat] of the nearest point on the edge
  node: GraphNode // routing anchor: the edge endpoint nearer the snapped point
  distM: number // haversine distance from the tap to the snapped point
}

export interface EdgeIndex {
  snap(lon: number, lat: number, isUsable?: (e: GraphEdge) => boolean): SnapResult | null
  project(lon: number, lat: number): XY
}

interface EdgeEntry {
  edge: GraphEdge
  xy: XY[] // edge geometry pre-projected into the planar frame
}

// Index each edge by the bounding box of its (projected) polyline. nearest() then returns the
// genuinely closest edge — not an approximation from nearby nodes — because the box distance
// lower-bounds the polyline distance, so branch-and-bound never prunes a reachable closer edge.
export function buildEdgeIndex(graph: Graph): EdgeIndex {
  const { lon0, lat0 } = frameCenter(graph.nodes)
  const project = planarProjector(lon0, lat0)
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const))
  const items: BBoxItem<EdgeEntry>[] = []
  for (const edge of graph.edges) {
    const xy = edge.geometry.map(([lon, lat]) => project(lon, lat))
    let minx = Infinity
    let miny = Infinity
    let maxx = -Infinity
    let maxy = -Infinity
    for (const p of xy) {
      if (p.x < minx) minx = p.x
      if (p.x > maxx) maxx = p.x
      if (p.y < miny) miny = p.y
      if (p.y > maxy) maxy = p.y
    }
    items.push({ ref: { edge, xy }, minx, miny, maxx, maxy })
  }
  const qt = new Quadtree(items)
  return {
    project,
    snap(lon, lat, isUsable) {
      const q = project(lon, lat)
      // An unusable edge returns Infinity, so branch-and-bound treats it as absent for this query.
      const dist = (ref: EdgeEntry, qx: number, qy: number): number =>
        isUsable && !isUsable(ref.edge) ? Infinity : pointToPolylineDist(ref.xy, qx, qy)
      const r = qt.nearest(q.x, q.y, dist)
      if (!r || !Number.isFinite(r.distM)) return null
      const edge = r.ref.edge
      // Re-project in lon/lat with the tested polyline projector for the exact display point + dist.
      const proj = projectPointOnPolyline(edge.geometry, [lon, lat])
      const node = nearerEndpoint(proj.point, nodeById.get(edge.from), nodeById.get(edge.to))
      return { edgeId: edge.id, point: proj.point, node, distM: proj.distM }
    },
  }
}

// The edge endpoint closer to the snapped point — a built graph always has both, so this is total.
function nearerEndpoint(point: [number, number], from: GraphNode | undefined, to: GraphNode | undefined): GraphNode {
  if (!from) return to as GraphNode
  if (!to) return from
  const dFrom = haversineM(point[1], point[0], from.lat, from.lon)
  const dTo = haversineM(point[1], point[0], to.lat, to.lon)
  return dFrom <= dTo ? from : to
}
