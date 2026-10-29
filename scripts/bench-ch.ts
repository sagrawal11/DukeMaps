// Phase 5b benchmark: the CH query vs Dijkstra and biA* on the real Duke graph, using the prebuilt
// public/data/ch.json. Reports the same fixed far pair as `npm run bench:algo` (SW↔NE corners) plus
// an average over many random pairs — nodes settled, query time, and the speedup CH buys.
// Run: `npm run bench:ch` (after `npm run build:ch`). Copy the numbers into notes/measurements.md.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../src/graph/types'
import { haversineM } from '../src/graph/geo'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { dijkstra } from '../src/algorithms/dijkstra'
import { biAStar } from '../src/algorithms/bidirectional'
import { ch, type CHData } from '../src/algorithms/ch'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMING_RUNS = 51
const WARMUP_RUNS = 10
const RANDOM_PAIRS = 300

const graph = JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
const chData = JSON.parse(readFileSync(resolve(ROOT, 'public/data/ch.json'), 'utf8')) as CHData
const rg = buildRoutingGraph(graph)
const weight = makeWeight(rg)

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1]
const timeMs = (fn: () => unknown): number => {
  for (let i = 0; i < WARMUP_RUNS; i++) fn()
  const ts: number[] = []
  for (let i = 0; i < TIMING_RUNS; i++) {
    const t0 = performance.now()
    fn()
    ts.push(performance.now() - t0)
  }
  return median(ts)
}

// ── the same fixed far pair as bench:algo (SW↔NE corners) ────────────────────
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
const sourceId = nearestNodeTo(minLon, minLat)
const targetId = nearestNodeTo(maxLon, maxLat)

console.log(`[bench:ch] graph ${graph.nodes.length} nodes · ch.json ${chData.meta.shortcuts} shortcuts, ${chData.meta.preprocMs} ms preproc`)
console.log(`[bench:ch] far pair ${sourceId} (SW) → ${targetId} (NE)\n`)

const runners = [
  { name: 'Dijkstra', run: () => dijkstra(rg, sourceId, targetId, { weight }) },
  { name: 'biA*', run: () => biAStar(rg, sourceId, targetId, { weight }) },
  { name: 'CH', run: () => ch(rg, chData, sourceId, targetId, { weight }) },
]
const H = ['algorithm', 'settled', 'cost(min)', 'median ms']
const rows = runners.map(({ name, run }) => {
  const t = run()
  return [name, String(t.stats.nodesSettled), (t.route!.costS / 60).toFixed(2), timeMs(run).toFixed(3)]
})
const widths = H.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i])).join('  ')
console.log(line(H))
console.log(widths.map((w) => '-'.repeat(w)).join('  '))
for (const r of rows) console.log(line(r))

const dSettled = dijkstra(rg, sourceId, targetId, { weight }).stats.nodesSettled
const cSettled = ch(rg, chData, sourceId, targetId, { weight }).stats.nodesSettled
console.log(`\nfar-pair speedup: CH settles ${(dSettled / cSettled).toFixed(1)}× fewer nodes than Dijkstra`)

// ── average over many random pairs ───────────────────────────────────────────
let dS = 0
let cS = 0
let dMs = 0
let cMs = 0
let pairs = 0
let mismatch = 0
for (let k = 0; k < RANDOM_PAIRS; k++) {
  const s = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
  const t = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
  if (s === t) continue
  const d = dijkstra(rg, s, t, { weight })
  const c = ch(rg, chData, s, t, { weight })
  if (d.stats.found !== c.stats.found || (d.stats.found && Math.abs(d.route!.costS - c.route!.costS) > 1e-6)) mismatch++
  if (!d.stats.found) continue
  pairs++
  dS += d.stats.nodesSettled
  cS += c.stats.nodesSettled
  dMs += timeMs(() => dijkstra(rg, s, t, { weight }))
  cMs += timeMs(() => ch(rg, chData, s, t, { weight }))
}
console.log(`\naveraged over ${pairs} random reachable pairs:`)
console.log(`  nodes settled:  Dijkstra ${(dS / pairs).toFixed(0)}   CH ${(cS / pairs).toFixed(0)}   (${(dS / cS).toFixed(1)}× fewer)`)
console.log(`  query time:     Dijkstra ${(dMs / pairs).toFixed(3)} ms   CH ${(cMs / pairs).toFixed(3)} ms   (${(dMs / cMs).toFixed(1)}× faster)`)
console.log(`  CH == Dijkstra cost: ${mismatch === 0 ? 'OK' : `FAIL (${mismatch})`}`)

if (mismatch > 0) {
  console.error('\n[bench:ch] FAIL: CH disagreed with Dijkstra.')
  process.exit(1)
}
