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

// Overall Duke extent for the OSM fetch + basemap: one bounding box covering ALL regions and
// the ground between them, so the resulting graph is a single connected network. Uses an
// explicit `bounds.bbox` from config if present; otherwise derives it from the regions' union.
export function loadBounds(root: string, margin = 0.002): [number, number, number, number] {
  const cfg = JSON.parse(readFileSync(resolve(root, 'config/campus.json'), 'utf8')) as {
    bounds?: { bbox?: (number | null)[] }
  }
  const b = cfg.bounds?.bbox
  if (b && b.length === 4 && b.every((v): v is number => typeof v === 'number')) {
    return [b[0], b[1], b[2], b[3]]
  }
  const pts = loadAreas(root).flatMap((r) => r.polygon ?? [])
  if (pts.length === 0) throw new Error('No regions or bounds in config/campus.json — run `npm run bbox`')
  const lats = pts.map((p) => p[1])
  const lons = pts.map((p) => p[0])
  return [Math.min(...lats) - margin, Math.min(...lons) - margin, Math.max(...lats) + margin, Math.max(...lons) + margin]
}
