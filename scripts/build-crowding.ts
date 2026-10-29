// Precompute, per edge, the distance to the nearest academic building — matched by name from
// config/schedule.json against data/processed/places.json — capped at MAX_ACADEMIC_DIST_M. Writes
// public/data/crowding.json so the app + Phase 5 routing apply the class-change crowding multiplier
// without recomputing distances per query. Re-run whenever schedule.json changes (no OSM re-fetch).
// Empty `dist` when no academic buildings are configured — crowding is simply "off" then.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Graph, Place } from '../src/graph/types'
import { projectPointOnPolyline } from '../src/graph/editing'
import { MAX_ACADEMIC_DIST_M, type Schedule } from '../src/graph/time'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function main(): void {
  const graphPath = resolve(ROOT, 'data/processed/graph.base.json')
  if (!existsSync(graphPath)) {
    console.error('[build:crowding] data/processed/graph.base.json missing — run `npm run build:graph` first.')
    process.exit(1)
  }
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph
  const places = JSON.parse(readFileSync(resolve(ROOT, 'data/processed/places.json'), 'utf8')) as Place[]
  const schedule = JSON.parse(readFileSync(resolve(ROOT, 'config/schedule.json'), 'utf8')) as Schedule

  // Name-match academic buildings against the place index (case-insensitive). A typo here = a
  // building that produces NO crowding, which looks exactly like "working" — so report misses loudly.
  const norm = (s: string): string => s.trim().toLowerCase()
  const names = schedule.academicBuildings ?? []
  const matchedPlaces = places.filter((p) => names.some((n) => norm(n) === norm(p.name)))
  const matched = [...new Set(matchedPlaces.map((p) => p.name))]
  const unmatched = names.filter((n) => !places.some((p) => norm(p.name) === norm(n)))

  // Per edge, nearest distance from its geometry to any matched academic centroid; keep only edges
  // within the cap (everything else is never crowdable). O(edges × buildings) one-shot linear scan.
  const dist: Record<string, number> = {}
  for (const e of graph.edges) {
    let nearest = Infinity
    for (const p of matchedPlaces) {
      const d = projectPointOnPolyline(e.geometry, [p.lon, p.lat]).distM
      if (d < nearest) nearest = d
      if (nearest === 0) break
    }
    if (nearest <= MAX_ACADEMIC_DIST_M) dist[e.id] = Math.round(nearest * 10) / 10
  }

  const outDir = resolve(ROOT, 'public/data')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    resolve(outDir, 'crowding.json'),
    JSON.stringify({ meta: { builtAt: new Date().toISOString(), matched, unmatched }, dist }),
  )

  console.log('[build:crowding] ──── report ────')
  console.log(`  academic buildings configured: ${names.length}   matched: ${matched.length}   crowdable edges: ${Object.keys(dist).length}`)
  if (unmatched.length) {
    console.log(`  ⚠ ${unmatched.length} name(s) not found in places.json (they produce NO crowding):`)
    for (const n of unmatched) console.log(`    - ${n}`)
  }
  console.log('[build:crowding] wrote public/data/crowding.json')
}

main()
