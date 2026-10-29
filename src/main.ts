// DukeMaps app — the show. Search two campus places (fuzzy autocomplete) or tap to drop a pin (which
// is labelled with the building you're nearest). With both pinned, the seven hand-written searches
// replay their exploration over the map in turn, then draw their route. Secondary controls live in an
// "Options" disclosure to keep the panel calm: "Leave now" (base metric — Contraction Hierarchies work)
// vs "Leave at" a time (class-change crowding, which re-customizes the CCH live), plus Step-free and an
// Instant mode. Data is fetched at runtime, not bundled, so the map paints immediately.
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import themeLayers from 'protomaps-themes-base'
import type { Graph, GraphNode, Place } from './graph/types'
import { buildPlaceIndex, type PlaceIndex } from './places/search'
import { buildEdgeIndex, type EdgeIndex } from './spatial/snap'
import { buildRoutingGraph, makeWeight, type WeightFn } from './algorithms/routing'
import { customize, type CCHStructure } from './algorithms/cch'
import type { CHData } from './algorithms/ch'
import { dijkstra } from './algorithms/dijkstra'
import { crowdingMultiplier, hmsToSec, type Schedule } from './graph/time'
import { createOverlay } from './map/overlay'
import { makePlayer, type Player } from './anim/player'
import { ALGORITHMS, runAlgo, type AlgoDef } from './anim/algos'
import { elimPaths, layoutElimTree } from './anim/elimtree'
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

// Frame the map on the campus graph. The network itself is intentionally NOT drawn — the always-on
// grey lines were clutter; the animation draws the live frontier/leaps/route on demand instead.
function fitToGraph(m: maplibregl.Map, graph: Graph): void {
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
  node: GraphNode // routing anchor (nearest edge endpoint) — what the algorithms route between
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
    stepFree: localStorage.getItem('dukemaps.stepFree') === '1',
    leaveAt: localStorage.getItem('dukemaps.leaveAt') || nowHHMM(),
  }
  // "Leave now" (default) = plain base metric, so Contraction Hierarchies stay valid. "Leave at" a time
  // opts into class-change crowding (which re-customizes the CCH live and greys prebuilt CH when peak).
  let leaveNow = localStorage.getItem('dukemaps.leaveNow') == null ? true : localStorage.getItem('dukemaps.leaveNow') === '1'
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // "Instant" = skip the walk-through, just draw the optimal route. Remembered; defaults on under reduced motion.
  let instant = ((): boolean => {
    const s = localStorage.getItem('dukemaps.instant')
    return s == null ? prefersReducedMotion : s === '1'
  })()

  const buildWeight = (): WeightFn =>
    leaveNow
      ? makeWeight(rg, { stepFreeOnly: metricOpts.stepFree })
      : makeWeight(rg, {
          stepFreeOnly: metricOpts.stepFree,
          time: { departureSecOfDay: hmsToSec(metricOpts.leaveAt), isWeekend: false, schedule, distToAcademicM },
        })
  // A class-change bump is only possible when you've opted into a specific departure time.
  const isPeak = (): boolean => !leaveNow && crowdingMultiplier(0, { secOfDay: hmsToSec(metricOpts.leaveAt), isWeekend: false }, schedule) > 1
  const isBaseMetric = (): boolean => !metricOpts.stepFree && !isPeak()

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
    '<div class="brand">DukeMaps</div>' +
    '<div class="field"><input id="from" placeholder="From — search or tap the map" autocomplete="off" /><div class="ac" id="ac-from"></div></div>' +
    '<div class="field"><input id="to" placeholder="To — search or tap the map" autocomplete="off" /><div class="ac" id="ac-to"></div></div>' +
    '<button type="button" class="disclosure" id="opt-toggle" aria-expanded="false">Options</button>' +
    '<div class="options" id="options" hidden>' +
    '<div class="leave-row">' +
    '<div class="seg" role="group" aria-label="Departure">' +
    '<button type="button" class="seg-btn on" id="leave-now">Leave now</button>' +
    '<button type="button" class="seg-btn" id="leave-at">Leave at</button>' +
    '</div>' +
    '<input type="time" id="leaveat" hidden />' +
    '</div>' +
    '<div class="opt-row">' +
    '<button type="button" class="opt" id="stepfree" aria-pressed="false">Step-free</button>' +
    '<button type="button" class="opt" id="instant" aria-pressed="false">Instant</button>' +
    '<button type="button" class="opt" id="pickcoords" aria-pressed="false" hidden>📍 Coords</button>' +
    '</div>' +
    '</div>' +
    '<div class="metric" id="metric"></div>' +
    '<div class="info" id="info"></div>' +
    '<div class="show" id="show" hidden>' +
    '<div class="chips" id="chips"></div>' +
    '<div class="chipnote" id="chipnote"></div>' +
    '<div class="caption" id="caption"></div>' +
    '<div class="controls">' +
    '<button type="button" id="playpause" class="ctl-primary">Pause</button>' +
    '<button type="button" id="skip">Skip</button>' +
    '<label class="spd">Speed <input type="range" id="speed" min="0.25" max="4" step="0.25" value="1" /></label>' +
    '<button type="button" id="playall" class="ctl-link">↻ Replay all</button>' +
    '</div>' +
    '<div class="stats" id="stats"></div>' +
    '<div class="result" id="result"></div>' +
    '<div class="whatif" id="whatif"></div>' +
    '<button type="button" class="disclosure" id="cmp-toggle" aria-expanded="false">Compare all</button>' +
    '<div class="compare" id="compare" hidden></div>' +
    '</div>'
  document.body.appendChild(panel)
  // Mobile bottom-sheet: the grab handle collapses/expands the sheet so the map stays visible.
  panel.querySelector('#sheet-handle')?.addEventListener('click', () => panel.classList.toggle('collapsed'))

  const showEl = panel.querySelector('#show') as HTMLDivElement
  const chipsEl = panel.querySelector('#chips') as HTMLDivElement
  const chipnoteEl = panel.querySelector('#chipnote') as HTMLDivElement
  const captionEl = panel.querySelector('#caption') as HTMLDivElement
  const statsEl = panel.querySelector('#stats') as HTMLDivElement
  const resultEl = panel.querySelector('#result') as HTMLDivElement
  const compareEl = panel.querySelector('#compare') as HTMLDivElement
  const whatifEl = panel.querySelector('#whatif') as HTMLDivElement
  const metricEl = panel.querySelector('#metric') as HTMLDivElement
  const optToggle = panel.querySelector('#opt-toggle') as HTMLButtonElement
  const optionsEl = panel.querySelector('#options') as HTMLDivElement
  const leaveNowBtn = panel.querySelector('#leave-now') as HTMLButtonElement
  const leaveAtBtn = panel.querySelector('#leave-at') as HTMLButtonElement
  const leaveatEl = panel.querySelector('#leaveat') as HTMLInputElement
  const stepfreeBtn = panel.querySelector('#stepfree') as HTMLButtonElement
  const instantBtn = panel.querySelector('#instant') as HTMLButtonElement
  const cmpToggle = panel.querySelector('#cmp-toggle') as HTMLButtonElement
  const playAllBtn = panel.querySelector('#playall') as HTMLButtonElement
  const playBtn = panel.querySelector('#playpause') as HTMLButtonElement
  const skipBtn = panel.querySelector('#skip') as HTMLButtonElement
  const speedEl = panel.querySelector('#speed') as HTMLInputElement

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

  // The seven algorithms to walk through. CH/CCH need their prebuilt data; drop them if it didn't load.
  const algos: AlgoDef[] = ALGORITHMS.filter((a) => (a.key !== 'ch' && a.key !== 'cch') || !!(chData && cchStructure))
  chipsEl.innerHTML = algos.map((a, i) => `<button type="button" class="chip" data-i="${i}">${esc(a.name)}</button>`).join('')
  const chipEls = Array.from(chipsEl.querySelectorAll('.chip')) as HTMLButtonElement[]
  const chChipIdx = algos.findIndex((a) => a.key === 'ch')
  // The one optimal algorithm Instant mode runs (CCH if the hierarchy loaded, else Dijkstra).
  const optimalIdx = ((): number => {
    const i = algos.findIndex((a) => a.key === 'cch')
    return i >= 0 ? i : algos.findIndex((a) => a.key === 'dijkstra')
  })()
  leaveatEl.value = metricOpts.leaveAt
  leaveatEl.hidden = leaveNow
  leaveNowBtn.classList.toggle('on', leaveNow)
  leaveAtBtn.classList.toggle('on', !leaveNow)
  stepfreeBtn.classList.toggle('on', metricOpts.stepFree)
  stepfreeBtn.setAttribute('aria-pressed', String(metricOpts.stepFree))
  instantBtn.classList.toggle('on', instant)
  instantBtn.setAttribute('aria-pressed', String(instant))
  showEl.classList.toggle('instant', instant)

  let curIdx = 0
  let playAll = false
  let advanceTimer = 0
  const results = new Map<string, { settled: number; costS: number; found: boolean; optimal: boolean }>()

  // A small table that accumulates as each algorithm finishes — the mechanism contrast, side by side.
  const renderCompare = (): void => {
    const rows = algos
      .filter((a) => results.has(a.key))
      .map((a) => {
        const r = results.get(a.key)!
        return `<tr><td>${esc(a.name)}</td><td>${r.settled}</td><td>${r.found ? fmtTime(r.costS) : '—'}${r.optimal ? '' : '*'}</td></tr>`
      })
      .join('')
    compareEl.innerHTML = rows
      ? `<table><tr><th>algorithm</th><th>settled</th><th>time</th></tr>${rows}</table><div class="dim">* not the fastest route</div>`
      : ''
  }

  // Run one algorithm, animate its exploration, draw its route, record its stats.
  const playAlgo = (i: number): void => {
    if (!chosen.from || !chosen.to || i < 0 || i >= algos.length) return
    // CH's shortcuts bake the base metric in — never animate/draw it under a changed metric (its route
    // can be stale or, under step-free, unsafe). Skip it in the sequence; the chip is disabled too.
    if (algos[i].key === 'ch' && !isBaseMetric()) {
      if (playAll && i + 1 < algos.length) playAlgo(i + 1)
      else playAll = false
      return
    }
    window.clearTimeout(advanceTimer)
    player?.dispose()
    overlay.clear()
    elimView.hide() // re-shown just below, only for the hierarchy searches
    resultEl.textContent = ''
    curIdx = i
    chipEls.forEach((c, k) => c.classList.toggle('on', k === i))
    const def = algos[i]
    const trace = runAlgo(def.key, rg, weight, chData as CHData, cchData as CHData, chosen.from.node.id, chosen.to.node.id)
    showEl.hidden = false
    captionEl.textContent = def.caption
    // The elimination-tree inset tells the "climb to the apex, unpack back down" story — only for CH/CCH,
    // and not in Instant (it's educational chrome). Derived structurally from the active hierarchy; the
    // algorithms stay pure. CH uses the prebuilt data, CCH its live-customized data — both are CHData.
    const isHierarchy = def.key === 'ch' || def.key === 'cch'
    if (isHierarchy && !instant) {
      const activeCH = def.key === 'ch' ? chData : cchData
      const sIdx = rg.indexOf.get(chosen.from.node.id)
      const tIdx = rg.indexOf.get(chosen.to.node.id)
      const paths = activeCH && sIdx !== undefined && tIdx !== undefined ? elimPaths(activeCH, sIdx, tIdx) : null
      if (paths && activeCH) elimView.show(layoutElimTree(paths, activeCH), { algoName: def.name })
    }
    const onDone = (): void => {
      playBtn.textContent = 'Replay'
      results.set(def.key, { settled: trace.stats.nodesSettled, costS: trace.route?.costS ?? Infinity, found: trace.stats.found, optimal: def.optimal })
      renderCompare()
      if (trace.route) {
        overlay.drawRoute(trace.route)
        resultEl.innerHTML = `<b>${fmtTime(trace.route.costS)}</b> · ${fmtDist(trace.route.distanceM)} walk · explored ${trace.stats.nodesSettled} nodes`
      } else {
        resultEl.textContent = 'No route found.'
      }
      if (playAll && curIdx < algos.length - 1) advanceTimer = window.setTimeout(() => playAlgo(curIdx + 1), 1100)
      else playAll = false
    }
    player = makePlayer(
      trace,
      (s) => {
        if (!instant) {
          overlay.redraw(s) // Instant = clean route only; skip the exploration viz
          if (isHierarchy) elimView.update(s) // climb the chains / pulse the apex / descend, in sync
        }
        statsEl.innerHTML = `settled <b>${s.settled.size + s.settledB.size}</b> · relaxed <b>${s.relaxed.size}</b>`
      },
      { speed: Number(speedEl.value) || 1, reducedMotion: instant || prefersReducedMotion, onDone },
    )
    playBtn.textContent = 'Pause'
    player.play()
  }

  // The least-walking-time route under an alternate metric, for the "What if?" counterfactual. Always
  // Dijkstra (correct under any metric). Nothing to contrast under the plain base metric.
  const renderWhatIf = (): void => {
    if (!chosen.from || !chosen.to || (!metricOpts.stepFree && leaveNow)) {
      whatifEl.textContent = ''
      return
    }
    const s = chosen.from.node.id
    const t = chosen.to.node.id
    const cur = dijkstra(rg, s, t, { weight }).route
    if (!cur) {
      whatifEl.textContent = ''
      return
    }
    const timeOpt = { departureSecOfDay: hmsToSec(metricOpts.leaveAt), isWeekend: false, schedule, distToAcademicM }
    // step-free on → vs stairs-allowed at the same departure; else → this departure's crowding vs off-peak.
    const altWeight = metricOpts.stepFree
      ? leaveNow
        ? makeWeight(rg)
        : makeWeight(rg, { time: timeOpt })
      : makeWeight(rg)
    const alt = dijkstra(rg, s, t, { weight: altWeight }).route
    if (!alt) {
      whatifEl.textContent = ''
      return
    }
    const deltaMin = Math.round((cur.costS - alt.costS) / 60)
    if (metricOpts.stepFree) {
      whatifEl.innerHTML =
        deltaMin > 0
          ? `<b>What if?</b> Step-free adds <b>+${deltaMin} min</b> here — the shortest walk uses stairs.`
          : `<b>What if?</b> Step-free is free here — no stairs on the shortest walk.`
    } else {
      whatifEl.innerHTML =
        deltaMin > 0
          ? `<b>What if?</b> Class-change crowding adds <b>+${deltaMin} min</b> vs off-peak.`
          : `<b>What if?</b> No class-change crowding at this departure time.`
    }
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
    localStorage.setItem('dukemaps.stepFree', metricOpts.stepFree ? '1' : '0')
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
      const bits: string[] = []
      if (metricOpts.stepFree) bits.push('step-free')
      if (isPeak()) bits.push('class-change crowding')
      const recust = cchStructure
        ? ` · <b>CCH re-customized in ${recustMs.toFixed(1)} ms</b> <span class="dim">(CH would need a full rebuild)</span>`
        : ''
      metricEl.innerHTML = `Metric: ${bits.join(' + ')}${recust}`
    }
    if (chChipIdx >= 0) {
      const dis = !isBaseMetric()
      const chip = chipEls[chChipIdx]
      chip.classList.toggle('disabled', dis)
      chip.disabled = dis
      chip.title = dis
        ? 'Contraction Hierarchies bake the weights into their shortcuts — a changed metric needs a full rebuild. Customizable CH re-customizes instead.'
        : ''
      chipnoteEl.innerHTML = dis
        ? 'Contraction Hierarchies is greyed out — it bakes the weights into its shortcuts, so it can’t react to this metric. Customizable CH re-customizes instead.'
        : ''
    }
    if (opt.rerun && chosen.from && chosen.to) {
      results.clear()
      renderCompare()
      renderWhatIf()
      playAlgo(runnableIdx(curIdx))
    }
  }

  // Both pinned (or "Replay all") → walk through all seven in order; or, in Instant mode, just the
  // optimal route, no animation.
  const startShow = (): void => {
    results.clear()
    renderCompare()
    renderWhatIf()
    if (instant) {
      playAll = false
      playAlgo(optimalIdx)
    } else {
      playAll = true
      playAlgo(0)
    }
  }

  const toggleDisclosure = (btn: HTMLButtonElement, body: HTMLElement): void => {
    const open = body.hidden
    body.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    btn.classList.toggle('open', open)
  }
  optToggle.addEventListener('click', () => toggleDisclosure(optToggle, optionsEl))
  cmpToggle.addEventListener('click', () => toggleDisclosure(cmpToggle, compareEl))

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
  stepfreeBtn.addEventListener('click', () => {
    metricOpts.stepFree = !metricOpts.stepFree
    stepfreeBtn.classList.toggle('on', metricOpts.stepFree)
    stepfreeBtn.setAttribute('aria-pressed', String(metricOpts.stepFree))
    applyMetric({ rerun: true })
  })
  instantBtn.addEventListener('click', () => {
    instant = !instant
    localStorage.setItem('dukemaps.instant', instant ? '1' : '0')
    instantBtn.classList.toggle('on', instant)
    instantBtn.setAttribute('aria-pressed', String(instant))
    showEl.classList.toggle('instant', instant)
    if (chosen.from && chosen.to) startShow() // switch modes immediately
  })

  chipsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.chip') as HTMLButtonElement | null
    if (!btn || btn.disabled) return
    playAll = false
    window.clearTimeout(advanceTimer)
    playAlgo(Number(btn.dataset.i))
  })
  playAllBtn.addEventListener('click', startShow)
  playBtn.addEventListener('click', () => {
    if (!player) return
    if (playBtn.textContent === 'Replay') playAlgo(curIdx)
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

  const setEndpoint = (w: Which, lonLat: [number, number], label: string, enforceOnCampus = false): void => {
    const snap = edgeIndex.snap(lonLat[0], lonLat[1])
    if (!snap) return
    if (enforceOnCampus && snap.distM > MAX_SNAP_M) {
      flashNotice("That spot isn't on Duke's campus — tap a path or building on campus.")
      return
    }
    chosen[w] = { label, point: snap.point, distM: snap.distM, node: snap.node }
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
    showEl.hidden = true
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

  // Clickable building icons: tap an illustration to pick it as From (then To) — same flow as a map tap,
  // but no enforce (the committed icons are real campus buildings). Icons without a coord are skipped.
  const pickBuilding = (name: string, lonLat: [number, number]): void => {
    if (chosen.from && chosen.to) {
      clearEndpoint('from')
      clearEndpoint('to')
    }
    const w: Which = chosen.from ? 'to' : 'from'
    setEndpoint(w, lonLat, name)
    if (chosen[w]) input(w).value = name
  }
  createBuildingIcons(map, buildingIconsConfig as BuildingIcon[], pickBuilding)

  // Dev-only coordinate picker: when on, a map click copies "lat, lon" instead of routing — so exact
  // building positions can be handed back for config/building-overrides.json. Hidden in the built site.
  let pickCoords = false
  const pickBtn = panel.querySelector('#pickcoords') as HTMLButtonElement
  if (import.meta.env.DEV) {
    pickBtn.hidden = false
    pickBtn.addEventListener('click', () => {
      pickCoords = !pickCoords
      pickBtn.classList.toggle('on', pickCoords)
      pickBtn.setAttribute('aria-pressed', String(pickCoords))
      map.getCanvas().style.cursor = pickCoords ? 'copy' : 'crosshair'
    })
  }

  // Tap fills From, then To; a tap when both are set starts a fresh pair. The pin is labelled with the
  // building you're nearest (not "Dropped pin").
  map.on('click', (e) => {
    if (pickCoords) {
      const c = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`
      void navigator.clipboard?.writeText(c)
      flashNotice(`📍 ${c} — copied`)
      return
    }
    const lonLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
    if (chosen.from && chosen.to) {
      clearEndpoint('from')
      clearEndpoint('to')
    }
    const w: Which = chosen.from ? 'to' : 'from'
    const name = placeIndex.nearest(e.lngLat.lat, e.lngLat.lng)?.name ?? 'Pinned location'
    setEndpoint(w, lonLat, name, true) // enforce: reject taps off the campus network
    if (chosen[w]) input(w).value = name // only label the field if the pin was accepted
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
    fitToGraph(map, graph)
    const aliases = (aliasesConfig as { aliases?: Record<string, string> }).aliases ?? {}
    const placeIndex = buildPlaceIndex(places ?? [], aliases)
    const edgeIndex = buildEdgeIndex(graph)
    setupUI(map, graph, placeIndex, edgeIndex, chData, cchStructure, crowding?.dist ?? {})
  })
})
