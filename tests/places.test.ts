import { describe, it, expect } from 'vitest'
import { buildPlaceIndex, normalize } from '../src/places/search'
import type { Place } from '../src/graph/types'

const P = (id: string, name: string): Place => ({ id, name, lat: 0, lon: 0 })
const places: Place[] = [
  P('osm:way/1', 'Duke Chapel'),
  P('osm:way/2', 'Perkins Library'),
  P('osm:way/3', 'Bostock Library'),
  P('osm:way/4', 'Richard H. Brodhead Center, West Union'),
  P('osm:way/5', 'Bryan Center'),
  P('osm:way/6', 'Cameron Indoor Stadium'),
]
// A real alias, a multi-word alias, and an unresolved placeholder (as config/aliases.json ships).
const aliases = { WU: 'Richard H. Brodhead Center, West Union', 'the Chapel': 'Duke Chapel', XX: '<place id or building name>' }
const idx = buildPlaceIndex(places, aliases)
const names = (q: string, n?: number): string[] => idx.search(q, n).map((p) => p.name)

describe('normalize', () => {
  it('lowercases and strips punctuation + accents', () => {
    expect(normalize('Richard H. Brodhead Center, West Union')).toBe('richard h brodhead center west union')
    expect(normalize('Café')).toBe('cafe')
  })
})

describe('ranking', () => {
  it('exact name wins', () => {
    expect(names('Duke Chapel')[0]).toBe('Duke Chapel')
  })
  it('matches a whole-string prefix', () => {
    expect(names('perk')[0]).toBe('Perkins Library')
  })
  it('matches an interior word prefix (both libraries, shorter then alphabetical)', () => {
    expect(names('library')).toEqual(['Bostock Library', 'Perkins Library'])
  })
  it('still matches a subsequence (fuzzy)', () => {
    expect(names('brcntr')).toContain('Bryan Center')
  })
  it('ranks a prefix above a fuzzy match', () => {
    expect(names('bost')[0]).toBe('Bostock Library')
  })
})

describe('aliases', () => {
  it('resolves a nickname to its place', () => {
    expect(names('WU')[0]).toBe('Richard H. Brodhead Center, West Union')
  })
  it('resolves a multi-word alias', () => {
    expect(names('the chapel')[0]).toBe('Duke Chapel')
  })
  it('silently ignores an unresolved placeholder alias', () => {
    expect(names('XX')).toEqual([])
  })
})

describe('limit + empty query', () => {
  it('respects the limit', () => {
    expect(idx.search('e', 2).length).toBeLessThanOrEqual(2)
  })
  it('returns nothing for a blank query', () => {
    expect(names('   ')).toEqual([])
  })
})
