// THROWAWAY preset finder (not in `rebuild`, not shipped). Finds place pairs whose shortest walk
// CHANGES between off-peak and a class-change peak, so the user can drop the good ones into
// config/presets.json. Uses a plain array-scan Dijkstra over the time-dependent cost
// (effectiveWeightS) — deliberately not the real traced/heap Dijkstra (that's Phase 5). Delete or
// repoint at the real one once Phase 5 lands.
// ponytail: O(V^2) Dijkstra, one-shot CLI, run occasionally — no heap needed at campus size.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Graph, GraphEdge, Place } from '../src/graph/types'
import { snapToNearestNode } from '../src/graph/editing'
import { effectiveWeightS, hmsToSec, type Schedule, type When } from '../src/graph/time'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
type Adj = Map<number, { to: number; edge: GraphEdge }[]>

function buildAdj(graph: Graph): Adj {
  const adj: Adj = new Map()
  for (const n of graph.nodes) adj.set(n.id, [])
  for (const e of graph.edges) {
    adj.get(e.from)?.push({ to: e.to, edge: e })
    adj.get(e.to)?.push({ to: e.from, edge: e }) // walking is undirected
  }
  return adj
}

// Array-scan Dijkstra over effectiveWeightS; returns cost (seconds) + the node path.
function dijkstra(adj: Adj, start: number, goal: number, when: When, s: Schedule, cdist: Record<string, number>) {
  const dist = new Map<number, number>([[start, 0]])
  const prev = new Map<number, number>()
  const settled = new Set<number>()
  const nodes = [...adj.keys()]
  for (;;) {
    let u = -1
    let best = Infinity
    for (const n of nodes) {
      if (settled.has(n)) continue
      const d = dist.get(n) ?? Infinity
      if (d < best) {
        best = d
        u = n
      }
    }
    if (u === -1 || best === Infinity || u === goal) break
    settled.add(u)
    for (const { to, edge } of adj.get(u) ?? []) {
      if (settled.has(to)) continue
      const w = effectiveWeightS(edge.weightS, edge.hours, cdist[edge.id] ?? null, when, s)
      if (!Number.isFinite(w)) continue // closed edge → absent for this query
      const nd = best + w
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd)
        prev.set(to, u)
      }
    }
  }
  const path: number[] = []
  if ((dist.get(goal) ?? Infinity) < Infinity) {
    let c: number | undefined = goal
    while (c !== undefined) {
      path.unshift(c)
      c = prev.get(c)
    }
  }
  return { cost: dist.get(goal) ?? Infinity, path }
}

const EMPTY_SCHED: Schedule = {
  classEndTimes: [],
  crowding: { windowMinutes: 10, rampShape: 'cos', peakMultiplier: 1, radiusMeters: 0 },
  academicBuildings: [],
}

// Smoke check: on 1-2(5)-3 vs direct 1-3(20), the shortest path is 1→2→3.
function selfCheck(): void {
  const mk = (id: string, from: number, to: number, w: number): GraphEdge => ({
    id,
    source: 'mine',
    from,
    to,
    kind: 'footway',
    stepFree: true,
    geometry: [
      [0, 0],
      [0, 0],
    ],
    lengthM: 0,
    weightS: w,
  })
  const g: Graph = {
    nodes: [
      { id: 1, lat: 0, lon: 0 },
      { id: 2, lat: 0, lon: 0 },
      { id: 3, lat: 0, lon: 0 },
    ],
    edges: [mk('a', 1, 2, 5), mk('b', 2, 3, 5), mk('c', 1, 3, 20)],
    meta: { nodeCount: 3, edgeCount: 3 },
  }
  const { path } = dijkstra(buildAdj(g), 1, 3, { secOfDay: 0, isWeekend: false }, EMPTY_SCHED, {})
  if (JSON.stringify(path) !== JSON.stringify([1, 2, 3])) throw new Error(`self-check failed: ${JSON.stringify(path)}`)
}

function main(): void {
  selfCheck()
  const graph = JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
  const crowding = JSON.parse(readFileSync(resolve(ROOT, 'public/data/crowding.json'), 'utf8')) as {
    dist: Record<string, number>
  }
  const sched = JSON.parse(readFileSync(resolve(ROOT, 'config/schedule.json'), 'utf8')) as Schedule
  const places = JSON.parse(readFileSync(resolve(ROOT, 'data/processed/places.json'), 'utf8')) as Place[]

  if (!sched.classEndTimes?.length) {
    console.log(
      '[find-presets] No classEndTimes in config/schedule.json. Fill classEndTimes + academicBuildings,\n' +
        '               run `npm run build:crowding`, then re-run this to find crowding-sensitive routes.',
    )
    return
  }

  const adj = buildAdj(graph)
  const cdist = crowding.dist ?? {}
  const peakLag = sched.crowding.peakLagS ?? 90
  const OFFPEAK: When = { secOfDay: 3 * 3600, isWeekend: false } // 03:00, no crowd

  // Sample up to ~12 named places that sit on the graph.
  const sample: { name: string; node: number }[] = []
  const step = Math.max(1, Math.floor(places.length / 24))
  for (let i = 0; i < places.length && sample.length < 12; i += step) {
    const n = snapToNearestNode(graph.nodes, places[i].lon, places[i].lat, 60)
    if (n) sample.push({ name: places[i].name, node: n.id })
  }

  console.log(`[find-presets] testing ${sample.length} places across ${sched.classEndTimes.length} class time(s)…`)
  let found = 0
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const a = sample[i]
      const b = sample[j]
      const base = dijkstra(adj, a.node, b.node, OFFPEAK, sched, cdist)
      if (!base.path.length) continue
      for (const E of sched.classEndTimes) {
        const peaked = dijkstra(adj, a.node, b.node, { secOfDay: hmsToSec(E) + peakLag, isWeekend: false }, sched, cdist)
        if (peaked.path.length && JSON.stringify(peaked.path) !== JSON.stringify(base.path)) {
          console.log(
            `  "${a.name}" → "${b.name}": reroutes at ${E}  (off-peak ${(base.cost / 60).toFixed(1)} min vs peak ${(peaked.cost / 60).toFixed(1)} min)`,
          )
          found++
          break
        }
      }
    }
  }
  console.log(
    found
      ? `[find-presets] ${found} crowding-sensitive pair(s). Add the best to config/presets.json.`
      : '[find-presets] No route changes. Try a larger peakMultiplier/radius or more academic buildings.',
  )
}

main()
