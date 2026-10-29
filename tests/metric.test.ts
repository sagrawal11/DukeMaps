// The Phase 6c payoff, as a guarantee: when the cost metric changes (a crowded departure time, or a
// step-free toggle), re-CUSTOMIZING the one metric-independent CCH structure actually reacts — it
// reroutes, it matches Dijkstra under the new metric, and it never uses a forbidden edge. cch.test.ts
// already proves CCH == Dijkstra under a FIXED metric; this proves the live re-weighting the UI relies
// on. The structure is shared by reference across customizations — proof we re-weight, not rebuild.
import { describe, it, expect } from 'vitest'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { dijkstra } from '../src/algorithms/dijkstra'
import { ch } from '../src/algorithms/ch'
import { buildCCH, customize } from '../src/algorithms/cch'
import { hmsToSec, type Schedule } from '../src/graph/time'
import type { Graph, GraphEdge, GraphNode } from '../src/graph/types'

// Tiny graph builder (mirrors tests/cch.test.ts): [id, from, to, weightS, stepFree?].
type EdgeSpec = [string, number, number, number, boolean?]
function mkGraph(ids: number[], specs: EdgeSpec[]): Graph {
  const nodes: GraphNode[] = ids.map((id) => ({ id, lon: -78.9 + id * 0.001, lat: 36.0 + id * 0.0007 }))
  const edges: GraphEdge[] = specs.map(([id, from, to, weightS, stepFree = true]) => ({
    id,
    source: 'osm',
    from,
    to,
    kind: 'footway',
    stepFree,
    geometry: [
      [-78.9 + from * 0.001, 36.0],
      [-78.9 + to * 0.001, 36.0],
    ],
    lengthM: weightS,
    weightS,
  }))
  return { nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } }
}

// A wide bump so the whole short corridor is firmly "peak" at a 12:00 departure and clearly off-peak
// four hours earlier — keeps the reaction unambiguous, with no sensitivity to the decay arithmetic.
const SCHEDULE: Schedule = {
  classEndTimes: ['12:00'],
  crowding: { windowMinutes: 30, rampShape: 'cos', peakMultiplier: 2, radiusMeters: 120, peakLagS: 0 },
  academicBuildings: [],
}

describe('live re-customization reacts to a changed metric (the Phase 6c payoff)', () => {
  it('class-change crowding: re-customize the same structure → reroute around the crowded corridor', () => {
    // 1→2→3→4→5 is a short corridor beside an academic building (crowdable); edge e is a longer bypass.
    const g = mkGraph(
      [1, 2, 3, 4, 5],
      [
        ['a', 1, 2, 60],
        ['b', 2, 3, 60],
        ['c', 3, 4, 60],
        ['d', 4, 5, 60],
        ['e', 1, 5, 300], // bypass, away from the building
      ],
    )
    const rg = buildRoutingGraph(g)
    const corridor = new Set(['a', 'b', 'c', 'd'])
    const distToAcademicM = (id: string): number | null => (corridor.has(id) ? 50 : null)
    const struct = buildCCH(rg) // metric-INDEPENDENT structure, built once

    const mkTime = (hhmm: string) =>
      makeWeight(rg, { time: { departureSecOfDay: hmsToSec(hhmm), isWeekend: false, schedule: SCHEDULE, distToAcademicM } })
    const wOff = mkTime('08:00') // off-peak: corridor at base speed
    const wPeak = mkTime('12:00') // peak: corridor ~2×

    const chOff = customize(struct, rg, wOff)
    const chPeak = customize(struct, rg, wPeak) // re-customize ONLY — no re-contract

    // the structure (rank, node order) is shared by reference — proof we re-weighted, didn't rebuild
    expect(chPeak.rank).toBe(chOff.rank)
    expect(chPeak.nodeIds).toBe(chOff.nodeIds)

    const rOff = ch(rg, chOff, 1, 5, { weight: wOff })
    const rPeak = ch(rg, chPeak, 1, 5, { weight: wPeak })

    // off-peak: the short corridor wins (240 < 300), and CCH == Dijkstra exactly (flat metric)
    expect(rOff.route!.nodes).toEqual([1, 2, 3, 4, 5])
    expect(rOff.route!.costS).toBeCloseTo(dijkstra(rg, 1, 5, { weight: wOff }).route!.costS, 6)

    // peak: crowding makes the corridor expensive → the route reroutes to the bypass and costs more
    expect(rPeak.route!.nodes).toEqual([1, 5])
    expect(rPeak.route!.costS).toBeGreaterThan(rOff.route!.costS)
    expect(rPeak.route!.costS).toBeCloseTo(dijkstra(rg, 1, 5, { weight: wPeak }).route!.costS, 6)
  })

  it('step-free: re-customize drops stairs → detour, exact vs Dijkstra, access-safe through shortcuts', () => {
    const g = mkGraph(
      [1, 2, 3, 4],
      [
        ['stairs', 1, 2, 10, false], // short but not step-free
        ['x', 1, 3, 40],
        ['y', 3, 2, 40], // step-free detour 1→3→2
        ['z', 2, 4, 10],
      ],
    )
    const rg = buildRoutingGraph(g)
    const struct = buildCCH(rg)
    const wBase = makeWeight(rg)
    const wSF = makeWeight(rg, { stepFreeOnly: true })
    const chBase = customize(struct, rg, wBase)
    const chSF = customize(struct, rg, wSF)
    expect(chSF.rank).toBe(chBase.rank) // re-customized, not rebuilt

    const rBase = ch(rg, chBase, 1, 4, { weight: wBase })
    const rSF = ch(rg, chSF, 1, 4, { weight: wSF })

    expect(rBase.route!.nodes).toEqual([1, 2, 4]) // base: straight over the stairs (20 s)
    expect(rSF.route!.nodes).toEqual([1, 3, 2, 4]) // step-free: detour (90 s)
    expect(rSF.route!.costS).toBeGreaterThan(rBase.route!.costS) // reacts
    expect(rSF.route!.edges).not.toContain('stairs') // access-safety, even through unpacked shortcuts
    expect(rBase.route!.costS).toBeCloseTo(dijkstra(rg, 1, 4, { weight: wBase }).route!.costS, 6)
    expect(rSF.route!.costS).toBeCloseTo(dijkstra(rg, 1, 4, { weight: wSF }).route!.costS, 6)
  })
})
