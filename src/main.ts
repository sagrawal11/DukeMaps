// DukeMaps app — Phase 4: search two campus places with fuzzy autocomplete, or tap anywhere to
// drop a pin; each endpoint snaps to the nearest point on the walk network. Routing and the
// algorithm "show" arrive in Phases 5–6. The graph is drawn muted underneath so you can watch each
// pin land on a path. Data (graph + places) is fetched at runtime, not bundled, so the map paints
// immediately and a visible status covers the loading/error states.
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import themeLayers from 'protomaps-themes-base'
import type { Graph, Place } from './graph/types'
import { graphToGeoJSON } from './map/render'
import { buildPlaceIndex, type PlaceIndex } from './places/search'
import { buildEdgeIndex, type EdgeIndex } from './spatial/snap'
import aliasesConfig from '../config/aliases.json'

const statusEl = document.createElement('div')
statusEl.className = 'legend'
statusEl.textContent = 'Loading map…'
document.body.appendChild(statusEl)
const setStatus = (html: string): void => {
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

async function loadJSON<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(new URL(path, document.baseURI).href)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    console.error(`[dukemaps] failed to load ${path}:`, err)
    return null
  }
}

// The walk network, drawn muted so the search pins and their snapped positions read clearly on top.
function addGraphLayer(m: maplibregl.Map, graph: Graph): void {
  if (graph.edges.length === 0) return
  m.addSource('graph', { type: 'geojson', data: graphToGeoJSON(graph) })
  m.addLayer({
    id: 'graph-edges',
    type: 'line',
    source: 'graph',
    paint: { 'line-color': '#9aa5b1', 'line-width': 1.1, 'line-opacity': 0.75 },
  })
  const bounds = new maplibregl.LngLatBounds()
  for (const n of graph.nodes) bounds.extend([n.lon, n.lat])
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 40, duration: 0 })
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

type Which = 'from' | 'to'
interface Endpoint {
  label: string
  point: [number, number]
  distM: number
}

// Pick From and To by searching a building (fuzzy autocomplete) or tapping the map. Each endpoint
// snaps to the nearest point on the walk network via the Phase-4 edge index.
function setupUI(map: maplibregl.Map, placeIndex: PlaceIndex, edgeIndex: EdgeIndex): void {
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML =
    '<div class="brand">DukeMaps</div>' +
    '<div class="field"><input id="from" placeholder="From — search or tap the map" autocomplete="off" /><div class="ac" id="ac-from"></div></div>' +
    '<div class="field"><input id="to" placeholder="To — search or tap the map" autocomplete="off" /><div class="ac" id="ac-to"></div></div>' +
    '<div class="info" id="info"></div>'
  document.body.appendChild(panel)

  const input = (w: Which): HTMLInputElement => panel.querySelector(`#${w}`) as HTMLInputElement
  const infoEl = panel.querySelector('#info') as HTMLDivElement
  const colors: Record<Which, string> = { from: '#2e9e5b', to: '#d64545' }
  const markers: Record<Which, maplibregl.Marker | null> = { from: null, to: null }
  const chosen: Record<Which, Endpoint | null> = { from: null, to: null }

  const renderInfo = (): void => {
    const line = (w: Which, name: string): string =>
      chosen[w]
        ? `<b>${name}:</b> ${esc(chosen[w]!.label)} <span class="dim">· snapped ${Math.round(chosen[w]!.distM)} m</span>`
        : `<b>${name}:</b> <span class="dim">—</span>`
    const both = chosen.from && chosen.to
    infoEl.innerHTML =
      `${line('from', 'From')}<br>${line('to', 'To')}` +
      (both ? '<br><span class="ready">Both pinned — routing + the algorithm race arrive in Phase 5–6.</span>' : '')
  }

  const setEndpoint = (w: Which, lonLat: [number, number], label: string): void => {
    const snap = edgeIndex.snap(lonLat[0], lonLat[1])
    if (!snap) return
    chosen[w] = { label, point: snap.point, distM: snap.distM }
    const m = markers[w] ?? new maplibregl.Marker({ color: colors[w] })
    markers[w] = m.setLngLat(snap.point).addTo(map)
    renderInfo()
  }

  const clearEndpoint = (w: Which): void => {
    markers[w]?.remove()
    markers[w] = null
    chosen[w] = null
    input(w).value = ''
  }

  const wireField = (w: Which): void => {
    const el = input(w)
    const ac = panel.querySelector(`#ac-${w}`) as HTMLDivElement
    const close = (): void => {
      ac.innerHTML = ''
      ac.style.display = 'none'
    }
    const pick = (p: Place): void => {
      el.value = p.name
      close()
      setEndpoint(w, [p.lon, p.lat], p.name)
    }
    el.addEventListener('input', () => {
      close()
      const hits = placeIndex.search(el.value, 8)
      if (!hits.length) return
      for (const p of hits) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'hit'
        b.textContent = p.name
        b.addEventListener('mousedown', (ev) => {
          ev.preventDefault() // keep focus and fire before blur so the pick registers
          pick(p)
        })
        ac.appendChild(b)
      }
      ac.style.display = 'block'
    })
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const hit = placeIndex.search(el.value, 1)[0]
        if (hit) pick(hit)
      } else if (ev.key === 'Escape') {
        close()
      }
    })
    el.addEventListener('blur', () => setTimeout(close, 120)) // let a click on a hit land first
  }
  wireField('from')
  wireField('to')

  // Tap fills From, then To; a tap when both are set starts a fresh pair.
  map.on('click', (e) => {
    const lonLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
    if (chosen.from && chosen.to) {
      clearEndpoint('from')
      clearEndpoint('to')
    }
    const w: Which = chosen.from ? 'to' : 'from'
    input(w).value = 'Dropped pin'
    setEndpoint(w, lonLat, 'Dropped pin')
  })
  map.getCanvas().style.cursor = 'crosshair'

  renderInfo()
  statusEl.remove() // hand the screen over to the panel
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

map.addControl(new maplibregl.NavigationControl(), 'top-right')
map.on('error', (e) => console.error('[dukemaps] map error:', e.error?.message ?? 'unknown'))

map.on('load', () => {
  setStatus('Loading graph…')
  void Promise.all([loadJSON<Graph>('data/graph.json'), loadJSON<Place[]>('data/places.json')]).then(([graph, places]) => {
    if (!graph) {
      setStatus('<b>DukeMaps</b><div style="color:#b00">Could not load the graph. Run <code>npm run build:graph</code>.</div>')
      return
    }
    addGraphLayer(map, graph)
    const aliases = (aliasesConfig as { aliases?: Record<string, string> }).aliases ?? {}
    const placeIndex = buildPlaceIndex(places ?? [], aliases)
    const edgeIndex = buildEdgeIndex(graph)
    setupUI(map, placeIndex, edgeIndex)
  })
})
