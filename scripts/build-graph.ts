// Phase 1: build the routable graph from the newest raw OSM response, replay my edit log,
// validate connectivity, and write data/processed/{graph.json, places.json, validation.geojson}.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from '../src/graph/build'
import { applyEdits, type EditOp, type Dangling } from '../src/graph/edits'
import { connectedComponents, danglingStubs, keepLargestComponent, toValidationGeoJSON } from '../src/graph/validate'
import type { OsmResponse } from '../src/osm/overpass'
import type { Graph } from '../src/graph/types'
import { loadAreas } from './campus'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function newestRaw(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('osm-') && f.endsWith('.json'))
    .sort() // ISO timestamps sort lexically = chronologically
  return files.length ? resolve(dir, files[files.length - 1]) : null
}

function main(): void {
  const raw = newestRaw(resolve(ROOT, 'data/raw'))
  if (!raw) {
    console.error('[build:graph] No data/raw/osm-*.json found. Run `npm run fetch` first.')
    process.exit(1)
  }
  const osm = JSON.parse(readFileSync(raw, 'utf8')) as OsmResponse
  const areas = loadAreas(ROOT)
  const built = buildGraph(osm, areas)

  // Merge my replayable edit log (absent until the Phase 2 editor writes it).
  let graph: Graph = built.graph
  let dangling: Dangling[] = []
  const editsPath = resolve(ROOT, 'data/my_edits.json')
  if (existsSync(editsPath)) {
    const ops = JSON.parse(readFileSync(editsPath, 'utf8')) as EditOp[]
    const r = applyEdits(graph, ops)
    graph = r.graph
    dangling = r.dangling
    console.log(`[build:graph] replayed ${ops.length} edit(s)`)
  }

  // Drop disconnected islands (mostly off-campus Durham fragments) — keep the largest connected
  // component. After edits, so a reconnecting edit saves a real path from being pruned.
  const beforePrune = connectedComponents(graph)
  const beforeNodeCount = graph.nodes.length
  graph = keepLargestComponent(graph)
  const droppedNodes = beforeNodeCount - graph.nodes.length

  graph.meta.builtAt = new Date().toISOString()
  graph.meta.osmFetchedAt = statSync(raw).mtime.toISOString()

  const outDir = resolve(ROOT, 'data/processed')
  mkdirSync(outDir, { recursive: true })
  const publicDataDir = resolve(ROOT, 'public/data')
  mkdirSync(publicDataDir, { recursive: true })
  // graph.json is fetched by the app at runtime, so it lives under public/ (served + shipped).
  writeFileSync(resolve(publicDataDir, 'graph.json'), JSON.stringify(graph))
  // The dev-only editor edits against the pre-edit, pre-prune OSM build (this "base"), then
  // replays the edit log itself — mirroring this script — so what it shows equals what build:graph
  // produces. `built.graph` is still pristine here (applyEdits/keepLargestComponent return new
  // graphs). Kept in data/processed (committed, NOT public/, so it isn't shipped); served to the
  // editor via the dev plugin's /__base route.
  built.graph.meta.osmFetchedAt = graph.meta.osmFetchedAt
  writeFileSync(resolve(outDir, 'graph.base.json'), JSON.stringify(built.graph))
  writeFileSync(resolve(outDir, 'places.json'), JSON.stringify(built.places, null, 2))
  // Ship places to the app too — fetched at runtime like graph.json (Phase 4 place index).
  writeFileSync(resolve(publicDataDir, 'places.json'), JSON.stringify(built.places))
  writeFileSync(resolve(outDir, 'validation.geojson'), JSON.stringify(toValidationGeoJSON(graph)))

  const stubs = danglingStubs(graph)
  console.log('[build:graph] ──── report ────')
  console.log(`  nodes: ${graph.nodes.length}   edges: ${graph.edges.length}   places: ${built.places.length}`)
  console.log(`  pruned ${beforePrune.count - 1} island component(s) (${droppedNodes} nodes); graph is now 1 connected network`)
  console.log(`  dangling stubs (degree-1): ${stubs.length}`)
  if (dangling.length) {
    console.log(`  ⚠ ${dangling.length} dangling edit ref(s):`)
    for (const d of dangling) console.log(`    - ${d.reason}`)
  }
  console.log('[build:graph] wrote public/data/{graph.json, places.json} + data/processed/{graph.base.json, places.json, validation.geojson}')
}

main()
