// Turn-by-turn directions from a computed route — a pure route→text transform (no DOM), so it's
// unit-tested and reused across the animated / instant / reduced-motion paths. Honest to the data:
// the graph has no street names and no passages, so steps are geometry-derived ("Head northeast",
// "Turn left") plus stairs callouts ("Take the stairs"), each with a leg distance. Consecutive
// roughly-straight edges merge into one leg, so a 150-edge route reads as a handful of maneuvers.
import type { Graph, GraphEdge } from './graph/types'
import { bearingDeg } from './graph/geo'
import type { RouteResult } from './algorithms/trace'

export type Maneuver =
  | 'depart'
  | 'continue'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'stairs'
  | 'arrive'

export interface Step {
  maneuver: Maneuver
  text: string
  distanceM: number // meters walked on this leg (0 for arrive)
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
const compass = (brg: number): string => COMPASS[Math.round(((((brg % 360) + 360) % 360) / 45)) % 8]

// Signed smallest turn fromBrg→toBrg in (−180, 180]; positive = clockwise = to the right.
const angleDelta = (fromBrg: number, toBrg: number): number => {
  const d = ((toBrg - fromBrg + 540) % 360) - 180
  return d === -180 ? 180 : d
}

const classifyTurn = (delta: number): Maneuver => {
  const a = Math.abs(delta)
  if (a <= 25) return 'continue'
  const right = delta > 0
  if (a >= 160) return 'uturn'
  if (a >= 135) return right ? 'sharp-right' : 'sharp-left'
  if (a <= 55) return right ? 'slight-right' : 'slight-left'
  return right ? 'right' : 'left'
}

const TURN_TEXT: Record<string, string> = {
  continue: 'Continue',
  'slight-left': 'Slight left',
  left: 'Turn left',
  'sharp-left': 'Sharp left',
  'slight-right': 'Slight right',
  right: 'Turn right',
  'sharp-right': 'Sharp right',
  uturn: 'Make a U-turn',
}

// Build a directions function closing over the graph's node/edge lookups (built once; mirrors
// createOverlay). Returns a pure (route) => Step[].
export function makeDirections(graph: Graph): (route: RouteResult) => Step[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const))
  const edgeById = new Map(graph.edges.map((e) => [e.id, e] as const))

  // Entry/exit bearings of edge `e` when traversed starting at node `fromId`. Orients the polyline to
  // travel direction and skips zero-length segments (duplicate shape points) so bearings are real.
  const bearings = (e: GraphEdge, fromId: number, toId: number): { entry: number; exit: number } => {
    const pts = e.from === fromId ? e.geometry : [...e.geometry].reverse()
    let entry: number | null = null
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] !== pts[0][0] || pts[i][1] !== pts[0][1]) {
        entry = bearingDeg(pts[0][1], pts[0][0], pts[i][1], pts[i][0])
        break
      }
    }
    let exit: number | null = null
    const last = pts.length - 1
    for (let i = last - 1; i >= 0; i--) {
      if (pts[i][0] !== pts[last][0] || pts[i][1] !== pts[last][1]) {
        exit = bearingDeg(pts[i][1], pts[i][0], pts[last][1], pts[last][0])
        break
      }
    }
    if (entry != null && exit != null) return { entry, exit }
    // Degenerate geometry: fall back to the straight node-to-node bearing.
    const a = nodeById.get(fromId)
    const b = nodeById.get(toId)
    const brg = a && b ? bearingDeg(a.lat, a.lon, b.lat, b.lon) : 0
    return { entry: brg, exit: brg }
  }

  return (route: RouteResult): Step[] => {
    if (route.edges.length === 0) return [{ maneuver: 'arrive', text: 'Arrive at your destination', distanceM: 0 }]

    const steps: Step[] = []
    let legDist = 0
    let pending: Maneuver = 'depart'
    let departHeading = 0
    let prevExit: number | null = null
    let prevStairs = false

    const flush = (): void => {
      const text = pending === 'depart' ? `Head ${compass(departHeading)}` : pending === 'stairs' ? 'Take the stairs' : TURN_TEXT[pending]
      steps.push({ maneuver: pending, text, distanceM: legDist })
      legDist = 0
    }

    for (let i = 0; i < route.edges.length; i++) {
      const e = edgeById.get(route.edges[i])
      if (!e) continue
      const fromId = route.nodes[i]
      const toId = route.nodes[i + 1]
      const b = bearings(e, fromId, toId)
      const stairs = e.kind === 'stairs'

      if (i === 0) {
        pending = 'depart'
        departHeading = b.entry
      } else {
        const turn = prevExit != null ? classifyTurn(angleDelta(prevExit, b.entry)) : 'continue'
        if (stairs !== prevStairs) {
          // entering or leaving a flight of stairs — always a new step
          flush()
          pending = stairs ? 'stairs' : turn
        } else if (!stairs && turn !== 'continue') {
          // a real turn on a normal path
          flush()
          pending = turn
        } // else: same stair-state and roughly straight → keep accumulating this leg
      }
      legDist += e.lengthM
      prevExit = b.exit
      prevStairs = stairs
    }
    flush()
    steps.push({ maneuver: 'arrive', text: 'Arrive at your destination', distanceM: 0 })
    return steps
  }
}
