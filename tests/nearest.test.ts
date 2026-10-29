// PlaceIndex.nearest labels a dropped pin with the building you're at. Pure (centroids in, place out),
// so a tiny hand-placed set with known distances pins the radius behaviour.
import { describe, it, expect } from 'vitest'
import { buildPlaceIndex } from '../src/places/search'
import type { Place } from '../src/graph/types'

const place = (id: string, name: string, lat: number, lon: number): Place => ({ id, name, lat, lon })

describe('PlaceIndex.nearest', () => {
  const idx = buildPlaceIndex([
    place('a', 'Bryan Center', 36.001, -78.94),
    place('b', 'Perkins Library', 36.002, -78.942),
    place('c', 'Cameron Indoor', 36.01, -78.943),
  ])

  it('returns the closest building within the radius', () => {
    expect(idx.nearest(36.0011, -78.9401, 70)?.name).toBe('Bryan Center') // ~14 m from Bryan Center
  })

  it('returns null when nothing is within the radius', () => {
    expect(idx.nearest(36.05, -78.88, 70)).toBeNull() // kilometres away in Durham
  })

  it('picks the nearer of two candidates', () => {
    expect(idx.nearest(36.0019, -78.9419, 120)?.name).toBe('Perkins Library') // closer to Perkins than Bryan
  })
})
