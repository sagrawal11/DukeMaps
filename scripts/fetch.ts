// Phase 1: pull walkable ways + named buildings from the OSM Overpass API for the bounding
// boxes in config/campus.json, saving the raw timestamped response to data/raw/.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOverpassQuery } from '../src/osm/overpass'
import { loadAreas } from './campus'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const TIMEOUT_MS = 180_000

async function overpass(query: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': 'DukeMaps/0.1 (portfolio project; https://github.com/sagrawal11/DukeMaps)',
      },
      body: query,
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  const areas = loadAreas(ROOT)
  if (areas.length === 0) {
    console.error('[fetch] No bounding boxes set in config/campus.json. Run `npm run bbox` to pick them.')
    process.exit(1)
  }
  const query = buildOverpassQuery(areas)
  console.log(`[fetch] Querying Overpass for: ${areas.map((a) => a.area).join(', ')}`)

  let body: string | undefined
  for (let attempt = 1; attempt <= 2 && body === undefined; attempt++) {
    try {
      body = await overpass(query)
    } catch (err) {
      console.warn(`[fetch] attempt ${attempt}/2 failed: ${(err as Error).message}`)
      if (attempt === 2) throw err
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  const parsed = JSON.parse(body!) as { elements: unknown[] }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = resolve(ROOT, 'data/raw')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, `osm-${stamp}.json`), body!)
  console.log(`[fetch] Saved ${parsed.elements.length} elements -> data/raw/osm-${stamp}.json`)
}

main().catch((err) => {
  console.error('[fetch] failed:', err)
  process.exit(1)
})
