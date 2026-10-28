// Dev-only campus-area picker. Freeform: pick an area, then press-and-hold and drag on the
// map to trace it. The in-progress outline is drawn on a 2D canvas overlaid on the map (via
// native mouse events), so you see the boundary under your cursor immediately — this doesn't
// depend on MapLibre's render/event pipeline. On release, the finished polygon is stored and
// rendered as a MapLibre layer. Produces config/campus.json ([lon,lat] ring per area).
//
// Panel is built before the map so it still works if the map can't initialize (no WebGL).
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'

type Area = 'west' | 'east' | 'athletic' | 'hospital'
type Ring = [number, number][] // [lon, lat]

const AREAS: Area[] = ['west', 'east', 'athletic', 'hospital']
const LABELS: Record<Area, string> = { west: 'West Campus', east: 'East Campus', athletic: 'Athletic Campus', hospital: 'Hospital Campus' }
const COLORS: Record<Area, string> = { west: '#e6194b', east: '#4363d8', athletic: '#3cb44b', hospital: '#f58231' }

const polys: Record<Area, Ring> = { west: [], east: [], athletic: [], hospital: [] }
const round = (x: number) => Math.round(x * 1e6) / 1e6

function allPoints(): Ring {
  return AREAS.flatMap((a) => polys[a])
}

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
    }
  }
  return { type: 'FeatureCollection', features }
}

// ---- State ----
let map: maplibregl.Map | null = null
let overlay: HTMLCanvasElement | null = null
let activeArea: Area | null = null
let drawing = false
let screenPath: [number, number][] = [] // container-pixel points while tracing

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

// ---- Live-draw canvas overlay (the thing you see while tracing) ----
function sizeOverlay() {
  if (!overlay || !map) return
  const el = map.getCanvasContainer()
  overlay.width = el.clientWidth
  overlay.height = el.clientHeight
}

function clearCanvas() {
  if (overlay) overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
}

function drawCanvas() {
  if (!overlay || !activeArea) return
  const ctx = overlay.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, overlay.width, overlay.height)
  if (screenPath.length === 0) return
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = COLORS[activeArea]
  ctx.fillStyle = COLORS[activeArea] + '33'
  ctx.beginPath()
  ctx.moveTo(screenPath[0][0], screenPath[0][1])
  for (let i = 1; i < screenPath.length; i++) ctx.lineTo(screenPath[i][0], screenPath[i][1])
  if (screenPath.length >= 3) {
    ctx.closePath()
    ctx.fill()
  }
  ctx.stroke()
}

function containerXY(ev: MouseEvent): [number, number] {
  const r = map!.getCanvasContainer().getBoundingClientRect()
  return [ev.clientX - r.left, ev.clientY - r.top]
}

function onDown(ev: MouseEvent) {
  if (!activeArea || !map) return
  ev.preventDefault()
  drawing = true
  screenPath = [containerXY(ev)]
  drawCanvas()
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function onMove(ev: MouseEvent) {
  if (!drawing) return
  screenPath.push(containerXY(ev))
  drawCanvas()
}

function onUp() {
  if (!drawing || !activeArea || !map) return
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  drawing = false
  const done = activeArea
  activeArea = null
  map.dragPan.enable()
  map.getCanvasContainer().style.cursor = ''
  if (screenPath.length >= 3) {
    polys[done] = screenPath.map((p) => {
      const ll = map!.unproject(p)
      return [ll.lng, ll.lat] as [number, number]
    })
    setStatus(`${LABELS[done]} traced (${polys[done].length} pts). Draw again to redo, or Clear.`)
  } else {
    setStatus(`${LABELS[done]}: shape too small — press, hold, and drag to trace a larger area.`)
  }
  screenPath = []
  clearCanvas()
  redrawMap()
  refresh()
  setActiveButton(null)
}

function startDraw(area: Area) {
  if (!map) {
    setStatus('Map unavailable (needs WebGL).')
    return
  }
  activeArea = area
  map.dragPan.disable()
  map.getCanvasContainer().style.cursor = 'crosshair'
  setActiveButton(area)
  setStatus(`Now press, hold, and drag on the map to trace ${LABELS[area]}. Release to finish.`)
}

function clearArea(area: Area) {
  polys[area] = []
  redrawMap()
  refresh()
  setStatus(`Cleared ${LABELS[area]}.`)
}

// ---- Panel (built first so it renders even without a map) ----
const panel = document.getElementById('panel')!
panel.innerHTML = `
  <h2>Campus area picker</h2>
  <p style="color:#555;margin-top:0">Click <b>Draw</b>, then <b>press-hold-drag</b> on the map to trace the campus. The colored outline follows your cursor; release to close it.</p>
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

// ---- Map ----
try {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [-78.933, 36.004],
    zoom: 13.5,
  })

  map.on('load', () => {
    map!.addSource('polys', { type: 'geojson', data: featureCollection() })
    map!.addLayer({ id: 'poly-fill', type: 'fill', source: 'polys', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 } })
    map!.addLayer({ id: 'poly-line', type: 'line', source: 'polys', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 } })

    overlay = document.createElement('canvas')
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
    map!.getCanvasContainer().appendChild(overlay)
    sizeOverlay()
    map!.getCanvasContainer().addEventListener('mousedown', onDown)
  })

  map.on('resize', sizeOverlay)
} catch (err) {
  setStatus('Map could not load (WebGL required).')
  console.error('[bbox] map init failed:', err)
}

function setActiveButton(area: Area | null) {
  panel.querySelectorAll<HTMLButtonElement>('[data-draw]').forEach((b) => {
    const on = b.dataset.draw === area
    b.textContent = on ? 'Drawing…' : 'Draw'
    b.style.fontWeight = on ? '700' : ''
  })
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
