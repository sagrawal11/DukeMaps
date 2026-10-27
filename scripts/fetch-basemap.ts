// Extract a Duke-area Protomaps basemap into public/basemap/duke.pmtiles using the `pmtiles`
// CLI (HTTP range requests pull only the campus tiles, not the whole planet). The extract
// covers the union of the campus bounding boxes plus a small margin.
//
// Source defaults to a recent Protomaps daily build; override with PMTILES_SOURCE if that
// date 404s (very recent dates may not be published yet).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAreas } from './campus'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARGIN = 0.002

function unionBBox(): { s: number; w: number; n: number; e: number } {
  const areas = loadAreas(ROOT)
  if (areas.length === 0) {
    console.error('[fetch:basemap] No bounding boxes in config/campus.json. Run `npm run bbox` first.')
    process.exit(1)
  }
  return {
    s: Math.min(...areas.map((a) => a.bbox[0])) - MARGIN,
    w: Math.min(...areas.map((a) => a.bbox[1])) - MARGIN,
    n: Math.max(...areas.map((a) => a.bbox[2])) + MARGIN,
    e: Math.max(...areas.map((a) => a.bbox[3])) + MARGIN,
  }
}

function defaultSource(): string {
  // Protomaps daily planet build; ~7 days back since the newest dates may not be ready.
  const d = new Date(Date.now() - 7 * 86_400_000)
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '')
  return `https://build.protomaps.com/${ymd}.pmtiles`
}

function main(): void {
  const source = process.env.PMTILES_SOURCE || defaultSource()
  const { s, w, n, e } = unionBBox()
  const outDir = resolve(ROOT, 'public/basemap')
  mkdirSync(outDir, { recursive: true })
  const out = resolve(outDir, 'duke.pmtiles')
  const bbox = `${w},${s},${e},${n}` // pmtiles wants minLon,minLat,maxLon,maxLat

  console.log(`[fetch:basemap] source: ${source}`)
  console.log(`[fetch:basemap] bbox:   ${bbox}`)
  console.log('[fetch:basemap] extracting (HTTP range; first run can take a minute)…')
  try {
    execFileSync('pmtiles', ['extract', source, out, `--bbox=${bbox}`, '--maxzoom=16'], { stdio: 'inherit' })
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'pmtiles CLI not found. Install it: `brew install pmtiles`.'
      : `pmtiles extract failed. If the source 404s, try another date via PMTILES_SOURCE. (${(err as Error).message})`
    console.error(`[fetch:basemap] ${msg}`)
    process.exit(1)
  }
  console.log('[fetch:basemap] wrote public/basemap/duke.pmtiles')
}

main()
