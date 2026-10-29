import { describe, it, expect } from 'vitest'
import { emptyState, applyEvent, foldEvents } from '../src/anim/player'
import type { TraceEvent } from '../src/algorithms/trace'

// A hand trace standing in for an algorithm's event stream (push → settle → relax/skip → found).
const events: TraceEvent[] = [
  { type: 'push', node: 1 },
  { type: 'settle', node: 1 },
  { type: 'relax', edge: 'a' },
  { type: 'push', node: 2 },
  { type: 'skip', edge: 'b' },
  { type: 'settle', node: 2 },
  { type: 'found', node: 2 },
]

describe('trace player — event folding', () => {
  it('folds the full stream into the render-state sets', () => {
    const s = foldEvents(events, events.length)
    expect([...s.discovered].sort()).toEqual([1, 2])
    expect([...s.settled].sort()).toEqual([1, 2])
    expect([...s.relaxed]).toEqual(['a'])
    expect([...s.skipped]).toEqual(['b'])
    expect(s.current).toBe(2)
    expect(s.done).toBe(true)
  })

  it('reveals state incrementally as the cursor advances', () => {
    const s1 = foldEvents(events, 1) // just the first push
    expect([...s1.discovered]).toEqual([1])
    expect(s1.settled.size).toBe(0)
    expect(s1.done).toBe(false)

    const s3 = foldEvents(events, 3) // push 1, settle 1, relax a
    expect(s3.settled.has(1)).toBe(true)
    expect(s3.relaxed.has('a')).toBe(true)
    expect(s3.current).toBe(1)
    expect(s3.done).toBe(false)
  })

  it('is idempotent on re-pushed nodes and marks done on found', () => {
    const s = emptyState()
    applyEvent(s, { type: 'push', node: 5 })
    applyEvent(s, { type: 'push', node: 5 })
    expect(s.discovered.size).toBe(1)
    expect(s.done).toBe(false)
    applyEvent(s, { type: 'found', node: 5 })
    expect(s.done).toBe(true)
  })

  it('routes backward-side events to the backward sets (bidirectional / CH / CCH)', () => {
    const s = emptyState()
    applyEvent(s, { type: 'push', node: 1, side: 'f' })
    applyEvent(s, { type: 'push', node: 2, side: 'b' })
    applyEvent(s, { type: 'settle', node: 2, side: 'b' })
    expect([...s.discovered]).toEqual([1])
    expect([...s.discoveredB]).toEqual([2])
    expect([...s.settledB]).toEqual([2])
    expect(s.settled.size).toBe(0)
  })

  it('folds a meet event into met (the CH/CCH apex touch); CH up-arc relaxes carry no edge', () => {
    const s = emptyState()
    expect(s.met).toBe(false)
    applyEvent(s, { type: 'relax', edge: 'a' }) // plain search: a real graph edge
    applyEvent(s, { type: 'relax', side: 'f' }) // a CH up-arc relax carries no graph edge
    expect([...s.relaxed]).toEqual(['a'])
    applyEvent(s, { type: 'meet', node: 7, side: 'f' })
    expect(s.met).toBe(true)
  })
})
