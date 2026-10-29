// Phase 5c benchmark: the CCH MECHANISM, not a speed race. Shows (1) customization — re-weighting the
// whole hierarchy for a metric in a few ms, the cheap step that lets a router react to changing
// weights without rebuilding; (2) the structural trade CCH makes vs plain CH — more shortcuts, bought
// by dropping witness searches, in exchange for metric independence; (3) that the CCH query is the
// same upward search as CH and returns Dijkstra's exact cost. Run: `npm run bench:cch`.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../src/graph/types'
import { haversineM } from '../src/graph/geo'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { dijkstra } from '../src/algorithms/dijkstra'
import { ch, type CHData } from '../src/algorithms/ch'
import { customize, type CCHStructure } from '../src/algorithms/cch'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const graph = JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
const structure = JSON.parse(readFileSync(resolve(ROOT, 'public/data/cch.json'), 'utf8')) as CCHStructure
const chJson = JSON.parse(readFileSync(resolve(ROOT, 'public/data/ch.json'), 'utf8')) as CHData
const rg = buildRoutingGraph(graph)
const weight = makeWeight(rg)
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1]

// ── (1) customization time: re-weight the whole map ──────────────────────────
for (let i = 0; i < 3; i++) customize(structure, rg, weight) // warm-up
const customMs = median(Array.from({ length: 11 }, () => {
  const t0 = performance.now()
  customize(structure, rg, weight)
  return performance.now() - t0
}))
const chData = customize(structure, rg, weight)

console.log(`[bench:cch] customization (re-weight entire hierarchy): ${customMs.toFixed(1)} ms`)
console.log(`[bench:cch] shortcuts — CCH ${structure.meta.shortcuts} (metric-independent nested-dissection order) vs CH ${chJson.meta.shortcuts} (edge-difference + witness)`)
console.log(`[bench:cch]   CCH trades ${(structure.meta.shortcuts / chJson.meta.shortcuts).toFixed(1)}× the shortcuts for the ability to re-customize without re-contracting\n`)

// ── (2) query parity on the same far pair as the other benches ───────────────
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

const d = dijkstra(rg, sourceId, targetId, { weight })
const cc = ch(rg, chData, sourceId, targetId, { weight })
console.log(`[bench:cch] far pair ${sourceId} → ${targetId}:`)
console.log(`  Dijkstra  settled ${d.stats.nodesSettled}   cost ${(d.route!.costS / 60).toFixed(2)} min`)
console.log(`  CCH       settled ${cc.stats.nodesSettled}   cost ${(cc.route!.costS / 60).toFixed(2)} min   (same upward query as CH)`)

// ── (3) correctness: CCH == Dijkstra over random pairs ───────────────────────
let mismatch = 0
let pairs = 0
for (let k = 0; k < 300; k++) {
  const s = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
  const t = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
  if (s === t) continue
  const dd = dijkstra(rg, s, t, { weight })
  const q = ch(rg, chData, s, t, { weight })
  if (dd.stats.found !== q.stats.found || (dd.stats.found && Math.abs(dd.route!.costS - q.route!.costS) > 1e-6)) mismatch++
  else pairs++
}
console.log(`\n[bench:cch] CCH == Dijkstra cost over ${pairs} random pairs: ${mismatch === 0 ? 'OK' : `FAIL (${mismatch})`}`)
if (mismatch > 0) process.exit(1)
