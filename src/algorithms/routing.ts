// The routing view of the graph the algorithms run on, plus the two closures they take: a cost
// function (time-dependent + access-aware) and the A* heuristic. Keeping cost/heuristic as closures
// means the algorithms themselves stay tiny and oblivious to crowding, hours, and toggles.
import type { Graph, GraphEdge, GraphNode } from '../graph/types'
import { haversineM } from '../graph/geo'
import { WALK_SPEED_MPS } from '../graph/weights'
import { effectiveWeightS, type Schedule } from '../graph/time'

export interface Arc {
  to: number // neighbour node index
  edgeIdx: number // index into edges[]
}

// Nodes are re-indexed 0..n-1 so the algorithms can use flat arrays for dist/visited (faster and
// simpler than keying by the sparse OSM node ids). Walking edges are undirected, so each edge
// becomes an arc in both adjacency lists.
export interface RoutingGraph {
  nodes: GraphNode[] // index -> node
  edges: GraphEdge[] // index -> edge
  adj: Arc[][] // index -> outgoing arcs
  indexOf: Map<number, number> // node id -> index
}

export function buildRoutingGraph(graph: Graph): RoutingGraph {
  const nodes = graph.nodes
  const indexOf = new Map<number, number>()
  nodes.forEach((n, i) => indexOf.set(n.id, i))
  const adj: Arc[][] = nodes.map(() => [])
  graph.edges.forEach((e, edgeIdx) => {
    const a = indexOf.get(e.from)
    const b = indexOf.get(e.to)
    if (a === undefined || b === undefined) return // edge referencing a missing node (shouldn't happen)
    adj[a].push({ to: b, edgeIdx })
    adj[b].push({ to: a, edgeIdx })
  })
  return { nodes, edges: graph.edges, adj, indexOf }
}

// Cost of traversing an edge, given how many seconds have elapsed since departure when the walker
// reaches it. Infinity means "unusable for this query" and the algorithms treat the edge as absent.
export type WeightFn = (edgeIdx: number, elapsedS: number) => number
// Estimated remaining cost from a node index to the target (0 for plain Dijkstra).
export type Heuristic = (nodeIdx: number) => number

export interface CostOptions {
  stepFreeOnly?: boolean // drop non-step-free edges (the one surviving access toggle)
  time?: {
    departureSecOfDay: number
    isWeekend: boolean
    schedule: Schedule
    distToAcademicM: (edgeId: string) => number | null // per-edge crowding input (from crowding.json)
  }
}

// Build the cost closure. Without `time` it's the static base weight (used by the hand-built tests
// and anywhere crowding is irrelevant); with `time` it evaluates crowding + hours at the ARRIVAL
// time (departure + elapsed), which is what makes the routing time-dependent.
export function makeWeight(rg: RoutingGraph, opts: CostOptions = {}): WeightFn {
  const { stepFreeOnly, time } = opts
  return (edgeIdx, elapsedS) => {
    const e = rg.edges[edgeIdx]
    if (stepFreeOnly && !e.stepFree) return Infinity
    if (!time) return e.weightS
    const secOfDay = (((time.departureSecOfDay + elapsedS) % 86400) + 86400) % 86400
    return effectiveWeightS(e.weightS, e.hours, time.distToAcademicM(e.id), { secOfDay, isWeekend: time.isWeekend }, time.schedule)
  }
}

// A* heuristic: straight-line distance to the target expressed as seconds via the fastest walking
// speed. Admissible — no edge is ever traversed faster than WALK_SPEED_MPS and crowding only adds
// time, so this never exceeds the true remaining cost, and A* returns Dijkstra's optimal answer.
export function makeHeuristic(rg: RoutingGraph, targetId: number): Heuristic {
  const t = rg.indexOf.get(targetId)
  if (t === undefined) return () => 0
  const tn = rg.nodes[t]
  return (v) => haversineM(rg.nodes[v].lat, rg.nodes[v].lon, tn.lat, tn.lon) / WALK_SPEED_MPS
}
