// Associate each hand-placed door (data/doors.json, from the dev door editor) with the building it sits
// on — the nearest placed building centroid within MAX_M — then apply those doors so routing can
// start/end at the door nearest the other endpoint instead of the building centroid. Writes BOTH:
//   config/building-doors.json  ({ buildingId: [[lon,lat], …] }) — the record match:icons reads on reseed
//   config/building-icons.json  — patched IN PLACE: only each entry's `doors` field is rewritten, so
//     hand-edited nicknames / tiers / coords in that file survive (match:icons would clobber them).
// This is the single, safe command to make placed doors take effect — no match:icons run needed for
// doors. Re-runnable and idempotent. Run: `npm run assign:doors` (after placing doors).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { haversineM } from '../src/graph/geo'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_M = 95 // a door should sit within this of its building's centroid (big quads put doors ~80m out); farther = orphan

interface Icon { id: string; name: string; lat: number | null; lon: number | null; doors: [number, number][] }
const iconsPath = resolve(ROOT, 'config/building-icons.json')
const allIcons = JSON.parse(readFileSync(iconsPath, 'utf8')) as Icon[]
const icons = allIcons.filter((i) => typeof i.lat === 'number' && typeof i.lon === 'number')
const doorsPath = resolve(ROOT, 'data/doors.json')
if (!existsSync(doorsPath)) {
  console.error('[assign:doors] data/doors.json not found — place doors first with the dev 🚪 Doors editor.')
  process.exit(1)
}
const doors = JSON.parse(readFileSync(doorsPath, 'utf8')) as [number, number][]

const byBuilding: Record<string, [number, number][]> = {}
const orphans: [number, number][] = []
for (const [lon, lat] of doors) {
  let best: Icon | null = null
  let bestD = Infinity
  for (const b of icons) {
    const d = haversineM(lat, lon, b.lat as number, b.lon as number)
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  if (best && bestD <= MAX_M) (byBuilding[best.id] ??= []).push([lon, lat])
  else orphans.push([lon, lat])
}

writeFileSync(resolve(ROOT, 'config/building-doors.json'), JSON.stringify(byBuilding, null, 1) + '\n')

// Apply the doors straight into building-icons.json (the file the app imports), touching ONLY each
// entry's `doors` field. Reusing match-icons' serializer keeps key order + format identical, so the diff
// is doors-only — nicknames/tiers/coords hand-edited in this file survive (match:icons would reseed them away).
for (const icon of allIcons) icon.doors = byBuilding[icon.id] ?? []
writeFileSync(iconsPath, JSON.stringify(allIcons, null, 1) + '\n')

const nameOf = (id: string): string => icons.find((i) => i.id === id)?.name ?? id
const assigned = Object.values(byBuilding).reduce((s, l) => s + l.length, 0)
console.log(`doors ${doors.length} | assigned ${assigned} to ${Object.keys(byBuilding).length} buildings | orphans ${orphans.length}`)
for (const [id, list] of Object.entries(byBuilding)) console.log(`  ${nameOf(id)}: ${list.length} door(s)`)
if (orphans.length) console.log(`  ⚠ ${orphans.length} door(s) > ${MAX_M}m from any building (ignored): ${orphans.map((d) => d.map((x) => x.toFixed(5)).join(',')).join(' | ')}`)
