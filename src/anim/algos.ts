// The seven searches, in the order the show walks through them — each a step up from the last. The
// captions are the article in miniature: what the algorithm does and why it beats the previous one.
// Leads with the mechanism (how it explores), not speed, per the project's framing.
import type { RoutingGraph, WeightFn } from '../algorithms/routing'
import { makeHeuristic } from '../algorithms/routing'
import type { Trace } from '../algorithms/trace'
import type { CHData } from '../algorithms/ch'
import { ch } from '../algorithms/ch'
import { bfs } from '../algorithms/bfs'
import { dfs } from '../algorithms/dfs'
import { dijkstra } from '../algorithms/dijkstra'
import { astar } from '../algorithms/astar'
import { biDijkstra } from '../algorithms/bidirectional'

export interface AlgoDef {
  key: string
  name: string
  caption: string // what it does + why it improves on the last
  optimal: boolean // does it return the least-walking-time route?
}

export const ALGORITHMS: AlgoDef[] = [
  { key: 'bfs', name: 'BFS', optimal: false, caption: 'Breadth-first — explores in rings of equal hop-count, so it finds the fewest-edges path. On a walk network that is usually not the fastest.' },
  { key: 'dfs', name: 'DFS', optimal: false, caption: 'Depth-first — plunges down one branch until stuck, then backtracks. It finds a path, almost never a good one.' },
  { key: 'dijkstra', name: 'Dijkstra', optimal: true, caption: 'Always expands the node reachable in the least walking time so far — so its route is optimal, but it fans out in every direction.' },
  { key: 'astar', name: 'A*', optimal: true, caption: 'Dijkstra plus a straight-line hint toward the target, so it stops fanning out and heads for the goal — same optimal route, far fewer nodes.' },
  { key: 'bidir', name: 'Bidirectional', optimal: true, caption: 'Two searches at once — one from the start, one from the target — meeting in the middle. Two small frontiers beat one big one.' },
  { key: 'ch', name: 'Contraction Hierarchies', optimal: true, caption: 'Precomputed shortcuts let the search leap over unimportant nodes, up to “important” paths and back down. It barely explores at all.' },
  { key: 'cch', name: 'Customizable CH', optimal: true, caption: 'The same leaps, but the hierarchy is built from the map’s shape alone — its weights are customized cheaply, so it reacts to crowding or a step-free toggle without rebuilding.' },
]

// One call that runs any of them between two node ids. chData = the prebuilt CH; cchData = the CCH
// structure already customized into a CHData (both queried by the same ch()).
export function runAlgo(
  key: string,
  rg: RoutingGraph,
  weight: WeightFn,
  chData: CHData,
  cchData: CHData,
  s: number,
  t: number,
): Trace {
  switch (key) {
    case 'bfs':
      return bfs(rg, s, t, { weight })
    case 'dfs':
      return dfs(rg, s, t, { weight })
    case 'astar':
      return astar(rg, s, t, { weight, heuristic: makeHeuristic(rg, t) })
    case 'bidir':
      return biDijkstra(rg, s, t, { weight })
    case 'ch':
      return ch(rg, chData, s, t, { weight })
    case 'cch':
      return ch(rg, cchData, s, t, { weight })
    case 'dijkstra':
    default:
      return dijkstra(rg, s, t, { weight })
  }
}
