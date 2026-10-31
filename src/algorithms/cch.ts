// Customizable Contraction Hierarchies (CCH), hand-written. The point CH can't make: separate the
// map's STRUCTURE from its WEIGHTS. Build a metric-INDEPENDENT hierarchy once (from the graph's shape
// alone), then CUSTOMIZE it — cheaply re-weight every shortcut for a given metric — without ever
// re-contracting. That's how a router copes with changing weights (crowding, hours, a step-free
// toggle, a different departure time): re-customize, don't rebuild.
//
// Three pieces:
//   1. nestedDissectionOrder — order nodes by graph structure via recursive coordinate bisection.
//      Separators (the few nodes whose removal splits the map in two) get the HIGHEST ranks.
//   2. buildCCH — contract in that order, adding a shortcut for EVERY pair of higher-ranked neighbours
//      (unconditionally — there are no weights yet to witness against). Produces the up-graph topology.
//   3. customize — given a metric, fill every arc's weight by a bottom-up triangle enumeration, and
//      record each shortcut's (metric-dependent!) via-node for unpacking. Emits a CHData, so the
//      existing bidirectional-upward query in ch.ts runs unchanged.
//
// Why CH orders by edge-difference but CCH can't: edge-difference needs the weights (a shortcut's
// necessity is a witness-search question about distances). CCH must work for ANY weights, so it orders
// by structure alone. The cost is more shortcuts (no witness pruning); the payoff is cheap re-weighting.
import type { RoutingGraph, WeightFn } from './routing'
import type { CHData, UpArc, Shortcut } from './ch'
import { encodeShortcut } from './ch'
import { pointInPolygon } from '../graph/geo'

export interface CCHStructure {
  nodeIds: number[] // routing index -> original node id
  rank: number[] // routing index -> rank (0 = contracted first = least important; separators highest)
  upTo: number[][] // routing index -> up-neighbour indices (the metric-independent up-graph topology)
  meta: { builtAt: string; nodes: number; origArcs: number; shortcuts: number; orderMs: number; contractMs: number; offCampusCount?: number }
}

// ---------- 1. nested dissection ordering (coordinate bisection) ----------
// Recursively split the node set along its longer geographic axis at the median node. The separator —
// the nodes on the "far" side that touch the "near" side — is ranked above both halves, so a query
// climbing the hierarchy passes through these few important nodes last. Hand-written vertex separator
// (brief: no library); a graph-partitioner (KaHIP/Metis) would find smaller ones.
// Recursive coordinate bisection over a node SUBSET, exported so the campus-aware order and the
// dissection EXPERIMENTS can run it per region. Returns a contraction order (low rank first). `adj` is
// the full adjacency; cross-subset neighbours just aren't in `inA`, so a subset still bisects correctly.
export function geometricOrder(rg: RoutingGraph, nodes: number[], adj: Set<number>[]): number[] {
  const order: number[] = []
  const dissect = (ns: number[]): void => {
    if (ns.length <= 2) {
      for (const v of ns) order.push(v)
      return
    }
    let minLon = Infinity
    let maxLon = -Infinity
    let minLat = Infinity
    let maxLat = -Infinity
    for (const v of ns) {
      const nd = rg.nodes[v]
      if (nd.lon < minLon) minLon = nd.lon
      if (nd.lon > maxLon) maxLon = nd.lon
      if (nd.lat < minLat) minLat = nd.lat
      if (nd.lat > maxLat) maxLat = nd.lat
    }
    const cos = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) // lon degrees are shorter than lat
    const byLon = (maxLon - minLon) * cos >= maxLat - minLat
    const sorted = [...ns].sort((a, b) => (byLon ? rg.nodes[a].lon - rg.nodes[b].lon : rg.nodes[a].lat - rg.nodes[b].lat))
    const mid = sorted.length >> 1
    const A = sorted.slice(0, mid)
    const B = sorted.slice(mid)
    const inA = new Set(A)
    const sep: number[] = []
    const bRest: number[] = []
    for (const b of B) {
      let touches = false
      for (const nb of adj[b]) {
        if (inA.has(nb)) {
          touches = true
          break
        }
      }
      if (touches) sep.push(b) // removing `sep` leaves no edge between A and bRest -> valid separator
      else bRest.push(b)
    }
    dissect(A) // both halves rank below...
    dissect(bRest)
    for (const v of sep) order.push(v) // ...the separator
  }
  dissect(nodes)
  return order
}

// Turn a contraction order (low rank first) into a rank array (routing index -> rank).
export function rankFromOrder(order: number[]): number[] {
  const rank = new Array<number>(order.length)
  order.forEach((v, i) => (rank[v] = i))
  return rank
}

// Default order: geometric nested dissection over the WHOLE graph, as a rank array.
export function nestedDissectionOrder(rg: RoutingGraph): number[] {
  const n = rg.nodes.length
  const adj: Set<number>[] = rg.adj.map((arcs) => new Set(arcs.map((a) => a.to)))
  return rankFromOrder(geometricOrder(rg, Array.from({ length: n }, (_, i) => i), adj))
}

// Convex hull (monotone chain) of [lon,lat] points — used as the campus extent from the drawn regions.
function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src: [number, number][]): [number, number][] => {
    const h: [number, number][] = []
    for (const pt of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], pt) <= 0) h.pop()
      h.push(pt)
    }
    h.pop()
    return h
  }
  return half(p).concat(half([...p].reverse()))
}

// Campus-aware order for the TEACHING visuals. Cut the graph BY the drawn regions so the on-campus,
// high-traffic inter-region connectors become the top separators (highest rank). Crucially, nodes OFF
// campus — outside the convex hull of the regions, i.e. the Durham streets that aren't Duke — are
// contracted FIRST, so they stay low-importance leaves (blue) and never light up red in the far corners.
// Slower to query than geometric (see notes/dissection-experiments.md): a deliberate mechanism-over-speed
// choice so the heatmap + elimination tree make campus-relevant sense.
export function regionAwareOrder(rg: RoutingGraph, regions: { name: string; polygon: [number, number][] }[], importanceAsc: string[]): { rank: number[]; offCampusCount: number } {
  const n = rg.nodes.length
  const adj: Set<number>[] = rg.adj.map((arcs) => new Set(arcs.map((a) => a.to)))
  const all = Array.from({ length: n }, (_, i) => i)
  const imp = (name: string): number => {
    const i = importanceAsc.indexOf(name)
    return i < 0 ? -1 : i // a region not in the importance list = least important (contracted first)
  }
  // label each node by its MOST-important containing region, or null (outside every region polygon)
  const label: (string | null)[] = new Array(n).fill(null)
  for (let v = 0; v < n; v++) {
    const nd = rg.nodes[v]
    let best: string | null = null
    let bestImp = -1
    for (const r of regions) {
      if (imp(r.name) > bestImp && pointInPolygon(nd.lat, nd.lon, r.polygon)) {
        bestImp = imp(r.name)
        best = r.name
      }
    }
    label[v] = best
  }
  // split the non-region nodes by the campus extent (convex hull of all region vertices)
  const hull = convexHull(regions.flatMap((r) => r.polygon))
  const offCampus: number[] = []
  const connectors: number[] = []
  for (let v = 0; v < n; v++) {
    if (label[v] !== null) continue
    if (pointInPolygon(rg.nodes[v].lat, rg.nodes[v].lon, hull)) connectors.push(v)
    else offCampus.push(v)
  }
  const nodesWith = (name: string): number[] => all.filter((v) => label[v] === name)
  const regionsAsc = [...regions].sort((a, b) => imp(a.name) - imp(b.name))
  // contraction order (low rank -> high): off-campus first (leaves), then region interiors by importance,
  // then the on-campus inter-region connectors last (the high-traffic separators, highest rank).
  const order: number[] = [...geometricOrder(rg, offCampus, adj)]
  for (const r of regionsAsc) order.push(...geometricOrder(rg, nodesWith(r.name), adj))
  order.push(...geometricOrder(rg, connectors, adj))
  return { rank: rankFromOrder(order), offCampusCount: offCampus.length }
}

// ---------- 2. metric-independent contraction ----------
// Contract in rank order. When a node is contracted, every pair of its still-present (= higher-rank)
// neighbours gets a shortcut — unconditionally. Snapshot those neighbours as the node's up-arcs. No
// weights, no witness searches: pure topology, valid for any future metric.
export function buildCCH(rg: RoutingGraph, rank: number[] = nestedDissectionOrder(rg)): CCHStructure {
  const n = rg.nodes.length

  const neigh: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  for (const e of rg.edges) {
    const a = rg.indexOf.get(e.from)
    const b = rg.indexOf.get(e.to)
    if (a === undefined || b === undefined || a === b) continue
    neigh[a].add(b)
    neigh[b].add(a)
  }
  const origArcs = neigh.reduce((s, set) => s + set.size, 0) / 2 // unique node-pairs with an original edge

  const upTo: number[][] = Array.from({ length: n }, () => [])
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rank[a] - rank[b])
  for (const v of order) {
    const N = [...neigh[v]] // all present neighbours are higher-ranked (lower ranks already contracted)
    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        neigh[N[i]].add(N[j]) // unconditional shortcut between the pair
        neigh[N[j]].add(N[i])
      }
    }
    upTo[v] = N
    for (const x of N) neigh[x].delete(v)
    neigh[v].clear()
  }

  const totalUp = upTo.reduce((s, l) => s + l.length, 0)
  return {
    nodeIds: rg.nodes.map((nd) => nd.id),
    rank,
    upTo,
    meta: { builtAt: '', nodes: n, origArcs, shortcuts: totalUp - origArcs, orderMs: 0, contractMs: 0 },
  }
}

// ---------- 3. customization ----------
// Fill every arc's weight for a given metric. Init each arc from its cheapest original edge (Infinity
// for a pure shortcut), then process nodes bottom-up by rank: for each pair of a node's up-arcs, relax
// the arc joining their targets (which exists — contracting the node created it). An arc's weight is
// final by the time we process it, because every triangle that can improve it is rooted at a strictly
// lower node, already processed. Records each shortcut's winning via-node so ch() can unpack it.
export function customize(s: CCHStructure, rg: RoutingGraph, weight: WeightFn): CHData {
  const n = s.nodeIds.length
  const upArcs: UpArc[][] = s.upTo.map((list) => list.map((to) => ({ to, w: Infinity, r: 0 })))
  const slot: Map<number, number>[] = upArcs.map((list) => new Map(list.map((a, i) => [a.to, i]))) // (lower node) to -> arc idx
  const shortcuts: Shortcut[] = []

  // The arc record for an unordered pair is stored at the lower-ranked endpoint's up-list.
  const arcRec = (p: number, q: number): UpArc | undefined => {
    const lo = s.rank[p] < s.rank[q] ? p : q
    const hi = lo === p ? q : p
    const i = slot[lo].get(hi)
    return i === undefined ? undefined : upArcs[lo][i]
  }

  // init: fold every original edge into its pair's arc (handles parallel edges + per-metric Infinity)
  rg.edges.forEach((e, ei) => {
    const a = rg.indexOf.get(e.from)
    const b = rg.indexOf.get(e.to)
    if (a === undefined || b === undefined || a === b) return
    const w = weight(ei, 0)
    if (!Number.isFinite(w)) return
    const rec = arcRec(a, b)
    if (rec && w < rec.w) {
      rec.w = w
      rec.r = ei // provenance = this original edge (>= 0)
    }
  })

  // triangles, bottom-up by rank
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => s.rank[a] - s.rank[b])
  for (const v of order) {
    const ups = upArcs[v]
    for (let i = 0; i < ups.length; i++) {
      for (let j = i + 1; j < ups.length; j++) {
        const ai = ups[i]
        const aj = ups[j]
        const cand = ai.w + aj.w
        if (!Number.isFinite(cand)) continue
        const x = ai.to
        const y = aj.to
        const rec = arcRec(x, y)! // exists by the clique property
        if (cand < rec.w) {
          rec.w = cand
          const from = s.rank[x] < s.rank[y] ? x : y
          const to = from === x ? y : x
          // children: the legs from->via and via->to (via = v)
          const aRef = from === x ? ai.r : aj.r
          const bRef = to === x ? ai.r : aj.r
          rec.r = encodeShortcut(shortcuts.length)
          shortcuts.push({ from, to, via: v, w: cand, a: aRef, b: bRef })
        }
      }
    }
  }

  return {
    nodeIds: s.nodeIds,
    rank: s.rank,
    upArcs,
    shortcuts,
    meta: { builtAt: s.meta.builtAt, nodes: n, origArcs: s.meta.origArcs, shortcuts: shortcuts.length, preprocMs: 0 },
  }
}
