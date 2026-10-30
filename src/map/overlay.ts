// The animation overlay: a 2D canvas pinned over the MapLibre basemap (pointer-events: none) on which
// we draw an algorithm's exploration and final route. The muted MapLibre graph layer stays underneath
// as context; this draws the live frontier / settled nodes / relaxed edges / route on top. Node lat/lon
// are projected with map.project() and the canvas is redrawn on every map move, so it stays aligned.
//
// Drawing is BATCHED — all same-coloured edges in one path + one stroke, all same-coloured node dots in
// one path + one fill — so even Dijkstra's whole-graph frontier (~6k nodes, ~7k edges) is a handful of
// canvas calls per frame. ponytail: 2D canvas; a WebGL CustomLayer is the upgrade path if it janks.
import type * as maplibregl from 'maplibre-gl'
import type { Graph } from '../graph/types'
import type { RenderState } from '../anim/player'

export interface Overlay {
  redraw(s: RenderState): void
  addRoute(edges: string[], color: string): void // persist a coloured route (routes stack as each algo finishes)
  clearRoutes(): void
  clearState(): void // clear the exploration frontier but keep persisted routes
  clear(): void
  dispose(): void
}

export function createOverlay(map: maplibregl.Map, graph: Graph): Overlay {
  const canvas = document.createElement('canvas')
  canvas.className = 'anim-overlay'
  map.getCanvasContainer().appendChild(canvas)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const))
  const edgeById = new Map(graph.edges.map((e) => [e.id, e] as const))

  let dpr = 1
  let state: RenderState | null = null
  let routes: { edges: string[]; color: string }[] = [] // persisted; each algorithm adds its route in its colour

  const px = (lon: number, lat: number): [number, number] => {
    const p = map.project([lon, lat])
    return [p.x * dpr, p.y * dpr]
  }

  const strokeEdges = (ids: Iterable<string>, color: string, width: number): void => {
    ctx.beginPath()
    for (const id of ids) {
      const e = edgeById.get(id)
      if (!e) continue
      e.geometry.forEach(([lon, lat], i) => {
        const [x, y] = px(lon, lat)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
    }
    ctx.strokeStyle = color
    ctx.lineWidth = width * dpr
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  const fillNodes = (ids: Iterable<number>, color: string, r: number, skip?: Set<number>): void => {
    ctx.beginPath()
    for (const id of ids) {
      if (skip && skip.has(id)) continue
      const n = nodeById.get(id)
      if (!n) continue
      const [x, y] = px(n.lon, n.lat)
      ctx.moveTo(x + r * dpr, y)
      ctx.arc(x, y, r * dpr, 0, Math.PI * 2)
    }
    ctx.fillStyle = color
    ctx.fill()
  }

  const draw = (): void => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (state) {
      strokeEdges(state.skipped, 'rgba(154,165,177,0.30)', 1) // access-skipped: faded, not red
      strokeEdges(state.relaxed, 'rgba(46,111,214,0.22)', 1) // explored tree
      fillNodes(state.settled, 'rgba(46,111,214,0.50)', 1.7) // forward settled (blue)
      fillNodes(state.settledB, 'rgba(139,92,246,0.52)', 1.7) // backward settled (purple)
      fillNodes(state.discovered, 'rgba(242,153,0,0.85)', 1.7, state.settled) // forward frontier (amber)
      fillNodes(state.discoveredB, 'rgba(236,72,153,0.85)', 1.7, state.settledB) // backward frontier (pink)
      if (state.current != null) fillNodes([state.current], '#111827', 3.4) // the node being expanded
    }
    for (const r of routes) strokeEdges(r.edges, r.color, 4) // persisted routes (one colour per algorithm)
  }

  const resize = (): void => {
    dpr = window.devicePixelRatio || 1
    const w = map.getCanvas().clientWidth
    const h = map.getCanvas().clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    draw()
  }

  map.on('move', draw)
  map.on('resize', resize)
  window.addEventListener('resize', resize)
  resize()

  return {
    redraw(s) {
      state = s
      draw()
    },
    addRoute(edges, color) {
      routes.push({ edges, color })
      draw()
    },
    clearRoutes() {
      routes = []
      draw()
    },
    clearState() {
      state = null
      draw()
    },
    clear() {
      state = null
      routes = []
      draw()
    },
    dispose() {
      map.off('move', draw)
      map.off('resize', resize)
      window.removeEventListener('resize', resize)
      canvas.remove()
    },
  }
}
