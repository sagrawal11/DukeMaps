// Phase-4 benchmark: the hand-written quadtree vs a linear scan, on the real Duke graph.
// Measures build time + per-query time for nearest-node and snap-to-nearest-edge, and asserts the
// quadtree returns the SAME answer as brute force on every query (a fast index that's wrong is
// useless). Run: `npm run bench`. Copy the printed numbers into notes/measurements.md.
//
// Fairness: both approaches pre-project geometry once (the index does it at build; the linear
// baseline does it outside the timed loop), so we time query cost — O(n) scan vs O(log n) descent —
// not projection. A short warm-up pass runs first so JIT compilation doesn't skew the timings.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../src/graph/types'
import { buildNodeIndex, buildEdgeIndex } from '../src/spatial/snap'
import { pointToPolylineDist, type XY } from '../src/spatial/quadtree'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const N = 5000

function loadGraph(): Graph {
  return JSON.parse(readFileSync(resolve(ROOT, 'public/data/graph.json'), 'utf8')) as Graph
}

function randomQueries(graph: Graph, n: number): [number, number][] {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const nd of graph.nodes) {
    if (nd.lon < minLon) minLon = nd.lon
    if (nd.lon > maxLon) maxLon = nd.lon
    if (nd.lat < minLat) minLat = nd.lat
    if (nd.lat > maxLat) maxLat = nd.lat
  }
  const qs: [number, number][] = []
  for (let i = 0; i < n; i++) {
    qs.push([minLon + Math.random() * (maxLon - minLon), minLat + Math.random() * (maxLat - minLat)])
  }
  return qs
}

function time(label: string, queries: [number, number][], fn: (lon: number, lat: number) => unknown): number {
  for (let i = 0; i < Math.min(500, queries.length); i++) fn(queries[i][0], queries[i][1]) // warm-up
  const t0 = performance.now()
  for (const [lon, lat] of queries) fn(lon, lat)
  const ms = performance.now() - t0
  const us = (ms * 1000) / queries.length
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(1).padStart(8)} ms total   ${us.toFixed(2).padStart(7)} µs/query`)
  return ms
}

const graph = loadGraph()
const queries = randomQueries(graph, N)
console.log(`[bench] graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges · ${N} random in-bounds queries\n`)

// ── nearest node ───────────────────────────────────────────────────────────
let t0 = performance.now()
const nodeIdx = buildNodeIndex(graph.nodes)
const nodeBuildMs = performance.now() - t0
const projN = nodeIdx.project
const nodePts = graph.nodes.map((n) => ({ node: n, p: projN(n.lon, n.lat) }))
const linearNearestNode = (lon: number, lat: number): { id: number; d: number } => {
  const q = projN(lon, lat)
  let bestId = -1
  let bd = Infinity
  for (const np of nodePts) {
    const dx = np.p.x - q.x
    const dy = np.p.y - q.y
    const d = dx * dx + dy * dy
    if (d < bd) {
      bd = d
      bestId = np.node.id
    }
  }
  return { id: bestId, d: Math.sqrt(bd) }
}

// Correct iff the quadtree never returns a FARTHER node than brute force. A different id at equal
// distance is a genuine tie (both are valid nearest answers), so we compare distance, not id.
let nodeMismatch = 0
for (const [lon, lat] of queries) {
  const lin = linearNearestNode(lon, lat)
  if (nodeIdx.nearestNode(lon, lat)!.distM > lin.d + 1e-6) nodeMismatch++
}

console.log(`nearest node  (quadtree build: ${nodeBuildMs.toFixed(1)} ms)`)
const nodeLinMs = time('linear scan', queries, linearNearestNode)
const nodeQtMs = time('quadtree', queries, (lon, lat) => nodeIdx.nearestNode(lon, lat))
console.log(`  speedup: ${(nodeLinMs / nodeQtMs).toFixed(1)}×   mismatches: ${nodeMismatch}\n`)

// ── snap to nearest edge ─────────────────────────────────────────────────────
t0 = performance.now()
const edgeIdx = buildEdgeIndex(graph)
const edgeBuildMs = performance.now() - t0
const projE = edgeIdx.project
const edgeXY: { id: string; xy: XY[] }[] = graph.edges.map((e) => ({ id: e.id, xy: e.geometry.map(([lo, la]) => projE(lo, la)) }))
const edgeXYById = new Map(edgeXY.map((e) => [e.id, e.xy] as const))
const linearSnap = (lon: number, lat: number): { id: string; d: number } => {
  const q = projE(lon, lat)
  let bestId = ''
  let bd = Infinity
  for (const ex of edgeXY) {
    const d = pointToPolylineDist(ex.xy, q.x, q.y)
    if (d < bd) {
      bd = d
      bestId = ex.id
    }
  }
  return { id: bestId, d: bd }
}

// Same criterion as nodes: the quadtree's edge must be no farther than brute force. A different id
// at equal distance is a real tie — common when a tap's nearest point is a shared vertex, so every
// edge meeting there is equidistant — and is not an error.
let edgeMismatch = 0
for (const [lon, lat] of queries) {
  const q = projE(lon, lat)
  const lin = linearSnap(lon, lat)
  const got = edgeIdx.snap(lon, lat)!
  if (pointToPolylineDist(edgeXYById.get(got.edgeId)!, q.x, q.y) > lin.d + 1e-6) edgeMismatch++
}

console.log(`snap to nearest edge  (quadtree build: ${edgeBuildMs.toFixed(1)} ms)`)
const edgeLinMs = time('linear scan', queries, linearSnap)
const edgeQtMs = time('quadtree', queries, (lon, lat) => edgeIdx.snap(lon, lat))
console.log(`  speedup: ${(edgeLinMs / edgeQtMs).toFixed(1)}×   mismatches: ${edgeMismatch}`)

if (nodeMismatch > 0 || edgeMismatch > 0) {
  console.error('\n[bench] FAIL: quadtree disagreed with the linear scan — the index is wrong.')
  process.exit(1)
}
