// Binary min-heap with decrease-key — the priority queue behind Dijkstra and A*. Hand-written, no
// library (brief non-negotiable). Items are integers (node indices) keyed by a numeric priority; a
// position map (item -> slot) makes decrease-key O(log n) instead of a linear scan. Array-as-tree
// layout: children of slot i are 2i+1 and 2i+2, parent is (i-1)>>1.
export class MinHeap {
  private items: number[] = []
  private prio: number[] = []
  private pos = new Map<number, number>() // item -> index in `items`

  get size(): number {
    return this.items.length
  }

  has(item: number): boolean {
    return this.pos.has(item)
  }

  // Insert item, or lower its key if it's already present and the new priority is smaller. This one
  // method doubles as push and decrease-key, which is all Dijkstra/A* need.
  push(item: number, priority: number): void {
    const existing = this.pos.get(item)
    if (existing !== undefined) {
      if (priority < this.prio[existing]) {
        this.prio[existing] = priority
        this.siftUp(existing)
      }
      return
    }
    this.items.push(item)
    this.prio.push(priority)
    this.pos.set(item, this.items.length - 1)
    this.siftUp(this.items.length - 1)
  }

  // Remove and return the minimum-priority item (undefined if empty).
  pop(): number | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    this.pos.delete(top)
    const lastItem = this.items.pop() as number
    const lastPrio = this.prio.pop() as number
    if (this.items.length > 0) {
      this.items[0] = lastItem
      this.prio[0] = lastPrio
      this.pos.set(lastItem, 0)
      this.siftDown(0)
    }
    return top
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.prio[parent] <= this.prio[i]) break
      this.swap(i, parent)
      i = parent
    }
  }

  private siftDown(i: number): void {
    const n = this.items.length
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let smallest = i
      if (l < n && this.prio[l] < this.prio[smallest]) smallest = l
      if (r < n && this.prio[r] < this.prio[smallest]) smallest = r
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a]
    this.items[a] = this.items[b]
    this.items[b] = ti
    const tp = this.prio[a]
    this.prio[a] = this.prio[b]
    this.prio[b] = tp
    this.pos.set(this.items[a], a)
    this.pos.set(this.items[b], b)
  }
}
