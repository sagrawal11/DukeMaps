// The ELIMINATION TREE of a contraction hierarchy — the teaching structure behind the CH/CCH query,
// and the one thing the map can't show (the map's axes are lon/lat; "importance/rank" has no spatial
// home). Here rank gets its own axis so the "climb up from both ends to an apex, then unpack back
// down" story becomes a picture.
//
// Definition: each node's PARENT is its lowest-ranked up-neighbour (from the hierarchy's up-arcs).
// Every node has exactly one parent, so the up-graph collapses to a TREE and each node's ancestors
// form a single CHAIN to the root — no sprawl. The upward CH/CCH search from s climbs s's chain; the
// one from t climbs t's; they converge at the APEX = the lowest common ancestor.
//
// For CCH this is exact: the up-graph is chordal, so the forward search space IS that chain. For plain
// CH (witness-pruned) it's the standard teaching abstraction — the real search touches a small
// superset — which the UI states honestly rather than blurs. Pure + testable; no DOM, no map.
import type { CHData } from '../algorithms/ch'

// parent[i] = routing index of i's lowest-RANKED up-neighbour, or -1 if i has none (the root).
export function buildParents(ch: CHData): Int32Array {
  const n = ch.nodeIds.length
  const parent = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let best = -1
    let bestRank = Infinity
    for (const arc of ch.upArcs[i]) {
      const r = ch.rank[arc.to]
      if (r < bestRank) {
        bestRank = r
        best = arc.to
      }
    }
    parent[i] = best
  }
  return parent
}

// The chain of routing indices from `start` up to the root: [start, parent(start), …, root]. Rank
// strictly increases upward (a parent is an up-neighbour), so this can't cycle; the length cap is a
// belt-and-braces guard against malformed data.
export function upChain(parent: Int32Array, start: number): number[] {
  const chain: number[] = []
  let v = start
  while (v !== -1 && chain.length <= parent.length) {
    chain.push(v)
    v = parent[v]
  }
  return chain
}

export interface ElimPaths {
  apex: number // routing index of the lowest common ancestor (where the two climbs meet)
  sPath: number[] // s..apex inclusive, low rank -> high (routing indices)
  tPath: number[] // t..apex inclusive
}

// The two upward chains truncated at their first shared node — the apex. null if s===t or the chains
// never meet (disconnected — shouldn't happen on the pruned single-component graph).
export function elimPaths(ch: CHData, sIdx: number, tIdx: number): ElimPaths | null {
  if (sIdx === tIdx) return null
  const parent = buildParents(ch)
  const sChain = upChain(parent, sIdx)
  const tChain = upChain(parent, tIdx)
  const depthOnS = new Map<number, number>()
  sChain.forEach((v, i) => depthOnS.set(v, i))
  for (let i = 0; i < tChain.length; i++) {
    const sCut = depthOnS.get(tChain[i])
    if (sCut !== undefined) {
      return { apex: tChain[i], sPath: sChain.slice(0, sCut + 1), tPath: tChain.slice(0, i + 1) }
    }
  }
  return null
}

export interface TreeNode {
  nodeId: number // ORIGINAL node id, so the view can test membership in RenderState.settled / .settledB
  x: number // 0..1, left..right
  y: number // 0..1, apex (top) = 0, leaf (bottom) = 1
  side: 'f' | 'b' | 'apex' | 'ctx' // 'ctx' = an unsearched sibling branch, drawn faint for context
  depth: number // 0 = leaf, increasing toward the apex
}
export interface TreeEdge {
  from: number // index into nodes[]
  to: number
  faint?: boolean // a branch to an unsearched sibling (drawn dim, never lit)
}
export interface TreeLayout {
  nodes: TreeNode[]
  edges: TreeEdge[]
  apexIndex: number // index into nodes[]
  sLeafIndex: number
  tLeafIndex: number
}

// Children of each node (inverse of parent) — lets the layout show the unsearched sibling branches.
export function buildChildren(parent: Int32Array): number[][] {
  const children: number[][] = Array.from({ length: parent.length }, () => [])
  for (let i = 0; i < parent.length; i++) if (parent[i] >= 0) children[parent[i]].push(i)
  return children
}

const LEAF_X = 0.12 // how far the leaves sit from the edges (apex is at x = 0.5)

// Lay the two chains out as an inverted V meeting at the apex (top-center). y = DEPTH (even spacing),
// not raw rank — even spacing reads as a clean ladder and the chain is already in rank order. The
// s-chain leans left, the t-chain right. Positions in [0,1]^2 so the view scales to any pixel size.
export function layoutElimTree(paths: ElimPaths, ch: CHData): TreeLayout {
  const nodes: TreeNode[] = []
  const edges: TreeEdge[] = []

  // Place a chain's nodes BELOW the apex (the apex is added once, shared, afterwards). `leafX` is the
  // outer x the leaf sits at; nodes march in toward x=0.5 and up toward y=0 as depth approaches apex.
  const placeChain = (path: number[], side: 'f' | 'b', leafX: number): number[] => {
    const idxs: number[] = []
    const last = path.length - 1 // index of the apex within this path
    for (let d = 0; d < last; d++) {
      const frac = d / last // 0 at the leaf, -> 1 approaching the apex
      idxs.push(nodes.length)
      nodes.push({ nodeId: ch.nodeIds[path[d]], x: leafX + (0.5 - leafX) * frac, y: 1 - frac, side, depth: d })
    }
    return idxs
  }
  const sIdxs = placeChain(paths.sPath, 'f', LEAF_X)
  const tIdxs = placeChain(paths.tPath, 'b', 1 - LEAF_X)

  const apexIndex = nodes.length
  nodes.push({ nodeId: ch.nodeIds[paths.apex], x: 0.5, y: 0, side: 'apex', depth: Math.max(paths.sPath.length, paths.tPath.length) - 1 })

  const link = (idxs: number[]): void => {
    for (let i = 0; i + 1 < idxs.length; i++) edges.push({ from: idxs[i], to: idxs[i + 1] })
    if (idxs.length) edges.push({ from: idxs[idxs.length - 1], to: apexIndex }) // top of the chain -> apex
  }
  link(sIdxs)
  link(tIdxs)

  // Context: at each chain node, show a few REAL siblings (other children of its parent) that the search
  // does NOT climb — drawn faint. Makes the selective climb through a wide tree obvious ("we don't touch
  // every node at a level"). Siblings fan to the outside; capped so the inset stays readable.
  const children = buildChildren(buildParents(ch))
  const onChain = new Set<number>([...paths.sPath, ...paths.tPath])
  const K = 4 // siblings shown per chain node — more = fuller decision-tree look
  const addSiblings = (path: number[], idxs: number[], dir: -1 | 1): void => {
    const last = path.length - 1
    for (let d = 0; d < last; d++) {
      const parentIdx = d + 1 < last ? idxs[d + 1] : apexIndex
      const cNode = nodes[idxs[d]]
      const sibs = (children[path[d + 1]] ?? []).filter((x) => x !== path[d] && !onChain.has(x)).slice(0, K)
      sibs.forEach((sib, k) => {
        const idx = nodes.length
        nodes.push({
          nodeId: ch.nodeIds[sib],
          x: Math.min(0.97, Math.max(0.03, cNode.x + dir * (k + 1) * 0.055)),
          y: Math.min(0.99, cNode.y + 0.015),
          side: 'ctx',
          depth: d,
        })
        edges.push({ from: parentIdx, to: idx, faint: true })
      })
    }
  }
  addSiblings(paths.sPath, sIdxs, -1) // s-chain siblings fan left
  addSiblings(paths.tPath, tIdxs, 1) // t-chain siblings fan right

  return {
    nodes,
    edges,
    apexIndex,
    sLeafIndex: sIdxs.length ? sIdxs[0] : apexIndex, // if s IS the apex (ancestor of t), the leaf is the apex
    tLeafIndex: tIdxs.length ? tIdxs[0] : apexIndex,
  }
}
