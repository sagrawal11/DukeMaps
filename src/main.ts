// DukeMaps app — Phase 1 view: the Protomaps basemap with the walk graph drawn on top,
// colored by connected component so islands are visible. The graph is fetched at runtime
// (not bundled) so the map paints immediately; a visible status shows loading/error state.
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import themeLayers from 'protomaps-themes-base'
import type { Graph } from './graph/types'
import { graphToGeoJSON } from './map/render'

// On-screen status so the app state is always visible (loading / error / loaded).
const statusEl = document.createElement('div')
statusEl.className = 'legend'
statusEl.textContent = 'Loading map…'
document.body.appendChild(statusEl)
const setStatus = (html: string) => {
  statusEl.innerHTML = html
}

function initMap(): maplibregl.Map {
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  const basemapUrl = `pmtiles://${new URL('basemap/duke.pmtiles', document.baseURI).href}`
  return new maplibregl.Map({
    container: 'app',
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

async function loadGraph(): Promise<Graph | null> {
  try {
    const res = await fetch(new URL('data/graph.json', document.baseURI).href)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Graph
  } catch (err) {
    console.error('[dukemaps] failed to load graph:', err)
    return null
  }
}

function addGraphLayer(m: maplibregl.Map, graph: Graph): void {
  if (graph.edges.length === 0) return
  m.addSource('graph', { type: 'geojson', data: graphToGeoJSON(graph) })
  m.addLayer({
    id: 'graph-edges',
    type: 'line',
    source: 'graph',
    paint: {
      'line-color': ['get', 'color'],
      // Islands (non-mainland) drawn thicker so they stand out.
      'line-width': ['case', ['get', 'isMain'], 1.6, 3],
      'line-opacity': 0.9,
    },
  })
  const bounds = new maplibregl.LngLatBounds()
  for (const n of graph.nodes) bounds.extend([n.lon, n.lat])
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 30, duration: 0 })
}

let map: maplibregl.Map
try {
  map = initMap()
} catch (err) {
  setStatus(
    `<b>Map failed to load.</b><div style="color:#b00">${(err as Error).message}</div><div style="color:#666">Usually means this browser lacks WebGL2.</div>`,
  )
  throw err
}

map.addControl(new maplibregl.NavigationControl(), 'top-left')
map.on('error', (e) => console.error('[dukemaps] map error:', e.error?.message ?? 'unknown'))

map.on('load', () => {
  setStatus('Loading graph…')
  void loadGraph().then((graph) => {
    if (!graph) {
      setStatus('<b>DukeMaps</b><div style="color:#b00">Could not load the graph. Run <code>npm run build:graph</code>.</div>')
      return
    }
    addGraphLayer(map, graph)
    setStatus(
      graph.edges.length === 0
        ? '<b>DukeMaps</b><div style="color:#666">No graph yet — run <code>npm run fetch</code> then <code>npm run build:graph</code>.</div>'
        : `<b>DukeMaps — walk graph</b><div>${graph.edges.length.toLocaleString()} edges · ${graph.nodes.length.toLocaleString()} nodes</div><div style="color:#666">colored by connected component</div>`,
    )
  })
})
