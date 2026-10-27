// Shared loader for config/campus.json. Node-only (reads fs), so it lives under scripts/
// rather than src/ (which the browser app bundles).
//
// Each area is a freeform [lon, lat] polygon (from `npm run bbox`). We derive each area's
// bounding box for the OSM fetch and keep the polygon for precise area tagging. A plain
// bbox entry is still accepted as a fallback. Areas with neither are skipped with a warning.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AreaBBox } from '../src/osm/overpass'
import type { Area } from '../src/graph/types'

interface AreaEntry {
  polygon?: [number, number][]
  bbox?: (number | null)[]
}

export function loadAreas(root: string): AreaBBox[] {
  const cfg = JSON.parse(readFileSync(resolve(root, 'config/campus.json'), 'utf8')) as {
    areas?: Record<string, AreaEntry>
  }
  const areas: AreaBBox[] = []
  for (const [name, entry] of Object.entries(cfg.areas ?? {})) {
    const polygon = entry?.polygon
    if (polygon && polygon.length >= 3) {
      const lats = polygon.map((p) => p[1])
      const lons = polygon.map((p) => p[0])
      const bbox: [number, number, number, number] = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)]
      areas.push({ area: name as Area, bbox, polygon })
      continue
    }
    const bbox = entry?.bbox ?? []
    if (bbox.length === 4 && bbox.every((v): v is number => typeof v === 'number')) {
      areas.push({ area: name as Area, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] })
    } else {
      console.warn(`[campus] skipping "${name}" — no polygon or bbox filled in (run \`npm run bbox\`)`)
    }
  }
  return areas
}
