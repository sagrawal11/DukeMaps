// DukeMaps graph editor — dev-only page (npm run editor), excluded from the production build.
// CP1: load the pre-edit OSM base graph (/__base) + the replayable edit log (/__edits), render
// the merged graph (applyEdits) over the Protomaps basemap, and show counts. Later checkpoints add
// the editing tools; the edit log stays the single source of truth and autosaves to
// data/my_edits.json via the dev server, which build:graph then replays.
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import themeLayers from 'protomaps-themes-base'
import type { Graph } from '../src/graph/types'
import type { EditOp } from '../src/graph/edits'
import { addGraphLayers } from './layers'
import { EditorState } from './state'
import { Overlay } from './overlay'
import { installTools } from './tools'
import { installGpx } from './gpx'

// Panel is built first so it renders even if the map can't initialize (no WebGL).
const panel = document.getElementById('panel')!
panel.innerHTML = `
  <h2>DukeMaps — graph editor</h2>
  <p style="color:#666;margin-top:0">Dev-only. Edits autosave to <code>data/my_edits.json</code>; <code>npm run build:graph</code> replays them.</p>
  <div id="status" style="min-height:3.5em"></div>
`
const setStatus = (html: string): void => {
  document.getElementById('status')!.innerHTML = html
}

async function loadJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

// base graph (OSM, pre-edit, pre-prune) + edit log; EditorState replays the log to the live graph.
async function loadBaseAndLog(): Promise<{ base: Graph; ops: EditOp[] }> {
  const [base, ops] = await Promise.all([loadJSON<Graph>('/__base'), loadJSON<EditOp[]>('/__edits')])
  return { base, ops }
}

function initMap(): maplibregl.Map {
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  // Absolute path (leading slash): the page is served at /editor/, but public/ assets live at /.
  const basemapUrl = `pmtiles://${new URL('/basemap/duke.pmtiles', document.baseURI).href}`
  return new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
      sources: {
        protomaps: {
          type: 'vector',
          url: basemapUrl,
          attribution:
            '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> (ODbL) · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
        },
      },
      layers: themeLayers('protomaps', 'light', 'en'),
    },
    center: [-78.9294, 36.0008],
    zoom: 14,
  })
}

let map: maplibregl.Map
try {
  map = initMap()
} catch (err) {
  setStatus(
    `<b style="color:#b00">Map failed to load.</b><div>${(err as Error).message}</div><div style="color:#666">This browser likely lacks WebGL2.</div>`,
  )
  throw err
}
map.addControl(new maplibregl.NavigationControl(), 'top-left')
map.on('error', (e) => console.error('[editor] map error:', e.error?.message ?? 'unknown'))

map.on('load', () => {
  setStatus('Loading graph…')
  loadBaseAndLog()
    .then(({ base, ops }) => {
      const state = new EditorState(base, ops)
      addGraphLayers(map, state.graph)
      const overlay = new Overlay(map)
      installTools(map, state, overlay) // builds the toolbar + takes over the status line
      installGpx(map, state) // GPX import panel + preview layer
      const bounds = new maplibregl.LngLatBounds()
      for (const n of state.graph.nodes) bounds.extend([n.lon, n.lat])
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 30, duration: 0 })
    })
    .catch((err: unknown) => {
      setStatus(
        `<b style="color:#b00">Could not load the graph.</b><div>${(err as Error).message}</div>` +
          `<div style="color:#666">Run <code>npm run build:graph</code>, then reload.</div>`,
      )
    })
})
