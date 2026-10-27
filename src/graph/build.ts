// Pure graph builder: OSM elements -> routable Graph + named Places. No fs, no network, so
// it's unit-testable with synthetic fixtures.
//
// The key step is "split ways at shared nodes". An OSM way is a polyline through many nodes;
// a node shared by two or more walkable ways is an intersection and must become a graph node.
// We split each way into edges between consecutive graph nodes, keeping the intermediate
// shape points as the edge geometry.
import type { Area, Graph, GraphEdge, GraphNode, Place } from './types'
import type { AreaBBox, OsmNode, OsmResponse, OsmWay } from '../osm/overpass'
import { WALKABLE_HIGHWAY, kindFromTags, stepFreeFromTags } from '../osm/overpass'
import { polylineLengthM } from './geo'
import { edgeWeightS } from './weights'

const WALKABLE = new Set(WALKABLE_HIGHWAY)

function isWalkableWay(w: OsmWay): boolean {
  const t = w.tags ?? {}
  if (t.indoor === 'corridor') return true
  return t.highway !== undefined && WALKABLE.has(t.highway)
}

export interface BuildResult {
  graph: Graph
  places: Place[]
}

export function buildGraph(osm: OsmResponse, areas: AreaBBox[] = []): BuildResult {
  // 1. Index node coordinates by id.
  const nodeCoord = new Map<number, OsmNode>()
  for (const el of osm.elements) if (el.type === 'node') nodeCoord.set(el.id, el)

  const ways = osm.elements.filter((el): el is OsmWay => el.type === 'way')
  const walkWays = ways.filter(isWalkableWay)

  // 2. Count walkable-way usage per node; >=2 means an intersection.
  const useCount = new Map<number, number>()
  for (const w of walkWays) for (const nid of w.nodes) useCount.set(nid, (useCount.get(nid) ?? 0) + 1)

  // A node splits a way if it's an endpoint of that way or shared by >=2 walkable ways.
  const isSplit = (nid: number, w: OsmWay, idx: number): boolean =>
    idx === 0 || idx === w.nodes.length - 1 || (useCount.get(nid) ?? 0) >= 2

  const graphNodes = new Map<number, GraphNode>()
  const ensureNode = (nid: number): boolean => {
    if (graphNodes.has(nid)) return true
    const n = nodeCoord.get(nid)
    if (!n) return false
    graphNodes.set(nid, { id: nid, lat: n.lat, lon: n.lon })
    return true
  }

  // 3. Split each walkable way into edges between consecutive split nodes.
  const edges: GraphEdge[] = []
  for (const w of walkWays) {
    const t = w.tags ?? {}
    const kind = kindFromTags(t)
    const stepFree = stepFreeFromTags(t)
    let seg = 0
    let startIdx = 0
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isSplit(w.nodes[i], w, i)) continue
      const a = w.nodes[startIdx]
      const b = w.nodes[i]
      const sliceIds = w.nodes.slice(startIdx, i + 1)
      const coords: [number, number][] = []
      let ok = true
      for (const id of sliceIds) {
        const nc = nodeCoord.get(id)
        if (!nc) {
          ok = false
          break
        }
        coords.push([nc.lon, nc.lat])
      }
      if (ok && a !== b && ensureNode(a) && ensureNode(b)) {
        const lengthM = polylineLengthM(coords)
        edges.push({
          id: `${w.id}:${seg}`,
          source: 'osm',
          from: a,
          to: b,
          kind,
          requires: [],
          stepFree,
          geometry: coords,
          lengthM,
          weightS: edgeWeightS(lengthM, kind),
          osmWayId: w.id,
        })
        seg++
      }
      startIdx = i
    }
  }

  // 4. Named buildings -> places (centroid of member nodes).
  const places: Place[] = []
  for (const w of ways) {
    const t = w.tags ?? {}
    if (!t.building || !t.name) continue
    const coords = w.nodes.map((id) => nodeCoord.get(id)).filter((n): n is OsmNode => n !== undefined)
    if (coords.length === 0) continue
    const lat = coords.reduce((s, n) => s + n.lat, 0) / coords.length
    const lon = coords.reduce((s, n) => s + n.lon, 0) / coords.length
    places.push({ id: `osm:way/${w.id}`, name: t.name, lat, lon, area: areaOf(lat, lon, areas) })
  }

  const nodes = [...graphNodes.values()]
  return {
    graph: { nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } },
    places,
  }
}

function areaOf(lat: number, lon: number, areas: AreaBBox[]): Area | undefined {
  for (const {
    area,
    bbox: [s, w, n, e],
  } of areas) {
    if (lat >= s && lat <= n && lon >= w && lon <= e) return area
  }
  return undefined
}
