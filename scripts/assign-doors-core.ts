// Door-assignment core, shared by the `assign:doors` CLI (scripts/assign-doors.ts) and the dev-server
// auto-assign (vite.config.ts, which runs it on every door save). Associates each hand-placed door
// (data/doors.json) with the nearest placed building centroid within MAX_M, writes config/building-doors.json,
// AND patches config/building-icons.json in place — touching ONLY each entry's `doors` field, so hand-edited
// nicknames/tiers/coords survive. Re-runnable, idempotent, and side-effect-free on import.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { haversineM } from '../src/graph/geo'

export const MAX_M = 95 // a door should sit within this of its building's centroid (big quads put doors ~80m out); farther = orphan

interface Icon { id: string; name: string; lat: number | null; lon: number | null; doors: [number, number][] }

export interface AssignResult {
  doors: number // total door points read
  assigned: number // doors within MAX_M of a building
  byBuilding: Record<string, [number, number][]> // doors keyed by building id
  orphans: [number, number][] // doors too far from any building (ignored)
  nameOf: (id: string) => string // building id -> name, for logging
}

export function assignDoors(root: string): AssignResult {
  const iconsPath = resolve(root, 'config/building-icons.json')
  const allIcons = JSON.parse(readFileSync(iconsPath, 'utf8')) as Icon[]
  const icons = allIcons.filter((i) => typeof i.lat === 'number' && typeof i.lon === 'number')
  const doorsPath = resolve(root, 'data/doors.json')
  const doors = existsSync(doorsPath) ? (JSON.parse(readFileSync(doorsPath, 'utf8')) as [number, number][]) : []

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

  writeFileSync(resolve(root, 'config/building-doors.json'), JSON.stringify(byBuilding, null, 1) + '\n')
  // Reusing match-icons' serializer keeps key order + format identical, so the diff is doors-only.
  for (const icon of allIcons) icon.doors = byBuilding[icon.id] ?? []
  writeFileSync(iconsPath, JSON.stringify(allIcons, null, 1) + '\n')

  const nameOf = (id: string): string => icons.find((i) => i.id === id)?.name ?? id
  const assigned = Object.values(byBuilding).reduce((s, l) => s + l.length, 0)
  return { doors: doors.length, assigned, byBuilding, orphans, nameOf }
}
