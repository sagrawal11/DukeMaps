// Shared loader for config/campus.json. Node-only (reads fs), so it lives under scripts/
// rather than src/ (which the browser app bundles). Areas whose bbox isn't filled in are
// skipped with a warning rather than failing the whole run.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AreaBBox } from '../src/osm/overpass'
import type { Area } from '../src/graph/types'

export function loadAreas(root: string): AreaBBox[] {
  const cfg = JSON.parse(readFileSync(resolve(root, 'config/campus.json'), 'utf8')) as {
    areas: Record<string, { bbox: (number | null)[] }>
  }
  const areas: AreaBBox[] = []
  for (const [name, entry] of Object.entries(cfg.areas ?? {})) {
    const bbox = entry?.bbox ?? []
    if (bbox.length === 4 && bbox.every((v): v is number => typeof v === 'number')) {
      areas.push({ area: name as Area, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] })
    } else {
      console.warn(`[campus] skipping "${name}" — bbox not filled in (run \`npm run bbox\`)`)
    }
  }
  return areas
}
