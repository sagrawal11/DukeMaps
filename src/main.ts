// DukeMaps app — Phase 1 view: the Protomaps basemap with the walk graph drawn on top,
// colored by connected component so islands are visible. The richer "show" (algorithm
// animations, routing) arrives in Phase 6; this proves the basemap + graph render.
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import themeLayers from 'protomaps-themes-base'
import type { Graph } from './graph/types'
import { graphToGeoJSON } from './map/render'
import rawGraph from '../data/processed/graph.json'

const graph = rawGraph as unknown as Graph

// Register pmtiles:// so MapLibre reads our static basemap extract (no tile server/key).
maplibregl.addProtocol('pmtiles', new Protocol().tile)
const basemapUrl = `pmtiles://${new URL('basemap/duke.pmtiles', document.baseURI).href}`

const map = new maplibregl.Map({
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
  center: graphCenter(graph) ?? [-78.927, 36.004],
  zoom: 14,
})
map.addControl(new maplibregl.NavigationControl(), 'top-left')

map.on('load', () => {
  if (graph.edges.length === 0) return // placeholder graph until the pipeline has run
  map.addSource('graph', { type: 'geojson', data: graphToGeoJSON(graph) })
  map.addLayer({
    id: 'graph-edges',
    type: 'line',
    source: 'graph',
    paint: {
      'line-color': ['get', 'color'],
      // Islands (not the mainland) drawn thicker so they stand out.
      'line-width': ['case', ['get', 'isMain'], 1.6, 3],
      'line-opacity': 0.9,
    },
  })
  fitToGraph(graph)
})

function graphCenter(g: Graph): [number, number] | null {
  if (g.nodes.length === 0) return null
  const lat = g.nodes.reduce((s, n) => s + n.lat, 0) / g.nodes.length
  const lon = g.nodes.reduce((s, n) => s + n.lon, 0) / g.nodes.length
  return [lon, lat]
}

function fitToGraph(g: Graph): void {
  let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180
  for (const n of g.nodes) {
    minLat = Math.min(minLat, n.lat)
    maxLat = Math.max(maxLat, n.lat)
    minLon = Math.min(minLon, n.lon)
    maxLon = Math.max(maxLon, n.lon)
  }
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 30, duration: 0 })
}

// Small legend / status.
const legend = document.createElement('div')
legend.className = 'legend'
legend.innerHTML =
  graph.edges.length === 0
    ? `<b>DukeMaps</b><div style="color:#666">No graph yet — run <code>npm run fetch</code> then <code>npm run build:graph</code>.</div>`
    : `<b>DukeMaps — walk graph</b><div>${graph.edges.length.toLocaleString()} edges · ${graph.nodes.length.toLocaleString()} nodes</div><div style="color:#666">colored by connected component</div>`
document.body.appendChild(legend)
