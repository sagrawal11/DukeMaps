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
import { loadBounds } from './campus'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Find a usable Protomaps daily build: honor PMTILES_SOURCE, else probe recent dates (builds
// are kept only for a short window) and use the newest that exists.
async function findSource(): Promise<string> {
  if (process.env.PMTILES_SOURCE) return process.env.PMTILES_SOURCE
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.now() - i * 86_400_000)
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '')
    const url = `https://build.protomaps.com/${ymd}.pmtiles`
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-0' } })
      if (res.ok || res.status === 206) return url
    } catch {
      // try the next date
    }
  }
  throw new Error('No recent Protomaps build found (tried the last 14 days). Set PMTILES_SOURCE manually.')
}

async function main(): Promise<void> {
  const source = await findSource()
  let bounds: [number, number, number, number]
  try {
    bounds = loadBounds(ROOT)
  } catch {
    console.error('[fetch:basemap] No campus regions/bounds in config/campus.json. Run `npm run bbox` first.')
    process.exit(1)
  }
  const [s, w, n, e] = bounds
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

main().catch((err) => {
  console.error('[fetch:basemap] failed:', err)
  process.exit(1)
})
