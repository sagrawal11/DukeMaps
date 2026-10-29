// Pure geometry + edit helpers for the editor. No DOM, no MapLibre — unit-tested in
// tests/editing.test.ts. The editor UI (editor/*) calls these; applyEdits recomputes lengths and
// weights on replay, so these helpers only ever produce intent (coords, geometry, EditOps).
import type { Graph, GraphEdge, GraphNode } from './types'
import type { EditOp } from './edits'
import { haversineM } from './geo'

export interface Projection {
  point: [number, number] // [lon, lat] of the closest point on the segment/polyline
  t: number // 0..1 position along the segment
  distM: number // distance from the query point to `point`, meters
}

// Project point p onto segment a->b. Coordinates are [lon, lat]. We scale longitude by
// cos(latitude) so the local space is approximately metric (equirectangular) — accurate at campus
// scale — then clamp t to the segment. The returned point is interpolated back in raw lon/lat.
// ponytail: equirectangular approximation, fine over a few km; revisit only if it visibly drifts.
export function projectPointOnSegment(
  a: [number, number],
  b: [number, number],
  p: [number, number],
): Projection {
  const latRef = (a[1] + b[1]) / 2
  const kx = Math.cos((latRef * Math.PI) / 180)
  const ax = a[0] * kx
  const ay = a[1]
  const bx = b[0] * kx
  const by = b[1]
  const px = p[0] * kx
  const py = p[1]
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const point: [number, number] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
  return { point, t, distM: haversineM(p[1], p[0], point[1], point[0]) }
}

export interface PolylineProjection extends Projection {
  segIndex: number // the segment [geometry[segIndex], geometry[segIndex+1]] that `point` lies on
}

// Nearest point on a whole polyline (multi-segment edge geometry). Checking every segment is what
// lets a split distribute interior shape points to the correct half.
export function projectPointOnPolyline(geometry: [number, number][], p: [number, number]): PolylineProjection {
  let best: PolylineProjection = { point: geometry[0], t: 0, distM: Infinity, segIndex: 0 }
  for (let i = 0; i < geometry.length - 1; i++) {
    const proj = projectPointOnSegment(geometry[i], geometry[i + 1], p)
    if (proj.distM < best.distM) best = { ...proj, segIndex: i }
  }
  return best
}

export type SplitResult = { ops: EditOp[] } | { error: string }

// Split an edge at the point on it nearest to p, into two edges meeting at a new node. Returns the
// composite EditOps (delete original, add node, add the two halves) — no new EditOp kind needed.
// Interior shape points are distributed to the correct half. Attributes (kind/stepFree/hours) are
// copied to both halves; hours is spread-copied so the halves don't alias.
// Refuses a split within `epsM` meters of an endpoint (that would create a zero-length half).
export function splitEdgeOps(
  edge: GraphEdge,
  p: [number, number],
  newNodeId: number,
  idA: string,
  idB: string,
  epsM = 0.5,
): SplitResult {
  const geom = edge.geometry
  const { point, segIndex } = projectPointOnPolyline(geom, p)
  const start = geom[0]
  const end = geom[geom.length - 1]
  if (haversineM(point[1], point[0], start[1], start[0]) < epsM) return { error: 'split too close to the start node' }
  if (haversineM(point[1], point[0], end[1], end[0]) < epsM) return { error: 'split too close to the end node' }

  const geomA: [number, number][] = [...geom.slice(0, segIndex + 1).map((c) => [c[0], c[1]] as [number, number]), point]
  const geomB: [number, number][] = [point, ...geom.slice(segIndex + 1).map((c) => [c[0], c[1]] as [number, number])]

  // Both halves copy the original's attributes, each with a FRESH hours array so a later
  // update_edge on one half never mutates the other (no aliasing).
  const hoursCopy = (): { hours?: { start: string; end: string }[] } =>
    edge.hours ? { hours: edge.hours.map((h) => ({ ...h })) } : {}
  return {
    ops: [
      { op: 'delete_edge', id: edge.id },
      { op: 'add_node', id: newNodeId, lat: point[1], lon: point[0] },
      { op: 'add_edge', id: idA, from: edge.from, to: newNodeId, kind: edge.kind, stepFree: edge.stepFree, geometry: geomA, ...hoursCopy() },
      { op: 'add_edge', id: idB, from: newNodeId, to: edge.to, kind: edge.kind, stepFree: edge.stepFree, geometry: geomB, ...hoursCopy() },
    ],
  }
}

// Audit flag for the "missing attributes" view — does this edge look incomplete or mis-tagged?
// It's a toggle-on review aid, so a little over-flagging is fine (better to eyeball an edge than
// miss one).
export function missingAttrs(edge: GraphEdge): boolean {
  if (edge.kind === 'unknown') return true // OSM tags didn't classify it
  if (edge.kind === 'stairs' && edge.stepFree) return true // stairs can't be step-free (contradiction)
  return false
}

// Nearest graph node to a lon/lat within radiusM (linear scan — a spatial index is Phase 4). Used
// by the GPX "accept" flow to snap new endpoints onto the existing network.
// ponytail: O(n) scan over ~6k nodes, sub-ms; replace with the Phase 4 index if it ever matters.
export function snapToNearestNode(
  nodes: GraphNode[],
  lon: number,
  lat: number,
  radiusM: number,
): GraphNode | null {
  let best: GraphNode | null = null
  let bestD = radiusM
  for (const n of nodes) {
    const d = haversineM(lat, lon, n.lat, n.lon)
    if (d <= bestD) {
      bestD = d
      best = n
    }
  }
  return best
}

// Parse a GPX track into one [lon, lat] array per <trkseg> (or one array if there are trackpoints
// but no segments). Regex-based and order-agnostic on the lat/lon attributes — no XML dependency,
// and pure so it's unit-testable. ponytail: regex over flat GPX; swap for a real parser only if a
// track uses namespaced/exotic trkpt attributes.
export function parseGpx(xml: string): [number, number][][] {
  const blocks = xml.match(/<trkseg[\s\S]*?<\/trkseg>/g) ?? (xml.includes('<trkpt') ? [xml] : [])
  const tracks: [number, number][][] = []
  for (const block of blocks) {
    const pts: [number, number][] = []
    for (const tag of block.match(/<trkpt\b[^>]*>/g) ?? []) {
      const lat = /\blat="(-?\d+(?:\.\d+)?)"/.exec(tag)
      const lon = /\blon="(-?\d+(?:\.\d+)?)"/.exec(tag)
      if (lat && lon) pts.push([Number(lon[1]), Number(lat[1])])
    }
    if (pts.length) tracks.push(pts)
  }
  return tracks
}

export interface DivergencePoint {
  point: [number, number] // [lon, lat]
  nearestDistM: number // distance to the nearest existing edge
  diverged: boolean // nearestDistM > threshold → not on the known graph
}

// For each track point, the distance to the nearest existing edge, flagged if beyond threshold.
// Drives the GPX "where does this diverge from the graph?" preview. One-shot O(points × edges)
// linear scan — fine for an import; the Phase 4 spatial index would speed it up if needed.
export function trackDivergence(track: [number, number][], graph: Graph, thresholdM: number): DivergencePoint[] {
  return track.map((p) => {
    let nearest = Infinity
    for (const e of graph.edges) {
      const d = projectPointOnPolyline(e.geometry, p).distM
      if (d < nearest) nearest = d
      if (nearest === 0) break
    }
    return { point: p, nearestDistM: nearest, diverged: nearest > thresholdM }
  })
}
