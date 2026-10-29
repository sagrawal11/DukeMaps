import { describe, it, expect } from 'vitest'
import { hmsToSec, isOpenAt, crowdingMultiplier, effectiveWeightS, type Schedule, type When } from '../src/graph/time'
import type { OpenInterval } from '../src/graph/types'

// Synthetic schedule — never real Duke times. One class ends at 12:00, crowding peaks 90 s after.
const SCHED: Schedule = {
  classEndTimes: ['12:00'],
  crowding: { windowMinutes: 10, rampShape: 'cos', peakMultiplier: 1.5, radiusMeters: 100, peakLagS: 90 },
  academicBuildings: ['X'],
}
const weekday = (secOfDay: number): When => ({ secOfDay, isWeekend: false })
const PEAK = hmsToSec('12:00') + 90 // 43290

describe('hmsToSec', () => {
  it('parses HH:MM to seconds since midnight', () => {
    expect(hmsToSec('00:00')).toBe(0)
    expect(hmsToSec('12:05')).toBe(43500)
  })
})

describe('isOpenAt', () => {
  it('no hours = always open', () => {
    expect(isOpenAt(undefined, 43200)).toBe(true)
    expect(isOpenAt([], 0)).toBe(true)
  })
  it('a daytime window (end-exclusive)', () => {
    const h: OpenInterval[] = [{ start: '09:00', end: '17:00' }]
    expect(isOpenAt(h, hmsToSec('12:00'))).toBe(true)
    expect(isOpenAt(h, hmsToSec('08:00'))).toBe(false)
    expect(isOpenAt(h, hmsToSec('17:00'))).toBe(false)
  })
  it('an interval that wraps past midnight', () => {
    const h: OpenInterval[] = [{ start: '22:00', end: '02:00' }]
    expect(isOpenAt(h, hmsToSec('23:00'))).toBe(true)
    expect(isOpenAt(h, hmsToSec('01:00'))).toBe(true)
    expect(isOpenAt(h, hmsToSec('12:00'))).toBe(false)
  })
})

describe('crowdingMultiplier', () => {
  it('is 1 on weekends', () => {
    expect(crowdingMultiplier(50, { secOfDay: PEAK, isWeekend: true }, SCHED)).toBe(1)
  })
  it('is 1 with no nearby academic building or outside the radius', () => {
    expect(crowdingMultiplier(null, weekday(PEAK), SCHED)).toBe(1)
    expect(crowdingMultiplier(150, weekday(PEAK), SCHED)).toBe(1) // 150 m > radius 100 m
  })
  it('peaks at peakMultiplier, strictly after the class end', () => {
    expect(crowdingMultiplier(50, weekday(PEAK), SCHED)).toBeCloseTo(1.5, 5)
    expect(crowdingMultiplier(50, weekday(PEAK), SCHED)).toBeGreaterThan(
      crowdingMultiplier(50, weekday(hmsToSec('12:00')), SCHED),
    )
  })
  it('is 1 well outside the window', () => {
    expect(crowdingMultiplier(50, weekday(PEAK - 600), SCHED)).toBe(1)
    expect(crowdingMultiplier(50, weekday(PEAK + 600), SCHED)).toBe(1)
  })
  it('combines multiple class times with max (stays high between close peaks)', () => {
    const two: Schedule = { ...SCHED, classEndTimes: ['12:00', '12:02'] }
    const mid = (hmsToSec('12:00') + 90 + (hmsToSec('12:02') + 90)) / 2
    expect(crowdingMultiplier(50, weekday(mid), two)).toBeGreaterThan(1.44)
  })
})

describe('effectiveWeightS', () => {
  it('returns Infinity when the edge is closed', () => {
    const open9to5: OpenInterval[] = [{ start: '09:00', end: '17:00' }]
    expect(effectiveWeightS(100, open9to5, null, weekday(hmsToSec('03:00')), SCHED)).toBe(Infinity)
  })
  it('returns the base weight when open with no nearby crowding', () => {
    expect(effectiveWeightS(100, undefined, null, weekday(PEAK), SCHED)).toBe(100)
  })
  it('scales the base weight by the crowding multiplier', () => {
    expect(effectiveWeightS(100, undefined, 50, weekday(PEAK), SCHED)).toBeCloseTo(150, 5)
  })
})

describe('FIFO bound', () => {
  it('arrival A(t)=t+base*mult is non-decreasing across a bump for realistic edge lengths', () => {
    for (const base of [5, 20, 60, 120]) {
      let prev = -Infinity
      for (let t = PEAK - 300; t <= PEAK + 300; t++) {
        const A = t + base * crowdingMultiplier(50, weekday(t), SCHED)
        expect(A).toBeGreaterThanOrEqual(prev - 1e-6)
        prev = A
      }
    }
  })
})
