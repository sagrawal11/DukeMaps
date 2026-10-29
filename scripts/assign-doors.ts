// Associate each hand-placed door (data/doors.json, from the dev door editor) with the building it sits
// on — the nearest placed building centroid within MAX_M — and write config/building-doors.json
// ({ buildingId: [[lon,lat], …] }). `npm run match:icons` then merges those into building-icons.json so
// routing can start/end at the door nearest the other endpoint instead of the building centroid. Run:
// `npm run assign:doors` (after placing doors). Re-runnable; overwrites building-doors.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { haversineM } from '../src/graph/geo'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_M = 70 // a door should sit within this of its building's centroid; farther = orphan (warned)

interface Icon { id: string; name: string; lat: number | null; lon: number | null }
const icons = (JSON.parse(readFileSync(resolve(ROOT, 'config/building-icons.json'), 'utf8')) as Icon[]).filter(
  (i) => typeof i.lat === 'number' && typeof i.lon === 'number',
)
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

const nameOf = (id: string): string => icons.find((i) => i.id === id)?.name ?? id
const assigned = Object.values(byBuilding).reduce((s, l) => s + l.length, 0)
console.log(`doors ${doors.length} | assigned ${assigned} to ${Object.keys(byBuilding).length} buildings | orphans ${orphans.length}`)
for (const [id, list] of Object.entries(byBuilding)) console.log(`  ${nameOf(id)}: ${list.length} door(s)`)
if (orphans.length) console.log(`  ⚠ ${orphans.length} door(s) > ${MAX_M}m from any building (ignored): ${orphans.map((d) => d.map((x) => x.toFixed(5)).join(',')).join(' | ')}`)
