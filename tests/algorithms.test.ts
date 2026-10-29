import { describe, it, expect } from 'vitest'
import { MinHeap } from '../src/algorithms/heap'

describe('MinHeap', () => {
  it('pops items in ascending priority order (random stress)', () => {
    const h = new MinHeap()
    const entries = Array.from({ length: 500 }, (_, i) => ({ item: i, p: Math.random() }))
    for (const { item, p } of entries) h.push(item, p)
    const out: number[] = []
    while (h.size > 0) out.push(h.pop() as number)
    const expected = [...entries].sort((a, b) => a.p - b.p).map((e) => e.item)
    expect(out).toEqual(expected)
  })

  it('decrease-key: a smaller re-push floats an item to the top', () => {
    const h = new MinHeap()
    h.push(1, 10)
    h.push(2, 20)
    h.push(3, 30)
    h.push(3, 5) // decrease key of item 3 below everything
    expect(h.pop()).toBe(3)
    expect(h.pop()).toBe(1)
    expect(h.pop()).toBe(2)
  })

  it('ignores a re-push with a larger priority and never duplicates an item', () => {
    const h = new MinHeap()
    h.push(1, 10)
    h.push(1, 99)
    expect(h.size).toBe(1)
    expect(h.pop()).toBe(1)
    expect(h.pop()).toBeUndefined()
  })
})
