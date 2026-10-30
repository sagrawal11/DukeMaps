// DukeMaps app — the show. Search two campus places (fuzzy autocomplete) or tap to drop a pin (which
// is labelled with the building you're nearest). With both pinned, the seven hand-written searches
// replay their exploration over the map in turn, then draw their route. Secondary controls live in an
// "Options" disclosure to keep the panel calm: "Leave now" (base metric — Contraction Hierarchies work)
// vs "Leave at" a time (class-change crowding, which re-customizes the CCH live). Data is fetched at
// runtime, not bundled, so the map paints immediately.
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import themeLayers from 'protomaps-themes-base'
import type { Graph, GraphNode, Place } from './graph/types'
import { buildPlaceIndex, type PlaceIndex } from './places/search'
import { buildEdgeIndex, type EdgeIndex } from './spatial/snap'
import { haversineM } from './graph/geo'
import { buildRoutingGraph, makeWeight, type WeightFn } from './algorithms/routing'
import { customize, type CCHStructure } from './algorithms/cch'
import type { CHData } from './algorithms/ch'
import { dijkstra } from './algorithms/dijkstra'
import { crowdingMultiplier, hmsToSec, type Schedule } from './graph/time'
import { createOverlay } from './map/overlay'
import { makePlayer, type Player } from './anim/player'
import { ALGORITHMS, runAlgo, type AlgoDef } from './anim/algos'
import { elimPaths, layoutElimTree, layoutFullTree } from './anim/elimtree'
import { createElimTreeView } from './anim/elimtree-view'
import { createBuildingIcons, type BuildingIcon } from './map/building-icons'
import aliasesConfig from '../config/aliases.json'
import scheduleConfig from '../config/schedule.json'
import buildingIconsConfig from '../config/building-icons.json'

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
            '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> (ODbL) · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · <a href="#" class="dm-devlogin">developer login</a>',
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

// Open framed on the Duke CORE — the placed building icons minus the far "Outlying" ones (Lemur Center,
// golf) — instead of the whole fetched graph, which reached into surrounding Durham and opened too zoomed
// out. Falls back to the graph extent if no icons are placed. The network itself is intentionally NOT
// drawn; the animation draws the live frontier/route on demand.
function fitToCampus(m: maplibregl.Map, icons: BuildingIcon[], graph: Graph): void {
  const bounds = new maplibregl.LngLatBounds()
  for (const i of icons) if (i.lat != null && i.lon != null && i.area !== 'Outlying And Perimeter') bounds.extend([i.lon, i.lat])
  if (bounds.isEmpty()) for (const n of graph.nodes) bounds.extend([n.lon, n.lat])
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 30, duration: 0 })
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

type Which = 'from' | 'to'
interface Endpoint {
  label: string
  point: [number, number]
  distM: number
  node: GraphNode // routing anchor (nearest edge endpoint) — what the algorithms route between
  doors?: [number, number][] // [lon,lat] entrances; if set, routing snaps the door nearest the other endpoint
}

// Pick From and To by searching a building (fuzzy autocomplete) or tapping the map. Each endpoint
// snaps to the nearest point on the walk network via the Phase-4 edge index.
function setupUI(
  map: maplibregl.Map,
  graph: Graph,
  placeIndex: PlaceIndex,
  edgeIndex: EdgeIndex,
  chData: CHData | null,
  cchStructure: CCHStructure | null,
  crowdDist: Record<string, number>,
): void {
  const rg = buildRoutingGraph(graph) // the algorithms' view of the graph, built once
  const schedule = scheduleConfig as unknown as Schedule // class-change crowding model (Phase 3)
  const distToAcademicM = (id: string): number | null => crowdDist[id] ?? null // per-edge crowding input

  const nowHHMM = (): string => {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const metricOpts = {
    leaveAt: localStorage.getItem('dukemaps.leaveAt') || nowHHMM(),
  }
  // "Leave now" (default) = plain base metric, so Contraction Hierarchies stay valid. "Leave at" a time
  // opts into class-change crowding (which re-customizes the CCH live and greys prebuilt CH when peak).
  let leaveNow = localStorage.getItem('dukemaps.leaveNow') == null ? true : localStorage.getItem('dukemaps.leaveNow') === '1'
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const buildWeight = (): WeightFn =>
    leaveNow
      ? makeWeight(rg)
      : makeWeight(rg, {
          time: { departureSecOfDay: hmsToSec(metricOpts.leaveAt), isWeekend: false, schedule, distToAcademicM },
        })
  // A class-change bump is only possible when you've opted into a specific departure time.
  const isPeak = (): boolean => !leaveNow && crowdingMultiplier(0, { secOfDay: hmsToSec(metricOpts.leaveAt), isWeekend: false }, schedule) > 1
  const isBaseMetric = (): boolean => !isPeak()

  let weight = buildWeight() // reassigned whenever the options change
  let cchData: CHData | null = null // populated by applyMetric() below (one customize at startup)
  const overlay = createOverlay(map, graph) // canvas layer the animation draws on
  const elimInset = document.createElement('div')
  elimInset.className = 'elim-inset'
  document.body.appendChild(elimInset)
  const elimView = createElimTreeView(elimInset) // CH/CCH elimination-tree inset (bottom-right of the map)
  let player: Player | null = null

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML =
    '<button type="button" class="sheet-handle" id="sheet-handle" aria-label="Expand or collapse the panel"></button>' +
    '<div class="brandrow"><span class="brand">DukeMaps</span><button type="button" class="about-link" id="about-open">About</button></div>' +
    '<div class="field"><input id="from" placeholder="From — search or tap the map" autocomplete="off" /><button type="button" class="field-x" id="x-from" aria-label="Clear start" hidden>×</button><div class="ac" id="ac-from"></div></div>' +
    '<div class="field"><input id="to" placeholder="To — search or tap the map" autocomplete="off" /><button type="button" class="field-x" id="x-to" aria-label="Clear destination" hidden>×</button><div class="ac" id="ac-to"></div></div>' +
    '<div class="options" id="options">' +
    '<div class="leave-row">' +
    '<div class="seg" role="group" aria-label="Departure">' +
    '<button type="button" class="seg-btn on" id="leave-now">Leave now</button>' +
    '<button type="button" class="seg-btn" id="leave-at">Leave at</button>' +
    '</div>' +
    '<input type="time" id="leaveat" hidden />' +
    '</div>' +
    '<div class="opt-row" id="opt-row" hidden>' +
    '<button type="button" class="opt" id="pickcoords" aria-pressed="false" hidden>📍 Coords</button>' +
    '<button type="button" class="opt" id="doormode" aria-pressed="false" hidden>🚪 Doors</button>' +
    '<button type="button" class="opt" id="doorundo" hidden>↶ Undo door</button>' +
    '<button type="button" class="opt" id="regionmode" aria-pressed="false" hidden>🗺️ Region</button>' +
    '<button type="button" class="opt" id="regionfinish" hidden>✓ Finish</button>' +
    '<button type="button" class="opt" id="regionundo" hidden>↶ Undo</button>' +
    '<button type="button" class="opt" id="editgraph" hidden>✏️ Edit graph</button>' +
    '</div>' +
    '</div>' +
    '<div class="metric" id="metric"></div>' +
    '<div class="info" id="info"></div>' +
    '<div class="show" id="show" hidden>' +
    '<button type="button" class="algos-link" id="algos-link">Look how different search algorithms find this path! →</button>' +
    '<div class="caption" id="caption"></div>' +
    '<div class="controls" id="controls" hidden>' +
    '<button type="button" id="playpause" class="ctl-primary">Pause</button>' +
    '<button type="button" id="skip">Skip</button>' +
    '<label class="spd">Speed <input type="range" id="speed" min="0.25" max="4" step="0.25" value="1" /></label>' +
    '</div>' +
    '<div class="stats" id="stats"></div>' +
    '<div class="result" id="result"></div>' +
    '<div class="whatif" id="whatif"></div>' +
    '<div class="compare" id="compare" hidden></div>' +
    '</div>'
  document.body.appendChild(panel)
  // Mobile bottom-sheet: the grab handle collapses/expands the sheet so the map stays visible.
  panel.querySelector('#sheet-handle')?.addEventListener('click', () => panel.classList.toggle('collapsed'))

  // About modal — what DukeMaps is, the algorithms (mechanism-first), the article, and OSM/ODbL credit.
  const about = document.createElement('div')
  about.className = 'about-backdrop'
  about.hidden = true
  about.innerHTML =
    '<div class="about-card" role="dialog" aria-modal="true" aria-label="About DukeMaps">' +
    '<button type="button" class="about-close" id="about-close" aria-label="Close">×</button>' +
    '<h2 class="about-title">DukeMaps</h2>' +
    '<p>Walking directions across Duke’s campus — and a live look at the search algorithms behind modern routing engines like Google Maps. Search two places, watch each algorithm explore the map, then see its route.</p>' +
    '<p class="about-h">The algorithms, in the order they appear</p>' +
    '<ul class="about-list">' +
    '<li><b>BFS</b> — explores in rings of equal hop-count: fewest turns, rarely the fastest walk.</li>' +
    '<li><b>DFS</b> — plunges down one branch until stuck; finds a path, almost never a good one.</li>' +
    '<li><b>Dijkstra</b> — always expands the cheapest-so-far node: optimal, but fans out in every direction.</li>' +
    '<li><b>A*</b> — Dijkstra plus a straight-line hint toward the goal: same route, far fewer nodes.</li>' +
    '<li><b>Bidirectional</b> — two searches meet in the middle; two small frontiers beat one big one.</li>' +
    '<li><b>Contraction Hierarchies</b> — precomputed shortcuts let the search leap up to important paths and back down.</li>' +
    '<li><b>Customizable CH</b> — the same hierarchy, re-weighted cheaply when crowding changes.</li>' +
    '</ul>' +
    '<p>The inset tree shows how CH and CCH climb from both ends to a meeting node, then unpack back down to the street-level route.</p>' +
    '<p class="about-cta"><a href="https://fundamentalstack.substack.com" target="_blank" rel="noopener">Read “How Google Maps Works” on Fundamental Stack →</a></p>' +
    '<p class="about-attr">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL) · tiles <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>. The graph, every algorithm, and the spatial index are hand-written in TypeScript.</p>' +
    '</div>'
  document.body.appendChild(about)
  const closeAbout = (): void => {
    about.hidden = true
  }
  panel.querySelector('#about-open')?.addEventListener('click', () => (about.hidden = false))
  about.querySelector('#about-close')?.addEventListener('click', closeAbout)
  about.addEventListener('click', (e) => {
    if (e.target === about) closeAbout() // click the backdrop (outside the card) to dismiss
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !about.hidden) closeAbout()
  })

  const showEl = panel.querySelector('#show') as HTMLDivElement
  const algosLink = panel.querySelector('#algos-link') as HTMLButtonElement
  const controlsEl = panel.querySelector('#controls') as HTMLDivElement
  const captionEl = panel.querySelector('#caption') as HTMLDivElement
  const statsEl = panel.querySelector('#stats') as HTMLDivElement
  const resultEl = panel.querySelector('#result') as HTMLDivElement
  const compareEl = panel.querySelector('#compare') as HTMLDivElement
  const whatifEl = panel.querySelector('#whatif') as HTMLDivElement
  const metricEl = panel.querySelector('#metric') as HTMLDivElement
  const leaveNowBtn = panel.querySelector('#leave-now') as HTMLButtonElement
  const leaveAtBtn = panel.querySelector('#leave-at') as HTMLButtonElement
  const leaveatEl = panel.querySelector('#leaveat') as HTMLInputElement
  const playBtn = panel.querySelector('#playpause') as HTMLButtonElement
  const skipBtn = panel.querySelector('#skip') as HTMLButtonElement
  const speedEl = panel.querySelector('#speed') as HTMLInputElement

  const input = (w: Which): HTMLInputElement => panel.querySelector(`#${w}`) as HTMLInputElement
  const infoEl = panel.querySelector('#info') as HTMLDivElement
  const colors: Record<Which, string> = { from: '#2e9e5b', to: '#d64545' }
  const markers: Record<Which, maplibregl.Marker | null> = { from: null, to: null }
  const chosen: Record<Which, Endpoint | null> = { from: null, to: null }
  // The field the user last clicked into — a following map/icon pick targets THAT box (else From, then To).
  let activeField: Which | null = null
  // Show the little × only when a field holds a value.
  const syncFieldX = (w: Which): void => {
    ;(panel.querySelector(`#x-${w}`) as HTMLButtonElement).hidden = !input(w).value
  }

  const renderInfo = (): void => {
    const line = (w: Which, name: string): string =>
      chosen[w]
        ? `<b>${name}:</b> ${esc(chosen[w]!.label)} <span class="dim">· snapped ${Math.round(chosen[w]!.distM)} m</span>`
        : `<b>${name}:</b> <span class="dim">—</span>`
    infoEl.innerHTML = `${line('from', 'From')}<br>${line('to', 'To')}`
  }

  // A tap far from any campus path isn't routable — reject it with a transient notice instead of
  // snapping hundreds of metres to the nearest edge. Tunable; search picks (Duke buildings) skip this.
  const MAX_SNAP_M = 120
  let noticeTimer = 0
  const flashNotice = (msg: string): void => {
    window.clearTimeout(noticeTimer)
    infoEl.innerHTML = `<span class="notice">${esc(msg)}</span>`
    noticeTimer = window.setTimeout(renderInfo, 2800)
  }

  const fmtTime = (s: number): string => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`)
  const fmtDist = (m: number): string => (m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`)
  const fmtSearch = (ms: number): string => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`)

  // The seven algorithms to walk through. CH/CCH need their prebuilt data; drop them if it didn't load.
  const algos: AlgoDef[] = ALGORITHMS.filter((a) => a.key !== 'cch' || !!cchStructure)
  // One colour per algorithm — routes persist in these colours during "Play all". The optimal searches
  // find the identical route (so they overlap); BFS and DFS differ, so their colours stand apart.
  const ALGO_COLORS: Record<string, string> = {
    bfs: '#e8590c', dfs: '#ae3ec9', dijkstra: '#1b7a37', astar: '#1c7ed6', bidir: '#f08c00', ch: '#e03131', cch: '#0b7285',
  }
  // The one optimal algorithm the default (instant) route draw uses (CCH if the hierarchy loaded, else Dijkstra).
  const optimalIdx = ((): number => {
    const i = algos.findIndex((a) => a.key === 'cch')
    return i >= 0 ? i : algos.findIndex((a) => a.key === 'dijkstra')
  })()
  leaveatEl.value = metricOpts.leaveAt
  leaveatEl.hidden = leaveNow
  leaveNowBtn.classList.toggle('on', leaveNow)
  leaveAtBtn.classList.toggle('on', !leaveNow)

  let curIdx = 0
  let playAll = false
  let showCompare = false // the compare table only appears after "Play all", never on a normal search
  let advanceTimer = 0
  const results = new Map<string, { settled: number; searchMs: number; costS: number; found: boolean; optimal: boolean; edges: string[]; explored: number[] }>()

  // A small table that accumulates as each algorithm finishes — the mechanism contrast, side by side.
  // Each row carries its algorithm key so hovering it can highlight that algorithm's route on the map.
  const renderCompare = (): void => {
    const rows = algos
      .filter((a) => results.has(a.key))
      .map((a) => {
        const r = results.get(a.key)!
        const dot = `<span class="swatch" style="background:${ALGO_COLORS[a.key] ?? '#1b7a37'}"></span>`
        return `<tr data-key="${a.key}"><td>${dot}${esc(a.name)}${r.optimal ? '' : '*'}</td><td>${r.settled}</td><td>${fmtSearch(r.searchMs)}</td></tr>`
      })
      .join('')
    compareEl.innerHTML = rows
      ? `<table><tr><th>algorithm</th><th>nodes searched</th><th>search time</th></tr>${rows}</table><div class="dim">* not the shortest route · hover a row to show its path</div>`
      : ''
    compareEl.hidden = !showCompare || !rows // only during/after "Play all", never a normal search
  }

  // Run one algorithm, draw its route, record its stats. animate=false draws the route instantly (the
  // default on both-pinned); animate=true plays the exploration (clicking a chip or Play all).
  const playAlgo = (i: number, animate = true): void => {
    if (!chosen.from || !chosen.to || i < 0 || i >= algos.length) return
    // CH's shortcuts bake the base metric in — never animate/draw it under a changed metric (its route
    // can be stale). Skip it in the sequence; the chip is disabled too.
    if (algos[i].key === 'ch' && !isBaseMetric()) {
      if (playAll && i + 1 < algos.length) playAlgo(i + 1, animate)
      else playAll = false
      return
    }
    window.clearTimeout(advanceTimer)
    player?.dispose()
    overlay.clearState() // clear the exploration frontier; persisted routes stay (they stack during Play all)
    elimView.hide() // re-shown just below, only for the hierarchy searches
    resultEl.textContent = ''
    statsEl.textContent = '' // settled/relaxed only shows while animating (set in the render loop below)
    curIdx = i
    const def = algos[i]
    const sId = chosen.from.node.id // captured so the onDone closure (timing loop) has them non-null
    const tId = chosen.to.node.id
    const trace = runAlgo(def.key, rg, weight, chData as CHData, cchData as CHData, sId, tId)
    showEl.hidden = false
    controlsEl.hidden = !animate // playback controls only while watching an animation
    captionEl.textContent = animate ? def.caption : ''
    // The elimination-tree inset tells the "climb to the apex, unpack back down" story — only for CH/CCH,
    // and not in Instant (it's educational chrome). Derived structurally from the active hierarchy; the
    // algorithms stay pure. CH uses the prebuilt data, CCH its live-customized data — both are CHData.
    const isHierarchy = def.key === 'ch' || def.key === 'cch'
    if (isHierarchy && animate) {
      const activeCH = def.key === 'ch' ? chData : cchData
      const sIdx = rg.indexOf.get(chosen.from.node.id)
      const tIdx = rg.indexOf.get(chosen.to.node.id)
      const paths = activeCH && sIdx !== undefined && tIdx !== undefined ? elimPaths(activeCH, sIdx, tIdx) : null
      if (paths && activeCH) {
        const fullCH = activeCH // non-null inside the closure
        elimView.show(layoutElimTree(paths, fullCH), {
          algoName: def.name,
          // Lazy: the whole-map elimination tree (~15k nodes) is only laid out if the user clicks to expand.
          buildFull: () => ({ full: layoutFullTree(fullCH), sPath: paths.sPath, tPath: paths.tPath, apex: paths.apex }),
        })
      }
    }
    const onDone = (): void => {
      playBtn.textContent = 'Replay'
      // Search time = how long the algorithm takes to compute, averaged over a few warm runs so the
      // number is stable (sub-millisecond otherwise). The animation run above already warmed the JIT.
      const K = 25
      const t0 = performance.now()
      for (let k = 0; k < K; k++) runAlgo(def.key, rg, weight, chData as CHData, cchData as CHData, sId, tId)
      const searchMs = (performance.now() - t0) / K
      const explored: number[] = [] // every node this algorithm settled — drawn faded when its row is hovered
      for (const ev of trace.events) if (ev.type === 'settle' && ev.node != null) explored.push(ev.node)
      results.set(def.key, {
        settled: trace.stats.nodesSettled,
        searchMs,
        costS: trace.route?.costS ?? Infinity,
        found: trace.stats.found,
        optimal: def.optimal,
        edges: trace.route?.edges ?? [],
        explored,
      })
      renderCompare()
      if (trace.route) {
        overlay.addRoute(trace.route.edges, playAll ? ALGO_COLORS[def.key] ?? '#1b7a37' : '#1b7a37')
        resultEl.innerHTML = `<b>${fmtTime(trace.route.costS)}</b> · ${fmtDist(trace.route.distanceM)} walk${animate ? ` · explored ${trace.stats.nodesSettled} nodes` : ''}`
      } else {
        resultEl.textContent = 'No route found.'
      }
      if (playAll && curIdx < algos.length - 1) advanceTimer = window.setTimeout(() => playAlgo(curIdx + 1, true), 1100)
      else playAll = false
    }
    player = makePlayer(
      trace,
      (s) => {
        if (animate) {
          overlay.redraw(s)
          if (isHierarchy) elimView.update(s) // climb the chains / pulse the apex / descend, in sync
          statsEl.innerHTML = `settled <b>${s.settled.size + s.settledB.size}</b> · relaxed <b>${s.relaxed.size}</b>`
        }
      },
      { speed: Number(speedEl.value) || 1, reducedMotion: !animate || prefersReducedMotion, onDone },
    )
    playBtn.textContent = 'Pause'
    player.play()
  }

  // The least-walking-time route under an alternate metric, for the "What if?" counterfactual. Always
  // Dijkstra (correct under any metric). Nothing to contrast under the plain base metric.
  const renderWhatIf = (): void => {
    if (!chosen.from || !chosen.to || leaveNow) {
      whatifEl.textContent = ''
      return
    }
    const s = chosen.from.node.id
    const t = chosen.to.node.id
    const cur = dijkstra(rg, s, t, { weight }).route
    const alt = dijkstra(rg, s, t, { weight: makeWeight(rg) }).route // the same walk under off-peak base time
    if (!cur || !alt) {
      whatifEl.textContent = ''
      return
    }
    const deltaMin = Math.round((cur.costS - alt.costS) / 60)
    whatifEl.innerHTML =
      deltaMin > 0
        ? `<b>What if?</b> Class-change crowding adds <b>+${deltaMin} min</b> vs off-peak.`
        : `<b>What if?</b> No class-change crowding at this departure time.`
  }

  // CH can't react to a changed metric, so if the current selection is a now-disabled CH, fall back to
  // CCH (which re-customizes) — or Dijkstra if the hierarchies didn't load.
  const runnableIdx = (i: number): number => {
    if (algos[i]?.key === 'ch' && !isBaseMetric()) {
      const cch = algos.findIndex((a) => a.key === 'cch')
      return cch >= 0 ? cch : algos.findIndex((a) => a.key === 'dijkstra')
    }
    return i
  }

  // Rebuild the cost metric from the current options and re-customize the CCH for it — the Phase 5c
  // payoff: change the weights, re-customize cheaply, never re-contract. Prebuilt CH bakes the base
  // metric in, so its chip is disabled whenever the metric isn't base. Persists the options locally.
  const applyMetric = (opt: { rerun?: boolean } = {}): void => {
    localStorage.setItem('dukemaps.leaveAt', metricOpts.leaveAt)
    localStorage.setItem('dukemaps.leaveNow', leaveNow ? '1' : '0')
    weight = buildWeight()
    let recustMs = 0
    if (cchStructure) {
      const t0 = performance.now()
      cchData = customize(cchStructure, rg, weight)
      recustMs = performance.now() - t0
    }
    if (isBaseMetric()) {
      metricEl.innerHTML = '<span class="dim">Metric: base walking time</span>'
    } else {
      const recust = cchStructure
        ? ` · <b>CCH re-customized in ${recustMs.toFixed(1)} ms</b> <span class="dim">(CH would need a full rebuild)</span>`
        : ''
      metricEl.innerHTML = `Metric: class-change crowding${recust}`
    }
    if (opt.rerun && chosen.from && chosen.to) {
      results.clear()
      renderCompare()
      renderWhatIf()
      overlay.clearRoutes()
      playAlgo(runnableIdx(curIdx), false)
    }
  }

  // If an endpoint is a building with doors, snap the door nearest the OTHER endpoint — so you leave/enter
  // by the right side of the building instead of whatever path happens to be closest to its centroid.
  const resolveDoors = (): void => {
    for (const w of ['from', 'to'] as Which[]) {
      const ep = chosen[w]
      const other = chosen[w === 'from' ? 'to' : 'from']
      if (!ep?.doors?.length || !other) continue
      let best = ep.doors[0]
      let bestD = Infinity
      for (const d of ep.doors) {
        const dd = haversineM(d[1], d[0], other.point[1], other.point[0])
        if (dd < bestD) {
          bestD = dd
          best = d
        }
      }
      const snap = edgeIndex.snap(best[0], best[1])
      if (snap) {
        ep.point = snap.point
        ep.node = snap.node
        markers[w]?.setLngLat(snap.point)
      }
    }
  }

  // Both pinned → draw the best route instantly (the default). The algorithm chips / Play all let the user
  // opt into watching the exploration animate.
  const startShow = (): void => {
    resolveDoors()
    showCompare = false
    results.clear()
    renderCompare()
    renderWhatIf()
    overlay.clearRoutes()
    playAll = false
    playAlgo(optimalIdx, false)
  }

  // Hover a compare row → emphasise that algorithm's route on the map (handy once routes overlap).
  compareEl.addEventListener('mouseover', (e) => {
    const key = ((e.target as HTMLElement).closest('tr[data-key]') as HTMLElement | null)?.dataset.key
    const r = key ? results.get(key) : null
    if (r && r.edges.length) overlay.setHighlight(r.edges, ALGO_COLORS[key as string] ?? '#111827', r.explored)
  })
  compareEl.addEventListener('mouseleave', () => overlay.clearHighlight())

  const setLeaveMode = (now: boolean): void => {
    leaveNow = now
    leaveNowBtn.classList.toggle('on', now)
    leaveAtBtn.classList.toggle('on', !now)
    leaveatEl.hidden = now
    applyMetric({ rerun: true })
  }
  leaveNowBtn.addEventListener('click', () => setLeaveMode(true))
  leaveAtBtn.addEventListener('click', () => setLeaveMode(false))
  leaveatEl.addEventListener('change', () => {
    metricOpts.leaveAt = leaveatEl.value || nowHHMM()
    applyMetric({ rerun: true })
  })
  // The single link → watch every algorithm explore in turn, each route persisting in its own colour.
  algosLink.addEventListener('click', () => {
    if (!chosen.from || !chosen.to) return
    window.clearTimeout(advanceTimer)
    showCompare = true
    results.clear()
    renderCompare()
    overlay.clearRoutes()
    playAll = true
    playAlgo(0, true)
  })
  playBtn.addEventListener('click', () => {
    if (!player) return
    if (playBtn.textContent === 'Replay') {
      overlay.clearRoutes()
      playAlgo(curIdx, true)
    }
    else if (player.playing) {
      player.pause()
      playBtn.textContent = 'Play'
    } else {
      player.play()
      playBtn.textContent = 'Pause'
    }
  })
  skipBtn.addEventListener('click', () => player?.skipToResult())
  speedEl.addEventListener('input', () => player?.setSpeed(Number(speedEl.value) || 1))

  const setEndpoint = (w: Which, lonLat: [number, number], label: string, enforceOnCampus = false, doors?: [number, number][]): void => {
    const snap = edgeIndex.snap(lonLat[0], lonLat[1])
    if (!snap) return
    if (enforceOnCampus && snap.distM > MAX_SNAP_M) {
      flashNotice("That spot isn't on Duke's campus — tap a path or building on campus.")
      return
    }
    chosen[w] = { label, point: snap.point, distM: snap.distM, node: snap.node, doors: doors?.length ? doors : undefined }
    const m = markers[w] ?? new maplibregl.Marker({ color: colors[w] })
    markers[w] = m.setLngLat(snap.point).addTo(map)
    renderInfo()
    if (chosen.from && chosen.to) startShow() // both pinned → run the show (or Instant)
  }

  const clearEndpoint = (w: Which): void => {
    markers[w]?.remove()
    markers[w] = null
    chosen[w] = null
    input(w).value = ''
    syncFieldX(w)
    showEl.hidden = true
    showCompare = false
    compareEl.hidden = true
    overlay.clear()
    elimView.hide()
    player?.dispose()
    player = null
    window.clearTimeout(advanceTimer)
    whatifEl.textContent = ''
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
      syncFieldX(w)
      activeField = null
      setEndpoint(w, [p.lon, p.lat], p.name, false, doorsByName.get(p.name))
    }
    el.addEventListener('input', () => {
      close()
      syncFieldX(w)
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
    el.addEventListener('focus', () => {
      activeField = w // a following map/icon pick targets THIS box
    })
    ;(panel.querySelector(`#x-${w}`) as HTMLButtonElement).addEventListener('click', () => {
      if (activeField === w) activeField = null
      clearEndpoint(w)
    })
    el.addEventListener('blur', () => setTimeout(close, 120)) // let a click on a hit land first
  }
  wireField('from')
  wireField('to')

  // Clickable building icons: tap an illustration to pick it as From (then To) — same flow as a map tap,
  // but no enforce (the committed icons are real campus buildings). Icons without a coord are skipped.
  const pickBuilding = (name: string, lonLat: [number, number], doors?: [number, number][]): void => {
    if (activeField) {
      const w = activeField
      activeField = null
      setEndpoint(w, lonLat, name, false, doors)
      if (chosen[w]) {
        input(w).value = name
        syncFieldX(w)
      }
      return
    }
    if (chosen.from && chosen.to) {
      clearEndpoint('from')
      clearEndpoint('to')
    }
    const w: Which = chosen.from ? 'to' : 'from'
    setEndpoint(w, lonLat, name, false, doors)
    if (chosen[w]) {
      input(w).value = name
      syncFieldX(w)
    }
  }
  // Doors for a searched place (best-effort by exact name; icon clicks pass doors directly).
  const doorsByName = new Map((buildingIconsConfig as BuildingIcon[]).filter((b) => b.doors?.length).map((b) => [b.name, b.doors as [number, number][]]))
  createBuildingIcons(map, buildingIconsConfig as BuildingIcon[], pickBuilding)

  // Developer tools (coordinate picker + door editor) are hidden by default. A "developer login" link in
  // the map attribution (bottom-right; password: dukemaps) reveals them, persisted in localStorage — so the
  // normal search modal stays clean for visitors.
  let pickCoords = false
  let doorMode = false
  const doorPts: [number, number][] = [] // [lon, lat]
  const doorMarkers: maplibregl.Marker[] = []
  const pickBtn = panel.querySelector('#pickcoords') as HTMLButtonElement
  const doorBtn = panel.querySelector('#doormode') as HTMLButtonElement
  const doorUndoBtn = panel.querySelector('#doorundo') as HTMLButtonElement
  const editBtn = panel.querySelector('#editgraph') as HTMLButtonElement
  const optRow = panel.querySelector('#opt-row') as HTMLDivElement // only holds dev tools now — hidden until dev login
  editBtn.addEventListener('click', () => window.open(new URL('editor/', document.baseURI).href, '_blank')) // the Phase-2 graph editor (dev server only)
  const addDoorPin = (lon: number, lat: number): void => {
    const el = document.createElement('div')
    el.className = 'door-pin'
    doorMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map))
  }
  const saveDoors = (): void => {
    void fetch('/__doors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doorPts) })
  }
  pickBtn.addEventListener('click', () => {
    pickCoords = !pickCoords
    pickBtn.classList.toggle('on', pickCoords)
    pickBtn.setAttribute('aria-pressed', String(pickCoords))
    map.getCanvas().style.cursor = pickCoords ? 'copy' : 'crosshair'
  })
  doorBtn.addEventListener('click', () => {
    doorMode = !doorMode
    doorBtn.classList.toggle('on', doorMode)
    doorBtn.setAttribute('aria-pressed', String(doorMode))
    if (doorMode) flashNotice(`🚪 Door mode on — click each door (${doorPts.length} placed)`)
  })
  doorUndoBtn.addEventListener('click', () => {
    doorPts.pop()
    doorMarkers.pop()?.remove()
    saveDoors()
    flashNotice(`🚪 ${doorPts.length} doors`)
  })

  // Region editor (dev-only): draw campus / sub-region polygons by clicking the map, then "Finish" to
  // name + save one. Persisted to config/dissection.json via the /__regions dev endpoint. These regions
  // become the nested-dissection separators for the campus-aware CCH ordering — so the user marks which
  // nodes divide campuses / dorms / academic clusters by drawing, not by hand-editing coordinates.
  interface Region {
    name: string
    polygon: [number, number][] // [lon, lat] ring (not closed; the last->first edge is implied)
  }
  let regionMode = false
  let regionDraft: [number, number][] = [] // the in-progress polygon's vertices
  let regions: Region[] = []
  let regionsLoaded = false
  const regionBtn = panel.querySelector('#regionmode') as HTMLButtonElement
  const regionFinishBtn = panel.querySelector('#regionfinish') as HTMLButtonElement
  const regionUndoBtn = panel.querySelector('#regionundo') as HTMLButtonElement
  const REGION_SRC = 'dm-regions'
  const DRAFT_SRC = 'dm-region-draft'
  const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
  map.addSource(REGION_SRC, { type: 'geojson', data: emptyFC })
  map.addSource(DRAFT_SRC, { type: 'geojson', data: emptyFC })
  map.addLayer({ id: 'dm-regions-fill', type: 'fill', source: REGION_SRC, paint: { 'fill-color': '#0b7285', 'fill-opacity': 0.1 } })
  map.addLayer({ id: 'dm-regions-line', type: 'line', source: REGION_SRC, paint: { 'line-color': '#0b7285', 'line-width': 2 } })
  map.addLayer({ id: 'dm-regions-label', type: 'symbol', source: REGION_SRC, layout: { 'text-field': ['get', 'name'], 'text-size': 13, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#0b5566', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } })
  map.addLayer({ id: 'dm-draft-line', type: 'line', source: DRAFT_SRC, paint: { 'line-color': '#e8590c', 'line-width': 2, 'line-dasharray': [2, 1] } })
  map.addLayer({ id: 'dm-draft-pts', type: 'circle', source: DRAFT_SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#e8590c' } })
  const regionLayerIds = ['dm-regions-fill', 'dm-regions-line', 'dm-regions-label', 'dm-draft-line', 'dm-draft-pts']
  const setRegionLayersVisible = (v: boolean): void => {
    for (const id of regionLayerIds) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none')
  }
  const refreshRegions = (): void => {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: regions.map((r) => ({ type: 'Feature', properties: { name: r.name }, geometry: { type: 'Polygon', coordinates: [[...r.polygon, r.polygon[0]]] } })),
    }
    ;(map.getSource(REGION_SRC) as maplibregl.GeoJSONSource).setData(fc)
  }
  const refreshDraft = (): void => {
    const features: GeoJSON.Feature[] = regionDraft.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }))
    if (regionDraft.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: regionDraft } })
    ;(map.getSource(DRAFT_SRC) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features })
  }
  const saveRegions = (): void => {
    void fetch('/__regions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(regions) })
  }
  regionBtn.addEventListener('click', () => {
    regionMode = !regionMode
    regionBtn.classList.toggle('on', regionMode)
    regionBtn.setAttribute('aria-pressed', String(regionMode))
    regionFinishBtn.hidden = !regionMode
    regionUndoBtn.hidden = !regionMode
    if (regionMode) flashNotice('🗺️ Region mode — click to outline a region, then Finish to name it')
  })
  regionFinishBtn.addEventListener('click', () => {
    if (regionDraft.length < 3) {
      flashNotice('A region needs at least 3 points')
      return
    }
    const name = window.prompt('Region name (e.g. west, west-dorms, west-academic):')?.trim()
    if (!name) return
    regions.push({ name, polygon: regionDraft })
    regionDraft = []
    refreshRegions()
    refreshDraft()
    saveRegions()
    flashNotice(`🗺️ Saved “${name}” — ${regions.length} region(s)`)
  })
  regionUndoBtn.addEventListener('click', () => {
    if (regionDraft.length) {
      regionDraft.pop()
      refreshDraft()
    } else if (regions.length) {
      const dropped = regions.pop()
      refreshRegions()
      saveRegions()
      flashNotice(`🗺️ Removed “${dropped?.name}” — ${regions.length} left`)
    }
  })

  // Show/hide the dev tools; load the placed door pins the first time it's enabled.
  let devMode = localStorage.getItem('dukemaps.dev') === '1'
  let doorsLoaded = false
  const applyDevMode = (): void => {
    optRow.hidden = !devMode // reveal the dev-tools row only on developer login
    pickBtn.hidden = !devMode
    doorBtn.hidden = !devMode
    doorUndoBtn.hidden = !devMode
    editBtn.hidden = !devMode
    regionBtn.hidden = !devMode
    localStorage.setItem('dukemaps.dev', devMode ? '1' : '0')
    const link = document.querySelector('.dm-devlogin') // the attribution link doubles as login / logout
    if (link) link.textContent = devMode ? 'developer logout' : 'developer login'
    if (devMode && !doorsLoaded) {
      doorsLoaded = true
      void fetch('/__doors')
        .then((r) => (r.ok ? r.json() : []))
        .then((pts: [number, number][]) => {
          for (const p of pts) {
            doorPts.push(p)
            addDoorPin(p[0], p[1])
          }
        })
    }
    if (devMode && !regionsLoaded) {
      regionsLoaded = true
      void fetch('/__regions')
        .then((r) => (r.ok ? r.json() : []))
        .then((rs: Region[]) => {
          regions = Array.isArray(rs) ? rs : []
          refreshRegions()
        })
    }
    if (!devMode) {
      pickCoords = false
      doorMode = false
      regionMode = false
      regionDraft = []
      refreshDraft()
      pickBtn.classList.remove('on')
      doorBtn.classList.remove('on')
      regionBtn.classList.remove('on')
      regionFinishBtn.hidden = true
      regionUndoBtn.hidden = true
    }
    // Door pins + region layers are dev-only overlays — hide on logout, re-show on re-entry (keep data).
    for (const m of doorMarkers) m.getElement().style.display = devMode ? '' : 'none'
    setRegionLayersVisible(devMode)
  }
  // The "developer login" link is rendered inside the MapLibre attribution — delegate its click.
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.dm-devlogin')) return
    e.preventDefault()
    if (devMode) {
      devMode = false
      applyDevMode()
      flashNotice('Developer mode off')
    } else if (window.prompt('Developer password') === 'dukemaps') {
      devMode = true
      applyDevMode()
      flashNotice('Developer mode on')
    } else {
      flashNotice('Wrong password')
    }
  })
  applyDevMode()

  // Tap fills From, then To; a tap when both are set starts a fresh pair. The pin is labelled with the
  // building you're nearest (not "Dropped pin").
  map.on('click', (e) => {
    if (regionMode) {
      regionDraft.push([e.lngLat.lng, e.lngLat.lat])
      refreshDraft()
      flashNotice(`🗺️ ${regionDraft.length} pts — Finish to name, Undo to drop the last`)
      return
    }
    if (doorMode) {
      doorPts.push([e.lngLat.lng, e.lngLat.lat])
      addDoorPin(e.lngLat.lng, e.lngLat.lat)
      saveDoors()
      flashNotice(`🚪 ${doorPts.length} doors (saved)`)
      return
    }
    if (pickCoords) {
      const c = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`
      void navigator.clipboard?.writeText(c)
      flashNotice(`📍 ${c} — copied`)
      return
    }
    const lonLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
    const name = placeIndex.nearest(e.lngLat.lat, e.lngLat.lng)?.name ?? 'Pinned location'
    // If the user clicked into a box first, set THAT one (and rerun if both are now pinned).
    if (activeField) {
      const w = activeField
      activeField = null
      setEndpoint(w, lonLat, name, true)
      if (chosen[w]) {
        input(w).value = name
        syncFieldX(w)
      }
      return
    }
    if (chosen.from && chosen.to) {
      clearEndpoint('from')
      clearEndpoint('to')
    }
    const w: Which = chosen.from ? 'to' : 'from'
    setEndpoint(w, lonLat, name, true) // enforce: reject taps off the campus network
    if (chosen[w]) {
      input(w).value = name // only label the field if the pin was accepted
      syncFieldX(w)
    }
  })
  map.getCanvas().style.cursor = 'crosshair'

  applyMetric() // set the metric line + CH-chip state and do the startup CCH customize
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
  void Promise.all([
    loadJSON<Graph>('data/graph.json'),
    loadJSON<Place[]>('data/places.json'),
    loadJSON<CHData>('data/ch.json'), // prebuilt contraction hierarchy (base metric)
    loadJSON<CCHStructure>('data/cch.json'), // metric-independent CCH structure (customized at runtime)
    loadJSON<{ dist: Record<string, number> }>('data/crowding.json'), // per-edge distance to academic buildings
  ]).then(([graph, places, chData, cchStructure, crowding]) => {
    if (!graph) {
      setStatus('<b>DukeMaps</b><div style="color:#b00">Could not load the graph. Run <code>npm run build:graph</code>.</div>')
      return
    }
    fitToCampus(map, buildingIconsConfig as BuildingIcon[], graph)
    const aliases = (aliasesConfig as { aliases?: Record<string, string> }).aliases ?? {}
    const placeIndex = buildPlaceIndex(places ?? [], aliases)
    const edgeIndex = buildEdgeIndex(graph)
    setupUI(map, graph, placeIndex, edgeIndex, chData, cchStructure, crowding?.dist ?? {})
  })
})
