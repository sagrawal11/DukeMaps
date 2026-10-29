// Time-dependent edge cost: class-change crowding + open-hours gating. Pure (no fs/DOM), so it's
// unit-tested in tests/time.test.ts. This is the Phase 5 hand-off: routing algorithms call
// `effectiveWeightS(edge.weightS, edge.hours, dist, when)` instead of reading `edge.weightS` — the
// weight is evaluated at the time the walker REACHES the edge (time-dependent routing).
//
// FIFO (why Dijkstra / A* stay correct):
//   Arrival after traversing an edge is A(t) = t + base·m(t), where t is the arrival-at-edge time,
//   `base` the base walking seconds, and m(t) ≥ 1 the crowding multiplier. A shortest-path search
//   is correct on a time-dependent network iff it is FIFO (no-overtaking): leaving later never lets
//   you arrive earlier, i.e. A(t) is non-decreasing, i.e. A'(t) = 1 + base·m'(t) ≥ 0  ⇔  m'(t) ≥ −1/base.
//   The only negative slope is a bump's decay side. Campus edges are short (base ≈ 7–70 s) and a
//   bump spans minutes, so |m'(t)| ≈ (peak−1)/windowSeconds ~ 1e-3/s, while 1/base ≥ ~0.014/s — three+
//   orders of magnitude of headroom. So FIFO holds and Dijkstra/A* are exact. (tests/time.test.ts has
//   an executable scan of this bound.) Closed edges return Infinity — impassable, never relaxed, so
//   they can't break FIFO either (we model no "wait until it opens").
import type { OpenInterval } from './types'

// --- tunable knobs (tune the numbers, not the code) ---
// Sidecar cap in scripts/build-crowding.ts: an edge farther than this from every academic building
// is never crowdable, so it's dropped from crowding.json. `schedule.crowding.radiusMeters` must be
// ≤ this. ponytail: 400 m is comfortably above any sane crowding radius; raise only if radius grows.
export const MAX_ACADEMIC_DIST_M = 400
// How long after a class ends the crowd peaks (halls fill as class lets out, worst a beat later).
// A modeling default, not a Duke fact — overridable per-schedule via crowding.peakLagS.
export const DEFAULT_PEAK_LAG_S = 90

export interface Schedule {
  classEndTimes: string[] // weekday "HH:MM" times, each triggering a crowding bump
  crowding: {
    windowMinutes: number // full width of a bump (ramp up + decay)
    rampShape: 'cos' | 'tri' // raised-cosine (smooth) or triangular (linear)
    peakMultiplier: number // worst-case slowdown factor at the peak (≥ 1)
    radiusMeters: number // crowding reaches this far from an academic building
    peakLagS?: number // overrides DEFAULT_PEAK_LAG_S
  }
  academicBuildings: string[] // building names (match data/processed/places.json) that cause crowding
}

export interface When {
  secOfDay: number // seconds since local midnight
  isWeekend: boolean // weekends have no class-change crowding
}

// "12:05" -> 43500. The single time-parse point.
export function hmsToSec(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 3600 + Number(m) * 60
}

// Is the edge usable at this time of day? No `hours` = always open. An interval may wrap past
// midnight (e.g. 22:00–02:00). Any matching interval = open.
export function isOpenAt(hours: OpenInterval[] | undefined, secOfDay: number): boolean {
  if (!hours || hours.length === 0) return true
  for (const h of hours) {
    const start = hmsToSec(h.start)
    const end = hmsToSec(h.end)
    const open = start <= end ? secOfDay >= start && secOfDay < end : secOfDay >= start || secOfDay < end
    if (open) return true
  }
  return false
}

// Crowding multiplier (≥ 1) for an edge `distToAcademicM` from the nearest academic building. 1.0 on
// weekends, when there's no nearby academic building, or outside the radius. Otherwise a bump per
// class-end time: a raised-cosine (or triangular) bell peaking `peakLagS` AFTER the class ends, with
// full width `windowMinutes`. Multiple class times combine with MAX (the hall is as bad as the worst
// concurrent release; keeps the multiplier bounded by peakMultiplier and the FIFO analysis a
// single-bump argument).
export function crowdingMultiplier(distToAcademicM: number | null, when: When, s: Schedule): number {
  if (when.isWeekend) return 1
  if (distToAcademicM == null || distToAcademicM > s.crowding.radiusMeters) return 1
  const halfW = (s.crowding.windowMinutes * 60) / 2
  if (halfW <= 0 || s.crowding.peakMultiplier <= 1) return 1
  const peakLag = s.crowding.peakLagS ?? DEFAULT_PEAK_LAG_S
  let mult = 1
  for (const hhmm of s.classEndTimes) {
    const d = when.secOfDay - (hmsToSec(hhmm) + peakLag)
    if (Math.abs(d) >= halfW) continue
    const x = d / halfW // -1..1 across the bump, 0 at the peak
    const shape = s.crowding.rampShape === 'tri' ? 1 - Math.abs(x) : 0.5 * (1 + Math.cos(Math.PI * x))
    mult = Math.max(mult, 1 + (s.crowding.peakMultiplier - 1) * shape)
  }
  return mult
}

// The effective traversal seconds at time `when`: base × crowding, or Infinity if the edge is closed
// (then it's absent for this query). THIS is what Phase 5 algorithms call per edge.
export function effectiveWeightS(
  baseWeightS: number,
  hours: OpenInterval[] | undefined,
  distToAcademicM: number | null,
  when: When,
  s: Schedule,
): number {
  if (!isOpenAt(hours, when.secOfDay)) return Infinity
  return baseWeightS * crowdingMultiplier(distToAcademicM, when, s)
}
