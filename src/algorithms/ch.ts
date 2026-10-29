// Contraction Hierarchies (CH), hand-written (brief non-negotiable: no routing/graph library).
//
// The idea: order the nodes by "importance", then contract them one at a time from least to most
// important. Contracting a node v means removing it but preserving shortest paths — for every pair of
// still-present neighbours u, w whose shortest route went straight through v, add a SHORTCUT edge
// u–w of weight d(u,v)+d(v,w). A witness search first checks whether some other path u…w (avoiding v)
// is already just as short; if so, no shortcut is needed. After contracting everyone, orient every
// edge/shortcut from the lower-rank to the higher-rank endpoint. A query is then a bidirectional
// search that only ever moves UPWARD in rank from both ends and meets in the middle — which on a real
// graph touches a few hundred nodes instead of sweeping the whole map.
//
// Why upward-only is correct: every shortest path, rewritten with shortcuts, is "unimodal" in rank —
// it goes up to a single highest-rank node then down. The forward search from s finds the up-part,
// the backward search from t finds the down-part (which is an up-part from t's side), and they meet at
// that highest node. (Geisberger, Sanders, Schultes & Delling 2008.)
//
// STATIC METRIC: shortcuts bake in a FIXED edge weight (the departure-time snapshot, same as the
// bidirectional algorithms). Crowding (time-dependent) and `hours` closures are NOT baked in — a
// static hierarchy can't price an edge it won't reach until some unknown arrival time. Making CH
// crowding-aware is the job of Customizable CH in Phase 5c.
import type { RoutingGraph, WeightFn } from './routing'
import { MinHeap } from './heap'
import type { Trace, TraceEvent, AlgoStats, RouteResult } from './trace'

// ---------- data model (JSON-serialisable; shipped as public/data/ch.json) ----------
// An arc's provenance is encoded as one number `r`, so ch.json stays compact:
//   r >= 0  -> original edge: r is the index into graph.edges (same order buildRoutingGraph sees)
//   r <  0  -> shortcut:      the index is (-r - 1) into CHData.shortcuts
export interface UpArc {
  to: number // routing index of the HIGHER-rank endpoint
  w: number // arc weight (seconds, static metric)
  r: number // provenance (see encoding above)
}
export interface Shortcut {
  from: number // routing index
  to: number // routing index
  via: number // the contracted middle node (routing index)
  w: number // d(from,via) + d(via,to)
  a: number // provenance of the from->via leg (encoded r)
  b: number // provenance of the via->to leg  (encoded r)
}
export interface CHData {
  nodeIds: number[] // routing index -> original node id (indexing matches buildRoutingGraph)
  rank: number[] // routing index -> contraction rank (0 = contracted first = least important)
  upArcs: UpArc[][] // routing index -> arcs to higher-rank neighbours (forward AND backward query use these)
  shortcuts: Shortcut[]
  meta: { builtAt: string; nodes: number; origArcs: number; shortcuts: number; preprocMs: number }
}

const EPS = 1e-9
// Provenance encoding, shared with CCH (src/algorithms/cch.ts) so a customized hierarchy is a valid
// CHData the query below can consume unchanged.
export const encodeShortcut = (sc: number): number => -sc - 1
const isShortcut = (r: number): boolean => r < 0
const shortcutIndex = (r: number): number => -r - 1

type WorkArc = { w: number; r: number }

// ============================ PREPROCESSING ============================
// Build the hierarchy. `weight` supplies the metric (buildCH prices every edge at elapsed 0, so the
// hierarchy is static). hopLimit bounds each witness search; a truncated witness just means we add a
// shortcut we might not have needed — never wrong, only slightly larger.
export function buildCH(rg: RoutingGraph, weight: WeightFn, opts: { hopLimit?: number } = {}): CHData {
  const hopLimit = opts.hopLimit ?? 5
  const n = rg.nodes.length

  // Mutable working graph: neigh[i] maps a present neighbour index -> the current best arc to it.
  // Starts as the (simple-ified) input graph; shortcuts are added as nodes are contracted.
  const neigh: Map<number, WorkArc>[] = Array.from({ length: n }, () => new Map<number, WorkArc>())
  const setArc = (a: number, b: number, w: number, r: number): void => {
    const cur = neigh[a].get(b)
    if (!cur || w < cur.w) neigh[a].set(b, { w, r }) // keep the cheapest parallel edge/shortcut
  }
  rg.edges.forEach((e, edgeIdx) => {
    const a = rg.indexOf.get(e.from)
    const b = rg.indexOf.get(e.to)
    if (a === undefined || b === undefined) return
    const w = weight(edgeIdx, 0)
    if (!Number.isFinite(w)) return // unusable under this metric (e.g. a future step-free build): absent
    setArc(a, b, w, edgeIdx)
    setArc(b, a, w, edgeIdx)
  })

  const contracted = new Uint8Array(n)
  const rank = new Array<number>(n).fill(-1)
  const upArcs: UpArc[][] = Array.from({ length: n }, () => [])
  const shortcuts: Shortcut[] = []

  // Witness search: shortest distance from `src` to `goal`, avoiding `avoid`, over present nodes only,
  // not exceeding `bound` cost or `hopLimit` hops. Infinity means "no witness within the bound" → the
  // shortcut is needed. Small, local Dijkstra with Maps (never allocate an n-array per call).
  const witnessDist = (src: number, avoid: number, goal: number, bound: number): number => {
    const dist = new Map<number, number>([[src, 0]])
    const hops = new Map<number, number>([[src, 0]])
    const heap = new MinHeap()
    heap.push(src, 0)
    while (heap.size > 0) {
      const u = heap.pop() as number
      const du = dist.get(u) as number
      if (du > bound + EPS) break // heap is ordered: nothing cheaper than `bound` remains
      if (u === goal) return du
      if ((hops.get(u) as number) >= hopLimit) continue // don't expand past the hop limit (conservative)
      for (const [x, arc] of neigh[u]) {
        if (x === avoid || contracted[x]) continue
        const nd = du + arc.w
        if (nd > bound + EPS) continue
        if (nd < (dist.get(x) ?? Infinity)) {
          dist.set(x, nd)
          hops.set(x, (hops.get(u) as number) + 1)
          heap.push(x, nd)
        }
      }
    }
    return Infinity
  }

  // Simulate contracting v: which shortcuts would it need? Shared by the edge-difference priority and
  // the actual contraction, so the two never disagree. Each unordered neighbour pair {u,w} is checked
  // once; a shortcut is needed iff no witness path u…w (avoiding v) is as short as u→v→w.
  interface Pending {
    u: number
    w: number
    target: number
    a: number // provenance u–v
    b: number // provenance v–w
  }
  const simulate = (v: number): { adds: Pending[]; degree: number } => {
    const nbrs = [...neigh[v].entries()] // [index, arc] where arc is v–index
    const adds: Pending[] = []
    for (let i = 0; i < nbrs.length; i++) {
      for (let j = i + 1; j < nbrs.length; j++) {
        const [u, au] = nbrs[i]
        const [w, aw] = nbrs[j]
        const target = au.w + aw.w
        if (witnessDist(u, v, w, target) > target + EPS) {
          adds.push({ u, w, target, a: au.r, b: aw.r })
        }
      }
    }
    return { adds, degree: nbrs.length }
  }

  const edgeDifference = (v: number): number => {
    const { adds, degree } = simulate(v)
    return adds.length - degree // shortcuts added minus edges removed
  }

  // Lazy node ordering: a min-heap keyed by edge difference. On pop we RECOMPUTE the key against the
  // now-partly-contracted graph; if it's no longer the minimum, re-insert with the fresh key and move
  // on. Pure lazy updates (no eager neighbour re-keying) — simplest, and fine at campus size.
  // ponytail: edge-difference only; add contracted-neighbours / search-space terms if ordering quality
  // ever matters.
  const order = new MinHeap()
  for (let i = 0; i < n; i++) order.push(i, edgeDifference(i))

  let rankCtr = 0
  while (order.size > 0) {
    const v = order.pop() as number
    if (contracted[v]) continue
    const edNow = edgeDifference(v)
    if (order.size > 0 && edNow > order.peekPriority() + EPS) {
      order.push(v, edNow) // someone else is cheaper now — defer v with its refreshed key
      continue
    }

    // Contract v: add its shortcuts, then snapshot its remaining arcs as v's up-arcs, then unlink it.
    const { adds } = simulate(v)
    for (const p of adds) {
      const sc = shortcuts.length
      shortcuts.push({ from: p.u, to: p.w, via: v, w: p.target, a: p.a, b: p.b })
      const r = encodeShortcut(sc)
      setArc(p.u, p.w, p.target, r)
      setArc(p.w, p.u, p.target, r)
    }
    // Every current neighbour will be contracted later (higher rank), so each current arc of v is an
    // up-arc OF v. Recorded exactly once per edge — at the contraction of its lower-rank endpoint.
    for (const [to, arc] of neigh[v]) upArcs[v].push({ to, w: arc.w, r: arc.r })
    for (const [x] of neigh[v]) neigh[x].delete(v)
    neigh[v].clear()
    contracted[v] = 1
    rank[v] = rankCtr++
  }

  let origArcs = 0
  let scArcs = 0
  for (let i = 0; i < n; i++)
    for (const arc of upArcs[i]) (isShortcut(arc.r) ? scArcs++ : origArcs++)

  return {
    nodeIds: rg.nodes.map((nd) => nd.id),
    rank,
    upArcs,
    shortcuts,
    meta: { builtAt: '', nodes: n, origArcs, shortcuts: shortcuts.length, preprocMs: 0 },
  }
}

// ============================ QUERY ============================
// Bidirectional upward search. Forward from s and backward from t both climb the hierarchy (relaxing
// only up-arcs); they meet at the highest-rank node on the shortest path. rank isn't even needed at
// query time — "up" is already baked into upArcs. Then unpack shortcuts back to original edges.
export function ch(rg: RoutingGraph, chData: CHData, sourceId: number, targetId: number, opts: { weight: WeightFn }): Trace {
  const events: TraceEvent[] = []
  const stats: AlgoStats = { nodesSettled: 0, edgesRelaxed: 0, pushes: 0, skipped: 0, found: false }
  const sIdx = rg.indexOf.get(sourceId)
  const tIdx = rg.indexOf.get(targetId)
  const n = chData.nodeIds.length
  if (sIdx === undefined || tIdx === undefined) return { algo: 'ch', events, stats, route: null }

  const distF = new Float64Array(n).fill(Infinity)
  const distB = new Float64Array(n).fill(Infinity)
  const settledF = new Uint8Array(n)
  const settledB = new Uint8Array(n)
  const prevF = new Int32Array(n).fill(-1)
  const prevB = new Int32Array(n).fill(-1)
  const refF = new Float64Array(n).fill(0) // encoded provenance of the arc that reached this node
  const refB = new Float64Array(n).fill(0)
  const heapF = new MinHeap()
  const heapB = new MinHeap()

  distF[sIdx] = 0
  heapF.push(sIdx, 0)
  events.push({ type: 'push', node: sourceId, side: 'f' })
  distB[tIdx] = 0
  heapB.push(tIdx, 0)
  events.push({ type: 'push', node: targetId, side: 'b' })
  stats.pushes += 2

  let best = Infinity
  let meet = -1

  const expand = (side: 'f' | 'b'): void => {
    const heap = side === 'f' ? heapF : heapB
    const dist = side === 'f' ? distF : distB
    const settled = side === 'f' ? settledF : settledB
    const otherSettled = side === 'f' ? settledB : settledF
    const otherDist = side === 'f' ? distB : distF
    const prev = side === 'f' ? prevF : prevB
    const ref = side === 'f' ? refF : refB

    const u = heap.pop() as number
    if (settled[u]) return
    settled[u] = 1
    events.push({ type: 'settle', node: chData.nodeIds[u], side })
    stats.nodesSettled++

    if (otherSettled[u] && dist[u] + otherDist[u] < best) {
      best = dist[u] + otherDist[u] // the two upward searches climbed to the same node
      meet = u
      events.push({ type: 'meet', node: chData.nodeIds[u], side })
    }
    for (const arc of chData.upArcs[u]) {
      const nd = dist[u] + arc.w
      if (nd < dist[arc.to]) {
        dist[arc.to] = nd
        prev[arc.to] = u
        ref[arc.to] = arc.r
        heap.push(arc.to, nd)
        stats.edgesRelaxed++
        stats.pushes++
        events.push({ type: 'relax', side })
        events.push({ type: 'push', node: chData.nodeIds[arc.to], side })
      }
    }
  }

  // Each side keeps going until its cheapest remaining key can't beat the best meeting found.
  for (;;) {
    const fCan = heapF.size > 0 && heapF.peekPriority() < best - EPS
    const bCan = heapB.size > 0 && heapB.peekPriority() < best - EPS
    if (!fCan && !bCan) break
    if (fCan && (!bCan || heapF.peekPriority() <= heapB.peekPriority())) expand('f')
    else expand('b')
  }

  stats.found = meet >= 0
  const route = meet >= 0 ? buildRoute(rg, chData, events, stats, meet, prevF, refF, prevB, refB, sIdx, tIdx, opts.weight) : null
  return { algo: 'ch', events, stats, route }
}

// Stitch the forward (s->meet) and backward (meet->t) arc chains, unpack every shortcut to original
// edges, then re-price the whole thing forward so the reported cost matches the other algorithms.
function buildRoute(
  rg: RoutingGraph,
  chData: CHData,
  events: TraceEvent[],
  stats: AlgoStats,
  meet: number,
  prevF: Int32Array,
  refF: Float64Array,
  prevB: Int32Array,
  refB: Float64Array,
  sIdx: number,
  tIdx: number,
  weight: WeightFn,
): RouteResult {
  // Arcs along the route, each as (from -> to) in travel order, with provenance r.
  const arcs: { from: number; to: number; r: number }[] = []
  let cur = meet
  while (cur !== sIdx) {
    const u = prevF[cur]
    arcs.unshift({ from: u, to: cur, r: refF[cur] }) // forward chain, reversed into s->meet order
    cur = u
  }
  cur = meet
  while (cur !== tIdx) {
    const next = prevB[cur]
    arcs.push({ from: cur, to: next, r: refB[cur] }) // backward chain is already meet->t order
    cur = next
  }

  // Recursively expand an arc (traversed from `from` to `to`) into original edge indices, emitting a
  // 'shortcut' event each time one is unpacked (for the Phase 6 animation).
  const edgeIdxs: number[] = []
  const expandArc = (from: number, r: number): void => {
    if (!isShortcut(r)) {
      edgeIdxs.push(r)
      return
    }
    const sc = chData.shortcuts[shortcutIndex(r)]
    events.push({ type: 'shortcut', node: chData.nodeIds[sc.via] })
    if (from === sc.from) {
      expandArc(sc.from, sc.a) // from -> via, then via -> to
      expandArc(sc.via, sc.b)
    } else {
      expandArc(sc.to, sc.b) // travelling the shortcut the other way
      expandArc(sc.via, sc.a)
    }
  }
  for (const a of arcs) expandArc(a.from, a.r)

  // Walk the expanded edges from the source to recover node ids, length, and a forward-priced cost.
  const nodes: number[] = [chData.nodeIds[sIdx]]
  const edges: string[] = []
  let costS = 0
  let distanceM = 0
  let curId = chData.nodeIds[sIdx]
  for (const ei of edgeIdxs) {
    const e = rg.edges[ei]
    const nextId = e.from === curId ? e.to : e.from
    costS += weight(ei, costS) // re-price at the time the walker reaches it (static here, but consistent)
    distanceM += e.lengthM
    edges.push(e.id)
    nodes.push(nextId)
    curId = nextId
  }
  stats.found = true
  return { nodes, edges, costS, distanceM }
}
