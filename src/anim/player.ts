// The Trace player: replays an algorithm's event stream over time so the map can animate it. Pure
// except for the requestAnimationFrame loop — the event-folding (applyEvent/foldEvents) is plain data
// and unit-tested; the player just advances a cursor and calls a render callback. No DOM/map deps, so
// swapping the renderer (canvas now, WebGL later, a test spy in between) costs nothing.
import type { Trace, TraceEvent } from '../algorithms/trace'

// What the map needs to draw at a moment in the replay. Sets, so re-adding is idempotent and cheap.
// Searches that work from both ends (bidirectional, CH, CCH) tag events with side 'f'/'b'; the backward
// frontier gets its own sets so the map can colour the two halves differently and the meeting reads.
export interface RenderState {
  discovered: Set<number> // forward frontier (and the only frontier for single-ended searches)
  settled: Set<number> // forward settled
  discoveredB: Set<number> // backward frontier
  settledB: Set<number> // backward settled
  relaxed: Set<string> // edge ids that improved a neighbour (the explored "tree")
  skipped: Set<string> // edge ids dropped for access (drawn faded, not red)
  current: number | null // the node just settled (highlighted)
  done: boolean // all events folded
}

export function emptyState(): RenderState {
  return {
    discovered: new Set(),
    settled: new Set(),
    discoveredB: new Set(),
    settledB: new Set(),
    relaxed: new Set(),
    skipped: new Set(),
    current: null,
    done: false,
  }
}

// Fold one event into the state. meet/shortcut carry no 6a visual (they arrive with bidirectional/CH
// styling in 6b); folding them is a harmless no-op here.
export function applyEvent(s: RenderState, e: TraceEvent): void {
  switch (e.type) {
    case 'push':
      if (e.node != null) (e.side === 'b' ? s.discoveredB : s.discovered).add(e.node)
      break
    case 'settle':
      if (e.node != null) {
        ;(e.side === 'b' ? s.settledB : s.settled).add(e.node)
        s.current = e.node
      }
      break
    case 'relax':
      if (e.edge != null) s.relaxed.add(e.edge)
      break
    case 'skip':
      if (e.edge != null) s.skipped.add(e.edge)
      break
    case 'found':
      if (e.node != null) s.current = e.node
      s.done = true
      break
  }
}

// Build the state after the first `count` events — used by the unit test and by skip-to-result.
export function foldEvents(events: TraceEvent[], count: number): RenderState {
  const s = emptyState()
  const n = Math.min(Math.max(0, count), events.length)
  for (let i = 0; i < n; i++) applyEvent(s, events[i])
  if (n >= events.length) s.done = true
  return s
}

export interface Player {
  play(): void
  pause(): void
  setSpeed(x: number): void
  skipToResult(): void
  dispose(): void
  readonly playing: boolean
  progress(): number // 0..1
}

// Drive a Trace over wall-clock time. eventsPerSecond × speed sets how fast the frontier grows; the
// render callback fires each frame with the folded state. reducedMotion jumps straight to the result.
export function makePlayer(
  trace: Trace,
  render: (s: RenderState) => void,
  opts: { speed?: number; eventsPerSecond?: number; reducedMotion?: boolean; onDone?: () => void } = {},
): Player {
  const eps = opts.eventsPerSecond ?? 1800
  let speed = opts.speed ?? 1
  const state = emptyState()
  let cursor = 0 // events folded so far (integer)
  let pos = 0 // fractional target cursor
  let playing = false
  let raf = 0
  let last = 0

  const foldTo = (targetFloat: number): void => {
    const t = Math.min(Math.floor(targetFloat), trace.events.length)
    while (cursor < t) applyEvent(state, trace.events[cursor++])
  }
  const finish = (): void => {
    foldTo(trace.events.length)
    state.done = true
    render(state)
    opts.onDone?.()
  }
  const frame = (ts: number): void => {
    if (!playing) return
    const dt = Math.min((ts - last) / 1000, 0.1) // clamp big gaps (tab was backgrounded)
    last = ts
    pos += eps * speed * dt
    foldTo(pos)
    render(state)
    if (cursor >= trace.events.length) {
      playing = false
      finish()
      return
    }
    raf = requestAnimationFrame(frame)
  }

  return {
    get playing() {
      return playing
    },
    progress() {
      return trace.events.length ? cursor / trace.events.length : 1
    },
    play() {
      if (playing || state.done) return
      if (opts.reducedMotion) {
        finish()
        return
      }
      playing = true
      last = performance.now()
      raf = requestAnimationFrame(frame)
    },
    pause() {
      playing = false
      if (raf) cancelAnimationFrame(raf)
    },
    setSpeed(x: number) {
      speed = x
    },
    skipToResult() {
      playing = false
      if (raf) cancelAnimationFrame(raf)
      finish()
    },
    dispose() {
      playing = false
      if (raf) cancelAnimationFrame(raf)
    },
  }
}
