// Phase 5c: build the metric-INDEPENDENT CCH structure once, then demonstrate CUSTOMIZATION — cheaply
// re-weighting it for several metrics without re-contracting: base, step-free, and a class-change
// crowding snapshot. Self-checks each customization against Dijkstra, then ships the structure as
// public/data/cch.json (the app customizes in-browser per "Leave at" time / toggle in Phase 6).
// Run: `npm run build:cch`.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../src/graph/types'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { buildCCH, customize } from '../src/algorithms/cch'
import { ch } from '../src/algorithms/ch'
import { dijkstra } from '../src/algorithms/dijkstra'
import { hmsToSec, type Schedule } from '../src/graph/time'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const graph = JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
const crowding = JSON.parse(readFileSync(resolve(ROOT, 'public/data/crowding.json'), 'utf8')) as { dist: Record<string, number> }
const schedule = JSON.parse(readFileSync(resolve(ROOT, 'config/schedule.json'), 'utf8')) as Schedule
const rg = buildRoutingGraph(graph)

// ── the metric-independent structure (built once) ────────────────────────────
console.log(`[build:cch] nested dissection + contracting ${graph.nodes.length} nodes / ${graph.edges.length} edges…`)
const t0 = performance.now()
const structure = buildCCH(rg)
const buildMs = performance.now() - t0
structure.meta.contractMs = Math.round(buildMs)
structure.meta.builtAt = new Date().toISOString()

// ── metrics to customize for (one structure, many weightings) ────────────────
const peak = schedule.classEndTimes?.length ? hmsToSec(schedule.classEndTimes[0]) + (schedule.crowding.peakLagS ?? 90) : 12 * 3600
const cdist = crowding.dist ?? {}
// Snapshot customization (the approved time-dependent approach): FREEZE the crowding metric at the
// departure instant so it's static — CH/CCH price at departure, so a frozen snapshot is exactly what
// customization consumes and what a static Dijkstra must match. (The live, arrival-time-accurate
// router stays the unidirectional search; a static CCH can't be it.)
const td = makeWeight(rg, { time: { departureSecOfDay: peak, isWeekend: false, schedule, distToAcademicM: (id) => cdist[id] ?? null } })
const metrics: { name: string; weight: ReturnType<typeof makeWeight> }[] = [
  { name: 'base', weight: makeWeight(rg) },
  { name: 'step-free', weight: makeWeight(rg, { stepFreeOnly: true }) },
  { name: `crowding@${schedule.classEndTimes?.[0] ?? '12:00'}`, weight: (ei, _e) => td(ei, 0) },
]

console.log(`[build:cch] structure: ${structure.meta.origArcs} original + ${structure.meta.shortcuts} shortcuts in ${(buildMs / 1000).toFixed(2)} s`)
console.log('[build:cch] customize (one structure, re-weighted per metric) + self-check vs Dijkstra:')
let anyFail = false
for (const m of metrics) {
  const c0 = performance.now()
  const chData = customize(structure, rg, m.weight)
  const customMs = performance.now() - c0
  let mismatch = 0
  for (let k = 0; k < 40; k++) {
    const s = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
    const t = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
    if (s === t) continue
    const d = dijkstra(rg, s, t, { weight: m.weight })
    const q = ch(rg, chData, s, t, { weight: m.weight })
    if (d.stats.found !== q.stats.found || (d.stats.found && Math.abs(d.route!.costS - q.route!.costS) > 1e-6)) mismatch++
  }
  if (mismatch > 0) anyFail = true
  console.log(`  ${m.name.padEnd(16)} customize ${customMs.toFixed(0).padStart(4)} ms   self-check vs Dijkstra ${mismatch === 0 ? 'OK' : `FAIL (${mismatch})`}`)
}

if (anyFail) {
  console.error('[build:cch] FAIL: a customization disagreed with Dijkstra — not shipping.')
  process.exit(1)
}

const json = JSON.stringify(structure)
writeFileSync(resolve(ROOT, 'public/data/cch.json'), json)
console.log(`[build:cch] wrote public/data/cch.json  (${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB, metric-independent structure)`)
