// Dev-only campus-area picker. Freeform: hold and drag on the map to trace each campus as a
// polygon (you see the outline as you draw). Produces config/campus.json with a [lon,lat]
// ring per area. Uses keyless OSM raster tiles (the Protomaps basemap is extracted later
// from the bounding box of these polygons).
//
// The panel is built before the map so it still works if the map can't initialize (no WebGL).
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'

type Area = 'west' | 'east' | 'athletic' | 'hospital'
type Ring = [number, number][] // [lon, lat] points

const AREAS: Area[] = ['west', 'east', 'athletic', 'hospital']
const LABELS: Record<Area, string> = { west: 'West Campus', east: 'East Campus', athletic: 'Athletic Campus', hospital: 'Hospital Campus' }
const COLORS: Record<Area, string> = { west: '#e6194b', east: '#4363d8', athletic: '#3cb44b', hospital: '#f58231' }

const polys: Record<Area, Ring> = { west: [], east: [], athletic: [], hospital: [] }

const round = (x: number) => Math.round(x * 1e6) / 1e6

function allPoints(): Ring {
  return AREAS.flatMap((a) => polys[a])
}

// Bounding box [s, w, n, e] of all drawn points (for the basemap extract), with a margin.
function unionBox(margin = 0.002): [number, number, number, number] | null {
  const pts = allPoints()
  if (pts.length === 0) return null
  const lats = pts.map((p) => p[1])
  const lons = pts.map((p) => p[0])
  return [Math.min(...lats) - margin, Math.min(...lons) - margin, Math.max(...lats) + margin, Math.max(...lons) + margin]
}

function campusJson(): string {
  const line = (a: Area) => {
    const ring = polys[a].map(([lon, lat]) => [round(lon), round(lat)])
    return `    "${a}": { "polygon": ${JSON.stringify(ring)} }`
  }
  return `{
  "_comment": "Freeform polygons per Duke campus area; each is a [lon, lat] ring. Generated with the picker (npm run bbox). Used for the OSM fetch (bounding box of each polygon) and to tag which campus a place/edge belongs to (point-in-polygon).",
  "areas": {
${AREAS.map(line).join(',\n')}
  }
}
`
}

function featureCollection(): FeatureCollection {
  const features: Feature[] = []
  for (const a of AREAS) {
    const ring = polys[a]
    if (ring.length >= 3) {
      features.push({ type: 'Feature', properties: { area: a, color: COLORS[a] }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } })
    } else if (ring.length >= 2) {
      features.push({ type: 'Feature', properties: { area: a, color: COLORS[a] }, geometry: { type: 'LineString', coordinates: ring } })
    }
  }
  return { type: 'FeatureCollection', features }
}

// ---- State + map-dependent helpers (guarded so they're safe before/without a map) ----
let map: maplibregl.Map | null = null
let activeArea: Area | null = null
let drawing = false

function redrawMap() {
  const src = map?.getSource('polys') as maplibregl.GeoJSONSource | undefined
  src?.setData(featureCollection())
}

function fitAll() {
  const box = unionBox(0.003)
  if (!map || !box) return
  const [s, w, n, e] = box
  map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 })
}

function startDraw(area: Area) {
  if (!map) {
    setStatus('Map unavailable (needs WebGL).')
    return
  }
  activeArea = area
  map.dragPan.disable()
  map.getCanvas().style.cursor = 'crosshair'
  setStatus(`Hold and drag to trace ${LABELS[area]}. Release to finish.`)
}

function clearArea(area: Area) {
  polys[area] = []
  redrawMap()
  refresh()
  setStatus(`Cleared ${LABELS[area]}.`)
}

// ---- Panel (built first so it renders even if the map fails) ----
const panel = document.getElementById('panel')!
panel.innerHTML = `
  <h2>Campus area picker</h2>
  <p style="color:#555;margin-top:0">Pick an area, then <b>hold and drag</b> on the map to trace it. You'll see the outline as you draw.</p>
  <div id="areas"></div>
  <h3>Basemap bounding box (+margin)</h3>
  <code id="union" style="display:block;background:#f4f4f4;padding:6px;border-radius:4px;word-break:break-all"></code>
  <h3>config/campus.json</h3>
  <textarea id="json" readonly style="width:100%;height:140px;font:12px/1.3 monospace;box-sizing:border-box"></textarea>
  <button id="copy" style="margin-top:6px;width:100%;padding:8px;cursor:pointer">Copy campus.json</button>
  <button id="fit" style="margin-top:6px;width:100%;padding:6px;cursor:pointer">Fit to areas</button>
  <p id="status" style="color:#1a7f37;min-height:1.3em"></p>
`

const areasDiv = document.getElementById('areas')!
for (const a of AREAS) {
  const row = document.createElement('div')
  row.style.cssText = `margin-bottom:8px;padding:6px 8px;border-left:4px solid ${COLORS[a]};background:#fafafa;display:flex;justify-content:space-between;align-items:center;gap:6px`
  row.innerHTML = `
    <span><b>${LABELS[a]}</b> <span data-count="${a}" style="color:#888;font-size:11px"></span></span>
    <span style="white-space:nowrap">
      <button data-draw="${a}" style="cursor:pointer;padding:2px 10px">Draw</button>
      <button data-clear="${a}" style="cursor:pointer;padding:2px 8px">Clear</button>
    </span>
  `
  areasDiv.appendChild(row)
}

panel.querySelectorAll<HTMLButtonElement>('[data-draw]').forEach((b) => (b.onclick = () => startDraw(b.dataset.draw as Area)))
panel.querySelectorAll<HTMLButtonElement>('[data-clear]').forEach((b) => (b.onclick = () => clearArea(b.dataset.clear as Area)))
document.getElementById('copy')!.onclick = () => {
  void navigator.clipboard.writeText(campusJson()).then(() => setStatus('campus.json copied to clipboard.'))
}
document.getElementById('fit')!.onclick = () => fitAll()

refresh()

// ---- Map (needs WebGL; degrade gracefully if it can't start) ----
try {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [-78.933, 36.004],
    zoom: 13.5,
  })

  map.on('load', () => {
    map!.addSource('polys', { type: 'geojson', data: featureCollection() })
    map!.addLayer({ id: 'poly-fill', type: 'fill', source: 'polys', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 } })
    map!.addLayer({ id: 'poly-line', type: 'line', source: 'polys', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 } })
  })

  map.on('mousedown', (e: maplibregl.MapMouseEvent) => {
    if (!activeArea) return
    drawing = true
    polys[activeArea] = [[e.lngLat.lng, e.lngLat.lat]]
    redrawMap()
  })
  map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
    if (!activeArea || !drawing) return
    polys[activeArea].push([e.lngLat.lng, e.lngLat.lat])
    redrawMap()
  })
  map.on('mouseup', () => {
    if (!activeArea || !drawing) return
    const done = activeArea
    drawing = false
    activeArea = null
    map!.dragPan.enable()
    map!.getCanvas().style.cursor = ''
    if (polys[done].length < 3) {
      polys[done] = []
      setStatus(`${LABELS[done]}: shape too small — try tracing a larger area.`)
    } else {
      setStatus(`${LABELS[done]} traced (${polys[done].length} pts). Draw again to redo, or Clear.`)
    }
    redrawMap()
    refresh()
  })
} catch (err) {
  setStatus('Map could not load (WebGL required).')
  console.error('[bbox] map init failed:', err)
}

function refresh() {
  for (const a of AREAS) {
    const el = panel.querySelector<HTMLSpanElement>(`[data-count="${a}"]`)
    if (el) el.textContent = polys[a].length >= 3 ? `(${polys[a].length} pts)` : '(empty)'
  }
  const box = unionBox()
  document.getElementById('union')!.textContent = box ? '[' + box.map(round).join(', ') + ']' : '(draw at least one area)'
  ;(document.getElementById('json') as HTMLTextAreaElement).value = campusJson()
}

function setStatus(msg: string) {
  document.getElementById('status')!.textContent = msg
}
