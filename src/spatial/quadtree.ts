// Hand-written region quadtree for static spatial queries (Phase 4). The brief requires we build
// the spatial index ourselves — no library. One structure serves both jobs: nearest graph NODE
// (the benchmark headline; a faster drop-in for the O(n) snapToNearestNode) and nearest graph EDGE
// (tap-to-snap). See src/spatial/snap.ts for the two instantiations.
//
// Everything runs in a local equirectangular frame (meters) fixed at a reference lon/lat, so
// distances are plain Euclidean and the nearest-neighbour pruning bound (distance-to-box) is exact
// and consistent with the item distances. At campus scale (~2 km) the equirectangular error is
// ~0.1%, already blessed in projectPointOnSegment (src/graph/editing.ts).

const EARTH_RADIUS_M = 6_371_000
const DEG = Math.PI / 180

export interface XY {
  x: number
  y: number
}

// lon/lat -> local meters, fixed at (lon0, lat0). Build once per index; query in the same frame.
export function planarProjector(lon0: number, lat0: number): (lon: number, lat: number) => XY {
  const mPerDegLat = DEG * EARTH_RADIUS_M
  const mPerDegLon = Math.cos(lat0 * DEG) * DEG * EARTH_RADIUS_M
  return (lon, lat) => ({ x: (lon - lon0) * mPerDegLon, y: (lat - lat0) * mPerDegLat })
}

// Squared distance from q to segment a-b (planar). Squared to skip the sqrt in the hot loop.
function pointToSegDistSq(a: XY, b: XY, qx: number, qy: number): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((qx - a.x) * dx + (qy - a.y) * dy) / len2))
  const px = a.x + t * dx
  const py = a.y + t * dy
  return (px - qx) * (px - qx) + (py - qy) * (py - qy)
}

// Nearest distance from q to a polyline (planar meters). This is the edge index's distance fn.
export function pointToPolylineDist(xy: XY[], qx: number, qy: number): number {
  if (xy.length === 1) return Math.hypot(xy[0].x - qx, xy[0].y - qy)
  let best = Infinity
  for (let i = 0; i < xy.length - 1; i++) {
    const d2 = pointToSegDistSq(xy[i], xy[i + 1], qx, qy)
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

export interface BBoxItem<T> {
  ref: T
  minx: number
  miny: number
  maxx: number
  maxy: number
}

export type DistFn<T> = (ref: T, qx: number, qy: number) => number

interface QNode<T> {
  minx: number
  miny: number
  maxx: number
  maxy: number
  items: BBoxItem<T>[]
  children: QNode<T>[] | null // length 4 when split: [SW, SE, NW, NE]
}

const LEAF_CAPACITY = 16 // split a leaf once it holds more than this many items
const MAX_DEPTH = 16 // stop subdividing here; a deeper node just linear-scans its items

// Distance from q to the nearest point of an axis-aligned box (0 if inside). This lower-bounds the
// distance to anything stored under the box, which is what makes branch-and-bound pruning correct:
// every item's own box sits inside its node's box, so a node we can't beat holds nothing we can.
function minDistToBox(b: { minx: number; miny: number; maxx: number; maxy: number }, qx: number, qy: number): number {
  const dx = qx < b.minx ? b.minx - qx : qx > b.maxx ? qx - b.maxx : 0
  const dy = qy < b.miny ? b.miny - qy : qy > b.maxy ? qy - b.maxy : 0
  return Math.hypot(dx, dy)
}

export class Quadtree<T> {
  private root: QNode<T>

  constructor(items: BBoxItem<T>[]) {
    let minx = Infinity
    let miny = Infinity
    let maxx = -Infinity
    let maxy = -Infinity
    for (const it of items) {
      if (it.minx < minx) minx = it.minx
      if (it.miny < miny) miny = it.miny
      if (it.maxx > maxx) maxx = it.maxx
      if (it.maxy > maxy) maxy = it.maxy
    }
    if (!items.length) {
      minx = 0
      miny = 0
      maxx = 0
      maxy = 0
    }
    this.root = { minx, miny, maxx, maxy, items: [], children: null }
    for (const it of items) this.insert(this.root, it, 0)
  }

  private insert(node: QNode<T>, it: BBoxItem<T>, depth: number): void {
    if (node.children) {
      const c = childContaining(node.children, it)
      if (c) {
        this.insert(c, it, depth + 1)
        return
      }
      node.items.push(it) // straddles a split line -> lives at this internal node
      return
    }
    node.items.push(it)
    if (node.items.length > LEAF_CAPACITY && depth < MAX_DEPTH) this.split(node, depth)
  }

  private split(node: QNode<T>, depth: number): void {
    const midx = (node.minx + node.maxx) / 2
    const midy = (node.miny + node.maxy) / 2
    const mk = (minx: number, miny: number, maxx: number, maxy: number): QNode<T> => ({
      minx,
      miny,
      maxx,
      maxy,
      items: [],
      children: null,
    })
    node.children = [
      mk(node.minx, node.miny, midx, midy), // SW
      mk(midx, node.miny, node.maxx, midy), // SE
      mk(node.minx, midy, midx, node.maxy), // NW
      mk(midx, midy, node.maxx, node.maxy), // NE
    ]
    const keep = node.items
    node.items = []
    for (const it of keep) {
      const c = childContaining(node.children, it)
      if (c) this.insert(c, it, depth + 1)
      else node.items.push(it)
    }
  }

  // Nearest item to (qx,qy) under `dist`. Branch-and-bound: skip any subtree whose box is already
  // farther than the best hit so far, and visit nearer children first so that bound tightens fast.
  nearest(qx: number, qy: number, dist: DistFn<T>): { ref: T; distM: number } | null {
    let bestRef: T | null = null
    let bestD = Infinity
    const visit = (node: QNode<T>): void => {
      if (minDistToBox(node, qx, qy) >= bestD) return
      for (const it of node.items) {
        const d = dist(it.ref, qx, qy)
        if (d < bestD) {
          bestD = d
          bestRef = it.ref
        }
      }
      if (node.children) {
        const order = node.children.map((c) => ({ c, d: minDistToBox(c, qx, qy) })).sort((a, b) => a.d - b.d)
        for (const { c, d } of order) {
          if (d >= bestD) break // children are sorted, so every later one is at least as far
          visit(c)
        }
      }
    }
    visit(this.root)
    return bestRef === null ? null : { ref: bestRef, distM: bestD }
  }

  // Every item within radius r of (qx,qy) under `dist`.
  within(qx: number, qy: number, r: number, dist: DistFn<T>): T[] {
    const out: T[] = []
    const visit = (node: QNode<T>): void => {
      if (minDistToBox(node, qx, qy) > r) return
      for (const it of node.items) if (dist(it.ref, qx, qy) <= r) out.push(it.ref)
      if (node.children) for (const c of node.children) visit(c)
    }
    visit(this.root)
    return out
  }
}

// The single child whose box fully contains the item's box, or null if the item straddles a split.
function childContaining<T>(children: QNode<T>[], it: BBoxItem<T>): QNode<T> | null {
  for (const c of children) {
    if (it.minx >= c.minx && it.maxx <= c.maxx && it.miny >= c.miny && it.maxy <= c.maxy) return c
  }
  return null
}
