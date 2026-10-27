// Replayable edit log. My manual edits are stored as an ordered list of operations keyed to
// node/edge ids, NOT as an overwritten graph. Re-importing OSM and replaying the log
// reproduces the merged graph, so re-fetching never loses my work. An op that references an
// id that no longer exists (e.g. an OSM element that vanished) is reported, not thrown.
import type { EdgeKind, Graph, GraphEdge, OpenInterval } from './types'
import { polylineLengthM } from './geo'
import { edgeWeightS } from './weights'

export type EditOp =
  | { op: 'add_node'; id: number; lat: number; lon: number }
  | { op: 'move_node'; id: number; lat: number; lon: number }
  | { op: 'delete_node'; id: number }
  | {
      op: 'add_edge'
      id: string
      from: number
      to: number
      kind: EdgeKind
      requires?: string[]
      stepFree?: boolean
      hours?: OpenInterval[]
      geometry?: [number, number][]
    }
  | { op: 'update_edge'; id: string; set: Partial<Pick<GraphEdge, 'kind' | 'requires' | 'stepFree' | 'hours'>> }
  | { op: 'delete_edge'; id: string }

export interface Dangling {
  op: EditOp
  reason: string
}

export interface EditResult {
  graph: Graph
  dangling: Dangling[]
}

// Apply the edit log to a freshly-built graph. Returns a new graph plus any dangling refs.
export function applyEdits(graph: Graph, ops: EditOp[]): EditResult {
  const nodes = new Map(graph.nodes.map((n) => [n.id, { ...n }]))
  const edges = new Map(graph.edges.map((e) => [e.id, { ...e }]))
  const dangling: Dangling[] = []

  for (const op of ops) {
    switch (op.op) {
      case 'add_node':
        nodes.set(op.id, { id: op.id, lat: op.lat, lon: op.lon })
        break
      case 'move_node': {
        const n = nodes.get(op.id)
        if (!n) {
          dangling.push({ op, reason: `move_node: node ${op.id} not found` })
          break
        }
        n.lat = op.lat
        n.lon = op.lon
        break
      }
      case 'delete_node':
        if (!nodes.delete(op.id)) dangling.push({ op, reason: `delete_node: node ${op.id} not found` })
        break
      case 'add_edge': {
        const from = nodes.get(op.from)
        const to = nodes.get(op.to)
        if (!from || !to) {
          dangling.push({ op, reason: `add_edge: endpoint missing (${op.from} -> ${op.to})` })
          break
        }
        const geometry = op.geometry ?? [
          [from.lon, from.lat],
          [to.lon, to.lat],
        ]
        const lengthM = polylineLengthM(geometry)
        edges.set(op.id, {
          id: op.id,
          source: 'mine',
          from: op.from,
          to: op.to,
          kind: op.kind,
          requires: op.requires ?? [],
          stepFree: op.stepFree ?? true,
          hours: op.hours,
          geometry,
          lengthM,
          weightS: edgeWeightS(lengthM, op.kind),
        })
        break
      }
      case 'update_edge': {
        const e = edges.get(op.id)
        if (!e) {
          dangling.push({ op, reason: `update_edge: edge ${op.id} not found` })
          break
        }
        Object.assign(e, op.set)
        break
      }
      case 'delete_edge':
        if (!edges.delete(op.id)) dangling.push({ op, reason: `delete_edge: edge ${op.id} not found` })
        break
    }
  }

  const outNodes = [...nodes.values()]
  const outEdges = [...edges.values()]
  return {
    graph: {
      nodes: outNodes,
      edges: outEdges,
      meta: { ...graph.meta, nodeCount: outNodes.length, edgeCount: outEdges.length },
    },
    dangling,
  }
}
