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
  climbS: number // TRUE number of nodes climbed from s to the apex (may exceed the rows drawn — see MAX_ROWS)
  climbT: number // ...and from t. The view states these so a sampled tree still reports the real depth.
}

// Children of each node (inverse of parent) — lets the layout show the unsearched sibling branches.
export function buildChildren(parent: Int32Array): number[][] {
  const children: number[][] = Array.from({ length: parent.length }, () => [])
  for (let i = 0; i < parent.length; i++) if (parent[i] >= 0) children[parent[i]].push(i)
  return children
}

const S_LEAF_X = 0.18 // where the From leaf sits; To mirrors to 1 - this. Apex is at x = 0.5.
const MAX_ROWS = 6 // a long climb is SAMPLED down to this many levels so the forks splay like a tree.
const MIN_LEAN = 0.28 // the apex's two children keep at least this much of the lean, so they don't stack.

// Lay the query out as a TREE that grows downward from the apex (root, top-centre) to the two leaves
// (From/To, bottom). A real elimination-tree climb is ~25 nodes deep — far too many to read as a tree
// in a small inset — so each chain is SAMPLED down to <= MAX_ROWS evenly-spaced levels (leaf and the
// apex-adjacent top always kept). The big vertical gaps that buys are what make the forks splay
// downward like a decision tree instead of collapsing into a bare V. The true depth isn't lost: it
// rides out in climbS / climbT for the caption. At each drawn level the parent's OTHER children (nodes
// the search does NOT climb) fan off to the side as faint forks, so every level visibly branches.
export function layoutElimTree(paths: ElimPaths, ch: CHData): TreeLayout {
  const nodes: TreeNode[] = []
  const edges: TreeEdge[] = []
  const children = buildChildren(buildParents(ch))
  const onChain = new Set<number>([...paths.sPath, ...paths.tPath])

  // Sample one chain to <= maxRows rows and place them. Returns the node-array indices per drawn level
  // plus `ds` (the chain index each level maps to) so the sibling pass can look up real co-children.
  const placeChain = (path: number[], side: 'f' | 'b', leafX: number): { idxs: number[]; ds: number[]; rows: number } => {
    const last = path.length - 1 // path[last] === apex; the chain's own nodes are path[0..last-1]
    if (last <= 0) return { idxs: [], ds: [], rows: 0 }
    const rows = Math.min(last, MAX_ROWS)
    const idxs: number[] = []
    const ds: number[] = []
    for (let j = 0; j < rows; j++) {
      // j = 0 is the leaf (bottom, y = 1); j = rows-1 is the top level (just under the apex). Map each
      // drawn level to a chain index, evenly spaced so leaf (d=0) and top (d=last-1) are always kept.
      const d = rows === 1 ? 0 : Math.round(((last - 1) * j) / (rows - 1))
      const frac = rows === 1 ? 0 : j / (rows - 1) // 0 at the leaf -> 1 approaching the apex
      const bow = MIN_LEAN + (1 - MIN_LEAN) * (1 - frac) ** 1.2 // lean: full at the leaf, >=MIN_LEAN at top
      idxs.push(nodes.length)
      ds.push(d)
      nodes.push({ nodeId: ch.nodeIds[path[d]], x: 0.5 + (leafX - 0.5) * bow, y: 1 - j / rows, side, depth: j })
    }
    return { idxs, ds, rows }
  }
  const s = placeChain(paths.sPath, 'f', S_LEAF_X)
  const t = placeChain(paths.tPath, 'b', 1 - S_LEAF_X)

  const apexIndex = nodes.length
  nodes.push({ nodeId: ch.nodeIds[paths.apex], x: 0.5, y: 0, side: 'apex', depth: Math.max(s.rows, t.rows) })

  // spine: link consecutive drawn levels, then the top level up into the apex.
  const link = (idxs: number[]): void => {
    for (let i = 0; i + 1 < idxs.length; i++) edges.push({ from: idxs[i], to: idxs[i + 1] })
    if (idxs.length) edges.push({ from: idxs[idxs.length - 1], to: apexIndex })
  }
  link(s.idxs)
  link(t.idxs)

  // The forks: at each drawn level, a few REAL siblings (the chain node's co-children — nodes the search
  // skips) branch off to the outside, hung from the drawn parent one level up (the apex for the top row)
  // so every level reads as a downward fork. Faint: they're context, not the route.
  const addSiblings = (path: number[], c: { idxs: number[]; ds: number[]; rows: number }, dir: -1 | 1): void => {
    const K = c.rows <= 4 ? 4 : 3
    for (let j = 0; j < c.rows; j++) {
      const d = c.ds[j]
      const parentIdx = j + 1 < c.rows ? c.idxs[j + 1] : apexIndex
      const cNode = nodes[c.idxs[j]]
      const sibs = (children[path[d + 1]] ?? []).filter((x) => x !== path[d] && !onChain.has(x)).slice(0, K)
      sibs.forEach((sib, k) => {
        const idx = nodes.length
        nodes.push({
          nodeId: ch.nodeIds[sib],
          x: Math.min(0.97, Math.max(0.03, cNode.x + dir * (k + 1) * 0.09)), // fan wide off the limb
          y: cNode.y, // sit at this level -> a clean fork off the drawn parent one row up
          side: 'ctx',
          depth: j,
        })
        edges.push({ from: parentIdx, to: idx, faint: true })
      })
    }
  }
  addSiblings(paths.sPath, s, -1) // s-chain siblings fan left
  addSiblings(paths.tPath, t, 1) // t-chain siblings fan right

  return {
    nodes,
    edges,
    apexIndex,
    sLeafIndex: s.idxs.length ? s.idxs[0] : apexIndex, // if s IS the apex (ancestor of t), the leaf is the apex
    tLeafIndex: t.idxs.length ? t.idxs[0] : apexIndex,
    climbS: Math.max(0, paths.sPath.length - 1), // true nodes climbed, regardless of rows drawn
    climbT: Math.max(0, paths.tPath.length - 1),
  }
}

// The WHOLE elimination tree of the entire graph — every node — laid out once for the click-to-expand
// full view. Positions are in routing-index space ([0,1]^2) so a query's chains can be highlighted on top
// by index. Root (highest rank) at the top (y=0); leaves at the bottom (y=1). x is a tidy post-order
// layout: leaves take evenly-spaced slots, each parent centres over its children. O(n), ~15k nodes.
export interface FullTreeLayout {
  xs: Float32Array // per routing-index: x in [0,1]
  ys: Float32Array // per routing-index: y in [0,1] (0 = root, 1 = deepest leaf)
  parent: Int32Array // per routing-index: tree parent, or -1 at a root (draws the edges)
  n: number
  maxDepth: number
}
export function layoutFullTree(ch: CHData): FullTreeLayout {
  const parent = buildParents(ch)
  const n = parent.length
  const children = buildChildren(parent)
  const depth = new Int32Array(n)
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)

  const roots: number[] = []
  for (let i = 0; i < n; i++) if (parent[i] < 0) roots.push(i)

  // depth by BFS from the root(s); also records a DFS preorder for the x pass.
  let maxDepth = 0
  const bfs: number[] = [...roots]
  for (let h = 0; h < bfs.length; h++) {
    const u = bfs[h]
    if (depth[u] > maxDepth) maxDepth = depth[u]
    for (const c of children[u]) {
      depth[c] = depth[u] + 1
      bfs.push(c)
    }
  }
  // DFS preorder (iterative) — children pushed in reverse so they pop left-to-right.
  const order: number[] = []
  const stack: number[] = roots.slice().reverse()
  while (stack.length) {
    const u = stack.pop() as number
    order.push(u)
    const cs = children[u]
    for (let k = cs.length - 1; k >= 0; k--) stack.push(cs[k])
  }
  // x: walk preorder in REVERSE so children are placed before their parent. Leaves take sequential
  // slots; an internal node centres over its children. (Direction is arbitrary — a left-right mirror.)
  let leaf = 0
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i]
    const cs = children[u]
    if (cs.length === 0) xs[u] = leaf++
    else {
      let sum = 0
      for (const c of cs) sum += xs[c]
      xs[u] = sum / cs.length
    }
  }
  const denom = Math.max(1, leaf - 1)
  for (let i = 0; i < n; i++) {
    xs[i] /= denom
    ys[i] = maxDepth ? depth[i] / maxDepth : 0
  }
  return { xs, ys, parent, n, maxDepth }
}
