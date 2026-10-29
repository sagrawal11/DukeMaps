// Clickable building icons on the map. Each committed icon (config/building-icons.json) that has a
// coordinate becomes a small marker; clicking it picks that building as your From (then To) — a visual,
// discoverable alternative to the search box. Icons without a confident coordinate are skipped (per the
// brief we don't invent Duke locations — they wait for a verified lat/lon in the config).
//
// Two bits of housekeeping keep ~90 markers legible: a ZOOM GATE (hidden on the campus-wide view so it
// isn't a wall of icons) and a greedy COLLISION pass on move-end (drop any icon that would overlap one
// already kept). ponytail: DOM markers + greedy declutter; a MapLibre symbol layer with built-in
// collision is the upgrade path if this ever janks.
import * as maplibregl from 'maplibre-gl'

export interface BuildingIcon {
  id: string
  name: string
  file: string // e.g. "icons/7701-duke-chapel.svg" (served from public/)
  area: string
  lat: number | null
  lon: number | null
  place: string | null
  confidence: string
  suggestion: unknown
}

export interface IconLayer {
  dispose(): void
}

export function createBuildingIcons(
  map: maplibregl.Map,
  icons: BuildingIcon[],
  onPick: (name: string, lonLat: [number, number]) => void,
  opts: { minZoom?: number; collidePx?: number } = {},
): IconLayer {
  const minZoom = opts.minZoom ?? 15
  const collidePx = opts.collidePx ?? 30

  // Only placed icons; the rest await a verified coordinate.
  const placed = icons.filter((i) => typeof i.lat === 'number' && typeof i.lon === 'number')
  const markers = placed.map((ic) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'bicon'
    el.title = ic.name
    el.setAttribute('aria-label', `Route from or to ${ic.name}`)
    const img = document.createElement('img')
    img.src = new URL(ic.file, document.baseURI).href // same base-relative scheme as graph.json et al.
    img.alt = ''
    img.loading = 'lazy'
    img.draggable = false
    el.appendChild(img)
    el.addEventListener('click', (e) => {
      e.stopPropagation() // a marker click is its own thing, not a map tap
      onPick(ic.name, [ic.lon as number, ic.lat as number])
    })
    return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([ic.lon as number, ic.lat as number]).addTo(map)
  })

  // Hide zoomed-out, and drop overlaps so the visible set stays readable. Runs on move-end (cheap) and once.
  const declutter = (): void => {
    const show = map.getZoom() >= minZoom
    const w = map.getCanvas().clientWidth
    const h = map.getCanvas().clientHeight
    const kept: { x: number; y: number }[] = []
    for (const m of markers) {
      let visible = show
      if (visible) {
        const p = map.project(m.getLngLat())
        visible = p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h // on-screen only
        if (visible) {
          for (const k of kept) {
            if (Math.abs(k.x - p.x) < collidePx && Math.abs(k.y - p.y) < collidePx) {
              visible = false
              break
            }
          }
          if (visible) kept.push({ x: p.x, y: p.y })
        }
      }
      m.getElement().classList.toggle('bicon-hidden', !visible)
    }
  }
  map.on('moveend', declutter)
  declutter()

  return {
    dispose() {
      map.off('moveend', declutter)
      for (const m of markers) m.remove()
    },
  }
}
