// Phase-4 place search: dependency-free fuzzy autocomplete over OSM building names plus the
// nicknames in config/aliases.json. The brief bans routing/graph/spatial-index libraries; a search
// library isn't banned, but this matcher is short, so we hand-roll it and keep the dep count at
// zero. Pure (data in, ranked places out) so it's unit-tested without any fetch/DOM.
import type { Place } from '../graph/types'
import { haversineM } from '../graph/geo'

// lowercase, strip accents, collapse every run of non-alphanumerics to a single space.
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Match quality, higher = better; 0 means "no match" (excluded). Tiers, best to worst:
// 5 exact · 4 whole-string prefix · 3 any-word prefix · 2 substring · 1 subsequence (fuzzy).
function matchTier(queryNorm: string, textNorm: string): number {
  if (!queryNorm || !textNorm) return 0
  if (textNorm === queryNorm) return 5
  if (textNorm.startsWith(queryNorm)) return 4
  if (textNorm.split(' ').some((w) => w.startsWith(queryNorm))) return 3
  if (textNorm.includes(queryNorm)) return 2
  return isSubsequence(queryNorm, textNorm) ? 1 : 0
}

// Do all of q's characters appear in t in order (not necessarily adjacent)? e.g. "brcntr" ⊆ "bryan
// center". This is autocomplete's forgiving tail — abbreviations and dropped letters still land.
function isSubsequence(q: string, t: string): boolean {
  let ti = 0
  for (const ch of q) {
    while (ti < t.length && t[ti] !== ch) ti++
    if (ti >= t.length) return false
    ti++
  }
  return true
}

interface Entry {
  place: Place
  terms: string[] // normalized searchable strings: the name first, then any aliases
}

export interface PlaceIndex {
  search(query: string, limit?: number): Place[]
  byId(id: string): Place | undefined
  nearest(lat: number, lon: number, maxM?: number): Place | null // nearest building centroid within maxM
}

// aliases: nickname -> place id OR exact building name (config/aliases.json). Unresolved entries —
// e.g. the placeholder "<place id or building name>" — are silently skipped, so search works before
// the user fills the file in.
export function buildPlaceIndex(places: Place[], aliases: Record<string, string> = {}): PlaceIndex {
  const byId = new Map(places.map((p) => [p.id, p]))
  const byName = new Map(places.map((p) => [normalize(p.name), p]))
  const entries = new Map<string, Entry>(places.map((p) => [p.id, { place: p, terms: [normalize(p.name)] }]))

  for (const [nick, target] of Object.entries(aliases)) {
    const place = byId.get(target) ?? byName.get(normalize(target))
    if (place) entries.get(place.id)!.terms.push(normalize(nick))
  }
  const list = [...entries.values()]

  return {
    byId: (id) => byId.get(id),
    // Nearest building to a tapped point (linear scan — 313 places, trivial). Labels a dropped pin with
    // the building you're at, instead of the snapped path location.
    nearest(lat, lon, maxM = 70) {
      let best: Place | null = null
      let bestD = Infinity
      for (const p of places) {
        const d = haversineM(lat, lon, p.lat, p.lon)
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      return best && bestD <= maxM ? best : null
    },
    search(query, limit = 8) {
      const q = normalize(query)
      if (!q) return []
      const scored: { place: Place; tier: number }[] = []
      for (const e of list) {
        let tier = 0
        for (const term of e.terms) {
          const t = matchTier(q, term)
          if (t > tier) tier = t
        }
        if (tier > 0) scored.push({ place: e.place, tier })
      }
      // tier desc, then shorter names first (more specific), then alphabetical for a stable order.
      scored.sort(
        (a, b) => b.tier - a.tier || a.place.name.length - b.place.name.length || a.place.name.localeCompare(b.place.name),
      )
      return scored.slice(0, limit).map((s) => s.place)
    },
  }
}
