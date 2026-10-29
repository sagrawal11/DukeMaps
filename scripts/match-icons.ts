// Seed config/building-icons.json: match the committed building-icon SVGs (data/icons-inventory.txt)
// to campus coordinates using the ONLY coordinate source in the repo — the OSM place index
// (public/data/places.json). Per the brief we never invent Duke facts, so an icon is only PLACED on a
// CONFIDENT name match (exact, or an unambiguous containment / very-high token overlap). Weaker guesses
// are recorded as `suggestion`s (not placed) for the user to accept or correct by hand. The app renders
// only entries that have coordinates. Run: `npm run match:icons`.
//
// NOTE: this OVERWRITES config/building-icons.json — it's a one-time seeder. Once you've hand-corrected
// coordinates in that file, don't re-run it (or you'll lose the edits).
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Place } from '../src/graph/types'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const places = JSON.parse(readFileSync(resolve(ROOT, 'public/data/places.json'), 'utf8')) as Place[]
const invLines = readFileSync(resolve(ROOT, 'data/icons-inventory.txt'), 'utf8').trim().split('\n')

interface InvRow { id: string; name: string; area: string; file: string }
const rows: InvRow[] = invLines.map((l) => {
  const [id, name, area, , p] = l.split('|').map((s) => s.trim())
  return { id, name, area, file: `icons/${(p.split('/').pop() as string)}` } // served from public/icons/
})

// Drop punctuation + generic building words so "Perkins Library" matches regardless of suffixes.
const STOP = new Set(['the', 'of', 'and', 'at', 'a', 'for', 'building', 'bldg', 'hall', 'center', 'centre', 'residence', 'quad', 'house', 'school', 'duke', 'campus'])
const norm = (s: string): string => s.toLowerCase().replace(/[/&,.()']/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
const sigToks = (s: string): string[] => norm(s).split(' ').filter((w) => w && !STOP.has(w))
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const P = places.map((p) => ({ p, n: norm(p.name), t: new Set(sigToks(p.name)) }))
const placeByName = new Map(P.map((x) => [x.n, x.p]))

// Hand-curated overrides (config/building-overrides.json), keyed by inventory id: nickname, importance
// tier, and coordinate accepts (`place` = adopt that OSM building's coords; or explicit lat/lon). `_readme` ignored.
interface Override { nick?: string; tier?: number; place?: string; lat?: number; lon?: number; skip?: boolean }
const overrides = JSON.parse(readFileSync(resolve(ROOT, 'config/building-overrides.json'), 'utf8')) as Record<string, Override>
// Fallback label for buildings without a curated nickname: drop the trailing generic word + any "(...)"/"/…".
const deriveNick = (name: string): string =>
  name.split('/')[0].split('(')[0].trim().replace(/\s+(Building|Hall|Residence Hall|Quad|Center|Centre)$/i, '').trim() || name

type Conf = 'exact' | 'contains' | 'weak' | 'none' | 'override'
interface Hit { conf: Conf; place: { name: string; lat: number; lon: number } | null; score: number }
const at = (x: { p: Place }): { name: string; lat: number; lon: number } => ({ name: x.p.name, lat: x.p.lat, lon: x.p.lon })

function match(name: string): Hit {
  const n = norm(name)
  const t = new Set(sigToks(name))

  const exact = P.find((x) => x.n === n)
  if (exact) return { conf: 'exact', place: at(exact), score: 1 }

  // Unambiguous containment: the shorter normalized name is a substring of exactly one place's (guarded
  // by length so short generic strings don't match half the campus).
  const cont = P.filter((x) => {
    const [short, long] = n.length <= x.n.length ? [n, x.n] : [x.n, n]
    return short.length >= 6 && long.includes(short)
  })
  if (cont.length === 1) return { conf: 'contains', place: at(cont[0]), score: 0.9 }

  // Best significant-token overlap — only trusted enough to PLACE when very high; otherwise a suggestion.
  let best: (typeof P)[number] | null = null
  let bs = 0
  for (const x of P) {
    const j = jaccard(t, x.t)
    if (j > bs) { bs = j; best = x }
  }
  if (best && bs >= 0.8) return { conf: 'contains', place: at(best), score: bs }
  if (best && bs >= 0.4) return { conf: 'weak', place: at(best), score: bs }
  return { conf: 'none', place: best ? at(best) : null, score: bs }
}

interface IconEntry {
  id: string
  name: string
  file: string
  area: string
  nickname: string // short label shown under the icon (curated in building-overrides.json, else derived)
  tier: number // importance for the zoom reveal: 1 shows first, 3 last (default)
  lat: number | null // null = not placed; fill it in (coords from you) to show the icon
  lon: number | null
  place: string | null // the OSM place the coordinates came from
  confidence: Conf
  suggestion: { name: string; lat: number; lon: number; score: number } | null // for weak/none — accept by copying into lat/lon
}

const warnings: string[] = []
const out: IconEntry[] = rows.map((r) => {
  const ov = overrides[r.id] ?? {}
  const base = { id: r.id, name: r.name, file: r.file, area: r.area, nickname: ov.nick ?? deriveNick(r.name), tier: ov.tier ?? 3 }

  // skip = suppress a wrong auto-match until a real coordinate is supplied.
  if (ov.skip) return { ...base, lat: null, lon: null, place: null, confidence: 'none' as Conf, suggestion: null }

  // Coordinate priority: explicit override lat/lon > place-accept (adopt an OSM building's coords) > auto name match.
  if (typeof ov.lat === 'number' && typeof ov.lon === 'number') {
    return { ...base, lat: ov.lat, lon: ov.lon, place: ov.place ?? null, confidence: 'override' as Conf, suggestion: null }
  }
  if (ov.place) {
    const p = placeByName.get(norm(ov.place))
    if (p) return { ...base, lat: p.lat, lon: p.lon, place: p.name, confidence: 'override' as Conf, suggestion: null }
    warnings.push(`${r.name}: override place "${ov.place}" not found in places.json`)
  }
  const m = match(r.name)
  const placed = (m.conf === 'exact' || m.conf === 'contains') && m.place !== null
  return {
    ...base,
    lat: placed ? m.place!.lat : null,
    lon: placed ? m.place!.lon : null,
    place: placed ? m.place!.name : null,
    confidence: m.conf,
    suggestion: !placed && m.place ? { ...m.place, score: Number(m.score.toFixed(2)) } : null,
  }
})

writeFileSync(resolve(ROOT, 'config/building-icons.json'), JSON.stringify(out, null, 1) + '\n')

const counts = out.reduce<Record<string, number>>((a, e) => ((a[e.confidence] = (a[e.confidence] ?? 0) + 1), a), {})
const placed = out.filter((e) => e.lat != null).length
console.log(`icons ${out.length} | placed ${placed} | ${JSON.stringify(counts)}`)
if (warnings.length) {
  console.log('\nWARNINGS (override place not found — fix building-overrides.json):')
  for (const w of warnings) console.log(`  ${w}`)
}
console.log('\nNEEDS REVIEW (no confident coordinate — edit config/building-icons.json):')
for (const e of out.filter((e) => e.lat == null)) {
  console.log(`  ${e.name}${e.suggestion ? `  → suggest "${e.suggestion.name}" (${e.suggestion.score})` : '  (no suggestion)'}`)
}
