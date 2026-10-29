// Phase 5b: build the contraction hierarchy from public/data/graph.json and ship it as
// public/data/ch.json (committed, static — the app fetches it at runtime like graph.json). Static
// base metric (crowding/hours are not baked in; that's 5c/CCH). Run: `npm run build:ch`.
//
// Before shipping, a self-check runs CH against Dijkstra on random real-graph pairs — a fast guard
// that the hierarchy we're about to commit actually returns optimal costs (a wrong index is worse
// than none). Reports preprocessing time, shortcut count, and file size for notes/measurements.md.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../src/graph/types'
import { buildRoutingGraph, makeWeight } from '../src/algorithms/routing'
import { buildCH, ch } from '../src/algorithms/ch'
import { dijkstra } from '../src/algorithms/dijkstra'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const graph = JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
const rg = buildRoutingGraph(graph)
const weight = makeWeight(rg)

console.log(`[build:ch] contracting ${graph.nodes.length} nodes / ${graph.edges.length} edges…`)
const t0 = performance.now()
const chData = buildCH(rg, weight)
const preprocMs = performance.now() - t0
chData.meta.preprocMs = Math.round(preprocMs)
chData.meta.builtAt = new Date().toISOString()

// ── self-check: CH cost == Dijkstra cost on random real pairs ────────────────
let mismatch = 0
const SELFCHECK = 50
for (let k = 0; k < SELFCHECK; k++) {
  const s = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
  const t = graph.nodes[Math.floor(Math.random() * graph.nodes.length)].id
  if (s === t) continue
  const d = dijkstra(rg, s, t, { weight })
  const c = ch(rg, chData, s, t, { weight })
  if (d.stats.found !== c.stats.found) mismatch++
  else if (d.stats.found && Math.abs(d.route!.costS - c.route!.costS) > 1e-6) mismatch++
}

const json = JSON.stringify(chData)
const bytes = Buffer.byteLength(json)
const upArcTotal = chData.upArcs.reduce((a, l) => a + l.length, 0)
const maxUp = chData.upArcs.reduce((m, l) => Math.max(m, l.length), 0)

console.log(`[build:ch] ${chData.meta.origArcs} original up-arcs + ${chData.meta.shortcuts} shortcuts`)
console.log(`[build:ch] up-arcs total ${upArcTotal}  (avg ${(upArcTotal / chData.meta.nodes).toFixed(2)}/node, max ${maxUp})`)
console.log(`[build:ch] preprocessing ${(preprocMs / 1000).toFixed(2)} s`)
console.log(`[build:ch] self-check ${SELFCHECK} pairs vs Dijkstra: ${mismatch} mismatches`)

if (mismatch > 0) {
  console.error('[build:ch] FAIL: the hierarchy disagreed with Dijkstra — not shipping.')
  process.exit(1)
}

writeFileSync(resolve(ROOT, 'public/data/ch.json'), json)
console.log(`[build:ch] wrote public/data/ch.json  (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
