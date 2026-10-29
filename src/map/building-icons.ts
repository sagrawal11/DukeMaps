// Clickable building icons on the map. Each committed icon (config/building-icons.json) that has a
// coordinate becomes a white circular badge floating over its building, with the building's nickname
// below it; click one to pick it as your From (then To) — a visual, discoverable alternative to search.
// Icons without a confident coordinate are skipped (per the brief we don't invent Duke locations).
//
// IMPORTANCE-TIERED REVEAL: every icon has a tier (1 = landmark … 3 = minor). Tier 1 shows at the
// campus-wide view, tier 2 and 3 fade in as you zoom to building level — so the overview stays legible
// and detail appears on demand. A greedy collision pass (higher tier wins) drops any badge that would
// overlap one already kept. ponytail: DOM markers + greedy declutter; a MapLibre symbol layer with
// built-in collision is the upgrade path if ~100 markers ever jank.
import * as maplibregl from 'maplibre-gl'

export interface BuildingIcon {
  id: string
  name: string
  file: string // e.g. "icons/7701-duke-chapel.svg" (served from public/)
  area: string
  nickname?: string
  tier?: number // 1 landmark … 3 minor (default 3)
  doors?: [number, number][] // [lon,lat] entrances for door-accurate routing
  lat: number | null
  lon: number | null
  place: string | null
  confidence: string
  suggestion: unknown
}

export interface IconLayer {
  dispose(): void
}

// Zoom at which each tier starts showing. The app frames the whole campus around ~13.5, so tier 1 is
// visible from the start; tiers 2–3 reveal as you zoom in. Tunable.
const TIER_MINZOOM: Record<number, number> = { 1: 12, 2: 15, 3: 16.5 }

export function createBuildingIcons(
  map: maplibregl.Map,
  icons: BuildingIcon[],
  onPick: (name: string, lonLat: [number, number], doors?: [number, number][]) => void,
  opts: { collidePx?: number } = {},
): IconLayer {
  const collidePx = opts.collidePx ?? 46 // badge + label footprint

  const placed = icons.filter((i) => typeof i.lat === 'number' && typeof i.lon === 'number')
  const entries = placed.map((ic) => {
    const tier = ic.tier ?? 3
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `bicon bicon-t${tier}`
    el.title = ic.name
    el.setAttribute('aria-label', `Route from or to ${ic.name}`)

    const circle = document.createElement('span')
    circle.className = 'bicon-circle'
    const img = document.createElement('img')
    img.src = new URL(ic.file, document.baseURI).href // same base-relative scheme as graph.json et al.
    img.alt = ''
    img.loading = 'lazy'
    img.draggable = false
    circle.appendChild(img)
    el.appendChild(circle)

    if (ic.nickname) {
      const label = document.createElement('span')
      label.className = 'bicon-label'
      label.textContent = ic.nickname
      el.appendChild(label)
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation() // a marker click is its own thing, not a map tap
      onPick(ic.name, [ic.lon as number, ic.lat as number], ic.doors)
    })
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([ic.lon as number, ic.lat as number]).addTo(map)
    return { marker, tier }
  })
  // Higher priority first so collision keeps the more important badge when two overlap.
  entries.sort((a, b) => a.tier - b.tier)

  const declutter = (): void => {
    const z = map.getZoom()
    const w = map.getCanvas().clientWidth
    const h = map.getCanvas().clientHeight
    const kept: { x: number; y: number }[] = []
    for (const e of entries) {
      let visible = z >= (TIER_MINZOOM[e.tier] ?? 16)
      if (visible) {
        const p = map.project(e.marker.getLngLat())
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
      e.marker.getElement().classList.toggle('bicon-hidden', !visible)
    }
  }
  map.on('moveend', declutter)
  declutter()

  return {
    dispose() {
      map.off('moveend', declutter)
      for (const e of entries) e.marker.remove()
    },
  }
}
