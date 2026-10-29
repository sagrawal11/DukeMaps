// Pure geometry + edit helpers for the editor. No DOM, no MapLibre — unit-tested in
// tests/editing.test.ts. The editor UI (editor/*) calls these; applyEdits recomputes lengths and
// weights on replay, so these helpers only ever produce intent (coords, geometry, EditOps).
import type { GraphEdge, GraphNode } from './types'
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
// Interior shape points are distributed to the correct half. Attributes (kind/stepFree/requires/
// hours) are copied to both halves; requires/hours are spread-copied so the halves don't alias.
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

  // Both halves copy the original's attributes, each with FRESH requires/hours arrays so a later
  // update_edge on one half never mutates the other (no aliasing).
  const hoursCopy = (): { hours?: { start: string; end: string }[] } =>
    edge.hours ? { hours: edge.hours.map((h) => ({ ...h })) } : {}
  return {
    ops: [
      { op: 'delete_edge', id: edge.id },
      { op: 'add_node', id: newNodeId, lat: point[1], lon: point[0] },
      { op: 'add_edge', id: idA, from: edge.from, to: newNodeId, kind: edge.kind, stepFree: edge.stepFree, requires: [...edge.requires], geometry: geomA, ...hoursCopy() },
      { op: 'add_edge', id: idB, from: newNodeId, to: edge.to, kind: edge.kind, stepFree: edge.stepFree, requires: [...edge.requires], geometry: geomB, ...hoursCopy() },
    ],
  }
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
