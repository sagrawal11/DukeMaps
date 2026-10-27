// Dev-only bounding-box picker. Draw/refine the West/Central/East campus boxes on a real
// map, then copy the resulting config/campus.json. Uses keyless OSM raster tiles (the real
// Protomaps basemap needs a bbox to extract, which is exactly what this tool produces).
//
// The panel is built before the map so the number inputs + copy still work if the map can't
// initialize (e.g. a browser/headless environment without WebGL).
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'

type Area = 'west' | 'central' | 'east'
type BBox = [number, number, number, number] // [south, west, north, east]

const AREAS: Area[] = ['west', 'central', 'east']
const COLORS: Record<Area, string> = { west: '#e6194b', central: '#3cb44b', east: '#4363d8' }

// Draft seeds — approximate; the user refines these. [south, west, north, east].
const boxes: Record<Area, BBox> = {
  west: [35.9955, -78.946, 36.004, -78.935],
  central: [36.0, -78.935, 36.008, -78.919],
  east: [36.003, -78.919, 36.012, -78.907],
}

const round = (x: number) => Math.round(x * 1e6) / 1e6

function bboxPolygon([s, w, n, e]: BBox, props: Record<string, unknown>): Feature {
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  }
}

function rectFrom(a: maplibregl.LngLat, b: maplibregl.LngLat): BBox {
  return [Math.min(a.lat, b.lat), Math.min(a.lng, b.lng), Math.max(a.lat, b.lat), Math.max(a.lng, b.lng)]
}

function unionBox(margin = 0.001): BBox {
  const all = AREAS.map((a) => boxes[a])
  return [
    Math.min(...all.map((b) => b[0])) - margin,
    Math.min(...all.map((b) => b[1])) - margin,
    Math.max(...all.map((b) => b[2])) + margin,
    Math.max(...all.map((b) => b[3])) + margin,
  ]
}

function campusJson(): string {
  const line = (a: Area) => `    "${a}": { "bbox": [${boxes[a].map(round).join(', ')}] }`
  return `{
  "_comment": "Bounding boxes for each Duke campus area. bbox order is [south, west, north, east] in decimal degrees (lat, lon). Generated with the bbox picker (npm run bbox).",
  "areas": {
${AREAS.map(line).join(',\n')}
  }
}
`
}

function featureCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: AREAS.map((a) => bboxPolygon(boxes[a], { area: a, color: COLORS[a] })) }
}

// ---- State + map-dependent helpers (guarded so they're safe before/without a map) ----
let map: maplibregl.Map | null = null
let activeArea: Area | null = null
let drawStart: maplibregl.LngLat | null = null

function redrawMap() {
  const src = map?.getSource('boxes') as maplibregl.GeoJSONSource | undefined
  src?.setData(featureCollection())
}

function fitUnion() {
  if (!map) return
  const [s, w, n, e] = unionBox(0.002)
  map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 })
}

function startDraw(area: Area) {
  if (!map) {
    setStatus('Map unavailable — type coordinates directly instead.')
    return
  }
  activeArea = area
  map.dragPan.disable()
  map.getCanvas().style.cursor = 'crosshair'
  setStatus(`Drag on the map to set the ${area} box…`)
}

// ---- Panel (built first so it renders even if the map fails) ----
const panel = document.getElementById('panel')!
panel.innerHTML = `
  <h2>Bounding box picker</h2>
  <p style="color:#555;margin-top:0">Click <b>Draw</b> then drag on the map, or edit numbers directly. Order: S, W, N, E.</p>
  <div id="areas"></div>
  <h3>Basemap union (+margin)</h3>
  <code id="union" style="display:block;background:#f4f4f4;padding:6px;border-radius:4px;word-break:break-all"></code>
  <h3>config/campus.json</h3>
  <textarea id="json" readonly style="width:100%;height:150px;font:12px/1.3 monospace;box-sizing:border-box"></textarea>
  <button id="copy" style="margin-top:6px;width:100%;padding:8px;cursor:pointer">Copy campus.json</button>
  <button id="fit" style="margin-top:6px;width:100%;padding:6px;cursor:pointer">Fit to boxes</button>
  <p id="status" style="color:#1a7f37;min-height:1.3em"></p>
`

const areasDiv = document.getElementById('areas')!
for (const a of AREAS) {
  const row = document.createElement('div')
  row.style.cssText = `margin-bottom:10px;padding:6px 8px;border-left:4px solid ${COLORS[a]};background:#fafafa`
  row.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b style="text-transform:capitalize">${a}</b>
      <button data-draw="${a}" style="cursor:pointer;padding:2px 10px">Draw</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px">
      ${['S', 'W', 'N', 'E']
        .map((lbl, i) => `<label style="font-size:11px;color:#555">${lbl}<input data-in="${a}" data-idx="${i}" type="number" step="0.0001"></label>`)
        .join('')}
    </div>
  `
  areasDiv.appendChild(row)
}

panel.querySelectorAll<HTMLButtonElement>('[data-draw]').forEach((btn) => {
  btn.onclick = () => startDraw(btn.dataset.draw as Area)
})
panel.querySelectorAll<HTMLInputElement>('[data-in]').forEach((inp) => {
  inp.onchange = () => {
    const a = inp.dataset.in as Area
    const idx = Number(inp.dataset.idx)
    const v = parseFloat(inp.value)
    if (!Number.isNaN(v)) {
      boxes[a][idx] = v
      redrawMap()
      refresh()
    }
  }
})
document.getElementById('copy')!.onclick = () => {
  void navigator.clipboard.writeText(campusJson()).then(() => setStatus('campus.json copied to clipboard.'))
}
document.getElementById('fit')!.onclick = () => fitUnion()

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
    center: [-78.927, 36.004],
    zoom: 13,
  })

  map.on('load', () => {
    map!.addSource('boxes', { type: 'geojson', data: featureCollection() })
    map!.addLayer({ id: 'box-fill', type: 'fill', source: 'boxes', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } })
    map!.addLayer({ id: 'box-line', type: 'line', source: 'boxes', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } })
    fitUnion()
  })

  map.on('mousedown', (e: maplibregl.MapMouseEvent) => {
    if (activeArea) drawStart = e.lngLat
  })
  map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
    if (!activeArea || !drawStart) return
    boxes[activeArea] = rectFrom(drawStart, e.lngLat)
    redrawMap()
  })
  map.on('mouseup', (e: maplibregl.MapMouseEvent) => {
    if (!activeArea || !drawStart) return
    boxes[activeArea] = rectFrom(drawStart, e.lngLat)
    const done = activeArea
    drawStart = null
    activeArea = null
    map!.dragPan.enable()
    map!.getCanvas().style.cursor = ''
    setStatus(`${done} box set — edit numbers to fine-tune, or Draw again.`)
    refresh()
  })
} catch (err) {
  setStatus('Map could not load (WebGL required). You can still type coordinates and copy campus.json.')
  console.error('[bbox] map init failed:', err)
}

function refresh() {
  for (const a of AREAS) {
    boxes[a].forEach((v, i) => {
      const inp = panel.querySelector<HTMLInputElement>(`[data-in="${a}"][data-idx="${i}"]`)
      if (inp && document.activeElement !== inp) inp.value = String(round(v))
    })
  }
  document.getElementById('union')!.textContent = '[' + unionBox().map(round).join(', ') + ']'
  ;(document.getElementById('json') as HTMLTextAreaElement).value = campusJson()
}

function setStatus(msg: string) {
  document.getElementById('status')!.textContent = msg
}
