// Phase 5a benchmark: the six hand-written searches on the real Duke graph, same source→target for
// all of them, so the numbers are directly comparable. Reports per-algorithm nodes settled, edges
// relaxed, pushes, query time, and the route (cost / distance / hops). Run: `npm run bench:algo`.
// Copy the printed table into notes/measurements.md.
//
// Metric: BASE walking weight (off-peak, crowding multiplier = 1 everywhere) — the apples-to-apples
// comparison. It's the one metric where the four optimal searches (Dijkstra, A*, biDijkstra, biAStar)
// must return the SAME cost, and where bidirectional's departure-time snapshot equals the weight the
// others see. Time-dependent crowding only scales absolute costs; it doesn't change the structural
// story (A*/bidirectional settle fewer nodes than Dijkstra, BFS minimizes hops not time, DFS wanders).
// That story — crowding reshaping a route — is the Phase 6 show.
//
// Pair: the graph nodes nearest the SW and NE corners of the campus bounding box — a deterministic,
// reproducible diagonal across campus, the far-apart case where guided search pays off most.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../src/graph/types'
import { haversineM } from '../src/graph/geo'
import { WALK_SPEED_MPS } from '../src/graph/weights'
import { buildRoutingGraph, makeWeight, makeHeuristic } from '../src/algorithms/routing'
import type { RoutingGraph } from '../src/algorithms/routing'
import type { Trace } from '../src/algorithms/trace'
import { bfs } from '../src/algorithms/bfs'
import { dfs } from '../src/algorithms/dfs'
import { dijkstra } from '../src/algorithms/dijkstra'
import { astar } from '../src/algorithms/astar'
import { biDijkstra, biAStar } from '../src/algorithms/bidirectional'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMING_RUNS = 51 // odd, so the median is a real sample
const WARMUP_RUNS = 10 // let the JIT settle before timing

const graph = JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
const rg = buildRoutingGraph(graph)
const weight = makeWeight(rg) // base weight: no `time` opt → edge.weightS, crowding inert

// Node nearest a lon/lat corner (haversine). Deterministic, so the pair is reproducible.
function nearestNodeTo(lon: number, lat: number): number {
  let best = -1
  let bd = Infinity
  for (const n of graph.nodes) {
    const d = haversineM(lat, lon, n.lat, n.lon)
    if (d < bd) {
      bd = d
      best = n.id
    }
  }
  return best
}

let minLon = Infinity
let minLat = Infinity
let maxLon = -Infinity
let maxLat = -Infinity
for (const n of graph.nodes) {
  if (n.lon < minLon) minLon = n.lon
  if (n.lon > maxLon) maxLon = n.lon
  if (n.lat < minLat) minLat = n.lat
  if (n.lat > maxLat) maxLat = n.lat
}
const sourceId = nearestNodeTo(minLon, minLat) // SW corner
const targetId = nearestNodeTo(maxLon, maxLat) // NE corner

const sNode = graph.nodes.find((n) => n.id === sourceId)!
const tNode = graph.nodes.find((n) => n.id === targetId)!
const crowFlightM = haversineM(sNode.lat, sNode.lon, tNode.lat, tNode.lon)
const lowerBoundS = crowFlightM / WALK_SPEED_MPS // the A* heuristic's value at the source

console.log(`[bench:algo] graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`)
console.log(`[bench:algo] source ${sourceId} (SW) → target ${targetId} (NE)`)
console.log(
  `[bench:algo] straight-line: ${(crowFlightM / 1000).toFixed(2)} km  ·  walk lower bound ${(lowerBoundS / 60).toFixed(1)} min\n`,
)

type Runner = (rg: RoutingGraph) => Trace
const hT = makeHeuristic(rg, targetId)
const algos: { name: string; run: Runner }[] = [
  { name: 'BFS', run: (g) => bfs(g, sourceId, targetId, { weight }) },
  { name: 'DFS', run: (g) => dfs(g, sourceId, targetId, { weight }) },
  { name: 'Dijkstra', run: (g) => dijkstra(g, sourceId, targetId, { weight }) },
  { name: 'A*', run: (g) => astar(g, sourceId, targetId, { weight, heuristic: hT }) },
  { name: 'biDijkstra', run: (g) => biDijkstra(g, sourceId, targetId, { weight }) },
  { name: 'biA*', run: (g) => biAStar(g, sourceId, targetId, { weight }) },
]

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[(s.length - 1) >> 1]
}

interface Row {
  name: string
  settled: number
  relaxed: number
  pushes: number
  found: boolean
  costMin: number
  distM: number
  hops: number
  ms: number
}

const rows: Row[] = []
for (const { name, run } of algos) {
  const t = run(rg) // one run for the (deterministic) stats + route
  for (let i = 0; i < WARMUP_RUNS; i++) run(rg)
  const times: number[] = []
  for (let i = 0; i < TIMING_RUNS; i++) {
    const t0 = performance.now()
    run(rg)
    times.push(performance.now() - t0)
  }
  rows.push({
    name,
    settled: t.stats.nodesSettled,
    relaxed: t.stats.edgesRelaxed,
    pushes: t.stats.pushes,
    found: t.stats.found,
    costMin: t.route ? t.route.costS / 60 : Infinity,
    distM: t.route ? t.route.distanceM : Infinity,
    hops: t.route ? t.route.nodes.length - 1 : -1,
    ms: median(times),
  })
}

// ── table ────────────────────────────────────────────────────────────────────
const H = ['algorithm', 'settled', 'relaxed', 'pushes', 'cost(min)', 'dist(m)', 'hops', 'median ms']
const fmt = (r: Row) => [
  r.name,
  String(r.settled),
  String(r.relaxed),
  String(r.pushes),
  r.costMin.toFixed(2),
  r.distM.toFixed(0),
  String(r.hops),
  r.ms.toFixed(3),
]
const widths = H.map((h, i) => Math.max(h.length, ...rows.map((r) => fmt(r)[i].length)))
const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i])).join('  ')
console.log(line(H))
console.log(widths.map((w) => '-'.repeat(w)).join('  '))
for (const r of rows) console.log(line(fmt(r)))

// ── invariants (a benchmark that's silently wrong is worse than none) ─────────
const opt = rows.filter((r) => ['Dijkstra', 'A*', 'biDijkstra', 'biA*'].includes(r.name))
const optCost = opt[0].costMin
const costsAgree = opt.every((r) => Math.abs(r.costMin - optCost) < 1e-6 / 60)
const bfsRow = rows.find((r) => r.name === 'BFS')!
const dfsRow = rows.find((r) => r.name === 'DFS')!
const dij = rows.find((r) => r.name === 'Dijkstra')!
const astarSettlesFewer = rows.find((r) => r.name === 'A*')!.settled <= dij.settled

console.log('\nchecks:')
console.log(`  all four optimal searches agree on cost   ${costsAgree ? 'OK' : 'FAIL'}  (${optCost.toFixed(3)} min)`)
console.log(`  BFS uses no more hops than Dijkstra        ${bfsRow.hops <= dij.hops ? 'OK' : 'FAIL'}  (BFS ${bfsRow.hops} vs Dijkstra ${dij.hops})`)
console.log(`  A* settles ≤ Dijkstra                      ${astarSettlesFewer ? 'OK' : 'FAIL'}  (A* ${rows.find((r) => r.name === 'A*')!.settled} vs ${dij.settled})`)
console.log(`  BFS route no better (slower/equal) in time ${bfsRow.costMin >= optCost - 1e-9 ? 'OK' : 'FAIL'}  (BFS ${bfsRow.costMin.toFixed(2)} vs opt ${optCost.toFixed(2)} min)`)
console.log(`  DFS route no better than optimal           ${dfsRow.costMin >= optCost - 1e-9 ? 'OK' : 'FAIL'}  (DFS ${dfsRow.costMin.toFixed(2)} vs opt ${optCost.toFixed(2)} min)`)

if (!costsAgree || bfsRow.hops > dij.hops || !astarSettlesFewer) {
  console.error('\n[bench:algo] FAIL: an invariant broke — see checks above.')
  process.exit(1)
}
