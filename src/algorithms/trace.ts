// A Trace is the ordered event stream an algorithm emits as it searches, plus summary stats and the
// final route. Algorithms stay pure and produce this; Phase 6 replays it for the animation, so the
// animation never re-runs the search. No DOM here — this is plain data.

export type TraceEventType =
  | 'push' // a node entered the frontier
  | 'settle' // a node was removed from the frontier and finalized
  | 'relax' // an edge improved a neighbour's best-known cost
  | 'skip' // an edge was unusable for this query (not step-free / closed) and ignored
  | 'meet' // the two halves of a bidirectional search touched the same node
  | 'found' // the target was reached (search can stop)
  | 'shortcut' // a CH shortcut was unpacked into its two underlying arcs (node = the contracted via-node)

export interface TraceEvent {
  type: TraceEventType
  node?: number // node id (push / settle / meet / found)
  edge?: string // edge id (relax / skip)
  side?: 'f' | 'b' // search direction, for the bidirectional algorithms
}

export interface AlgoStats {
  nodesSettled: number
  edgesRelaxed: number
  pushes: number
  skipped: number // edges skipped for access
  found: boolean
}

export interface RouteResult {
  nodes: number[] // node-id path, source..target
  edges: string[] // edge ids along the route
  costS: number // total walking seconds (Infinity if unreachable)
  distanceM: number // total length in meters
}

export interface Trace {
  algo: string
  events: TraceEvent[]
  stats: AlgoStats
  route: RouteResult | null
}
