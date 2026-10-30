// The elimination-tree inset (SVG). Draws the two chains from the pure `layoutElimTree`, then animates
// them IN SYNC with the CH/CCH run by reading the player's RenderState every frame — no second timeline:
//   • a chain node lights the moment its id turns up in settled (forward, green) / settledB (back, red),
//   • the apex pulses once the two searches have met (RenderState.met),
//   • on done, the "symbolic descent" sweeps both chains green from the apex back down to s and t
//     (per-element transition-delay = a pure-CSS downward sweep) while the real route draws on the map.
// SVG (tens of nodes) is the right tool here vs the map's canvas (thousands); it's crisp + accessible
// and needs no map projection — the tree is abstract rank-space.
import type { RenderState } from './player'
import type { TreeLayout, FullTreeLayout } from './elimtree'

// What the full-screen view needs: the whole-tree layout plus THIS query's chains to light on top of it.
export interface FullTreeHighlight {
  full: FullTreeLayout
  sPath: number[] // routing indices, From leaf .. apex
  tPath: number[] // routing indices, To leaf .. apex
  apex: number // routing index of the meeting node
  buildings?: { idx: number; file: string; name: string }[] // placed building icons: node routing index, icon URL, label
}

const NS = 'http://www.w3.org/2000/svg'
const S_COLOR = '#2e9e5b' // forward / From (matches the map marker)
const T_COLOR = '#d64545' // backward / To
const APEX_COLOR = '#0b7285' // the design accent — the meeting node
const ROUTE_COLOR = '#1b7a37' // descent / final route green
const DIM = '#d2cfc6' // not-yet-reached (on the search path)
const FAINT = '#e8e5de' // unsearched sibling branches — just there for tree context

// viewBox coordinate space; layout's [0,1]^2 maps into it with padding for the labels.
const VW = 150
const VH = 132
const PAD_X = 9
const PAD_TOP = 15 // room for the apex label
const PAD_BOT = 15 // room for the From/To labels
const X = (x: number): number => PAD_X + x * (VW - 2 * PAD_X)
const Y = (y: number): number => PAD_TOP + y * (VH - PAD_TOP - PAD_BOT)

export interface ElimTreeView {
  show(layout: TreeLayout, opts: { algoName: string; buildFull?: () => FullTreeHighlight }): void
  update(s: RenderState): void
  hide(): void
  dispose(): void
}

const svgEl = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

export function createElimTreeView(container: HTMLElement): ElimTreeView {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let layout: TreeLayout | null = null
  let nodeEls: SVGCircleElement[] = []
  let edgeEls: { line: SVGLineElement; child: number; side: 'f' | 'b' | 'apex' | 'ctx'; faint: boolean }[] = []
  let lit: Int8Array = new Int8Array(0) // per node: has it been reached yet?
  let phase: 'climb' | 'met' | 'done' = 'climb'

  const title = document.createElement('div')
  title.className = 'elim-title'
  const svg = svgEl('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'elim-svg', role: 'img' })
  const cap = document.createElement('div')
  cap.className = 'elim-cap'
  container.append(title, svg, cap)
  container.hidden = true

  const setCap = (text: string): void => {
    cap.textContent = text
  }

  // ---- Click the inset to expand: the WHOLE elimination tree on a canvas, this route lit on top. ----
  // The inset is a 6-row sketch; the full tree is ~15k nodes, so it goes on a <canvas> (SVG would choke)
  // with wheel-zoom + drag-pan. `buildFull` is a lazy thunk from the caller, built only on the first click.
  let buildFull: (() => FullTreeHighlight) | null = null
  let fh: FullTreeHighlight | null = null
  const viewT = { zoom: 1, ox: 0, oy: 0 } // pan/zoom layered over the fit-to-screen base mapping

  const backdrop = document.createElement('div')
  backdrop.className = 'elim-full'
  backdrop.hidden = true
  backdrop.innerHTML =
    '<div class="elim-full-bar"><span class="elim-full-h"></span>' +
    '<button type="button" class="elim-full-close" aria-label="Close">×</button></div>' +
    '<canvas class="elim-full-canvas"></canvas>' +
    '<div class="elim-full-hint">scroll to zoom · drag to pan</div>'
  document.body.appendChild(backdrop)
  const canvas = backdrop.querySelector('.elim-full-canvas') as HTMLCanvasElement
  const fullH = backdrop.querySelector('.elim-full-h') as HTMLElement
  const closeFull = (): void => {
    backdrop.hidden = true
  }

  const iconCache = new Map<string, HTMLImageElement>() // placed-building icon images, loaded once
  let iconDrawPending = false // coalesce the redraws triggered as icons finish loading (avoid a storm)
  const drawFull = (): void => {
    if (!fh) return
    const dpr = window.devicePixelRatio || 1
    const CW = backdrop.clientWidth
    const CH = backdrop.clientHeight
    canvas.width = CW * dpr
    canvas.height = CH * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, CW, CH)
    const PAD = 46
    const PAD_T = 76 // clear the title bar at the top
    const bx = (x: number): number => PAD + x * (CW - 2 * PAD)
    const by = (y: number): number => PAD_T + y * (CH - PAD_T - PAD)
    const sx = (x: number): number => bx(x) * viewT.zoom + viewT.ox
    const sy = (y: number): number => by(y) * viewT.zoom + viewT.oy
    const { xs, ys, parent, n } = fh.full
    // the whole tree, faint — every parent->child edge in one batched path
    ctx.strokeStyle = DIM
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const p = parent[i]
      if (p < 0) continue
      ctx.moveTo(sx(xs[i]), sy(ys[i]))
      ctx.lineTo(sx(xs[p]), sy(ys[p]))
    }
    ctx.stroke()
    // this query's two chains, lit on top so you can see where it sits in the whole hierarchy
    const litChain = (path: number[], color: string): void => {
      if (!path.length) return
      ctx.strokeStyle = color
      ctx.lineWidth = 2.4
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let i = 0; i + 1 < path.length; i++) {
        ctx.moveTo(sx(xs[path[i]]), sy(ys[path[i]]))
        ctx.lineTo(sx(xs[path[i + 1]]), sy(ys[path[i + 1]]))
      }
      ctx.stroke()
      ctx.fillStyle = color
      for (const v of path) {
        ctx.beginPath()
        ctx.arc(sx(xs[v]), sy(ys[v]), 2.4, 0, 7)
        ctx.fill()
      }
    }
    litChain(fh.sPath, S_COLOR)
    litChain(fh.tPath, T_COLOR)
    ctx.fillStyle = APEX_COLOR
    ctx.beginPath()
    ctx.arc(sx(xs[fh.apex]), sy(ys[fh.apex]), 5, 0, 7)
    ctx.fill()
    // placed building icons at their nodes — campus landmarks scattered through the hierarchy
    if (fh.buildings) {
      const S = 17
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'
      for (const b of fh.buildings) {
        let img = iconCache.get(b.file)
        if (!img) {
          img = new Image()
          img.onload = (): void => {
            if (backdrop.hidden || iconDrawPending) return
            iconDrawPending = true
            requestAnimationFrame(() => {
              iconDrawPending = false
              drawFull()
            })
          }
          img.src = b.file
          iconCache.set(b.file, img)
        }
        if (!img.complete || !img.naturalWidth) continue
        const ix = sx(xs[b.idx])
        const iy = sy(ys[b.idx])
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(ix, iy, S / 2 + 2, 0, 7)
        ctx.fill()
        ctx.drawImage(img, ix - S / 2, iy - S / 2, S, S)
        // building name under the icon, with a white halo so it reads over the tree
        const ty = iy + S / 2 + 2
        ctx.lineWidth = 3
        ctx.strokeStyle = '#fff'
        ctx.strokeText(b.name, ix, ty)
        ctx.fillStyle = '#374151'
        ctx.fillText(b.name, ix, ty)
      }
    }
  }

  const openFull = (): void => {
    if (!buildFull) return
    fh = buildFull()
    viewT.zoom = 1
    viewT.ox = 0
    viewT.oy = 0
    fullH.textContent = `Full elimination tree · ${fh.full.n.toLocaleString()} nodes · your route is the lit path`
    backdrop.hidden = false
    requestAnimationFrame(drawFull) // wait a frame so the backdrop has laid out (clientWidth/Height set)
  }

  backdrop.querySelector('.elim-full-close')?.addEventListener('click', closeFull)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.hidden) closeFull()
  })
  window.addEventListener('resize', () => {
    if (!backdrop.hidden) drawFull()
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const f = Math.exp(-e.deltaY * 0.004) // zoom toward the cursor, scaled to the scroll amount
      viewT.ox = mx - (mx - viewT.ox) * f
      viewT.oy = my - (my - viewT.oy) * f
      viewT.zoom *= f
      drawFull()
    },
    { passive: false },
  )
  let dragging = false
  let lastX = 0
  let lastY = 0
  canvas.addEventListener('mousedown', (e) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    viewT.ox += e.clientX - lastX
    viewT.oy += e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    drawFull()
  })
  window.addEventListener('mouseup', () => {
    dragging = false
  })

  container.style.cursor = 'zoom-in'
  container.title = 'Click for the full tree'
  container.addEventListener('click', openFull)

  const show = (l: TreeLayout, opts: { algoName: string; buildFull?: () => FullTreeHighlight }): void => {
    layout = l
    buildFull = opts.buildFull ?? null
    phase = 'climb'
    lit = new Int8Array(l.nodes.length)
    nodeEls = []
    edgeEls = []
    svg.replaceChildren()

    const apex = l.nodes[l.apexIndex]
    const chainCount = l.nodes.filter((n) => n.side !== 'ctx').length
    const r = chainCount <= 22 ? 2.6 : chainCount <= 44 ? 1.9 : 1.3 // size by the climb length, not total

    // edges first (under the nodes). Spine edges light with their child; faint (sibling) edges never do.
    for (const e of l.edges) {
      const a = l.nodes[e.from]
      const b = l.nodes[e.to]
      const line = svgEl('line', { x1: X(a.x), y1: Y(a.y), x2: X(b.x), y2: Y(b.y), stroke: e.faint ? FAINT : DIM, 'stroke-width': e.faint ? 0.7 : 1.1, 'stroke-linecap': 'round', class: 'elim-edge' })
      if (!reduce && !e.faint) line.style.transition = 'stroke 0.25s ease'
      svg.appendChild(line)
      edgeEls.push({ line, child: e.from, side: a.side, faint: !!e.faint })
    }

    // nodes — apex biggest, unsearched siblings (ctx) smallest + faint so the climbed path stands out.
    for (const n of l.nodes) {
      const isApex = n.side === 'apex'
      const isCtx = n.side === 'ctx'
      const c = svgEl('circle', { cx: X(n.x), cy: Y(n.y), r: isApex ? r + 1.4 : isCtx ? r * 0.6 : r, fill: isCtx ? FAINT : DIM, class: isApex ? 'elim-node elim-apex' : 'elim-node' })
      if (!reduce && !isCtx) c.style.transition = 'fill 0.25s ease'
      svg.appendChild(c)
      nodeEls.push(c)
    }

    // labels: From (green) at the s leaf, To (red) at the t leaf, apex at the top.
    const sLeaf = l.nodes[l.sLeafIndex]
    const tLeaf = l.nodes[l.tLeafIndex]
    const label = (x: number, y: number, fill: string, text: string): void => {
      const t = svgEl('text', { x, y, 'text-anchor': 'middle', class: 'elim-label', fill })
      t.textContent = text
      svg.appendChild(t)
    }
    label(X(sLeaf.x), VH - 5, S_COLOR, 'From')
    label(X(tLeaf.x), VH - 5, T_COLOR, 'To')
    label(X(apex.x), 9, APEX_COLOR, 'apex')

    // TRUE climb depth (the tree is sampled to a few rows, but we report the real numbers — honest).
    const sLen = l.climbS
    const tLen = l.climbT
    svg.setAttribute('aria-label', `Elimination tree for ${opts.algoName}: the search climbs ${sLen} steps from the start and ${tLen} from the destination, meeting at the apex, then unpacks back down to the route.`)
    title.textContent = `${opts.algoName} · elimination tree`
    setCap(`two searches climb ${sLen} & ${tLen} levels`)
    container.hidden = false
  }

  const descend = (): void => {
    if (!layout) return
    const maxDepth = layout.nodes[layout.apexIndex].depth || 1
    // Per-element delay keyed by depth → apex first, leaves last = a downward sweep, done purely in CSS.
    // Normalised to a FIXED total so a deep CCH tree (height ~160) sweeps in ~0.85 s, not seconds.
    const TOTAL_MS = 850
    const delay = (depth: number): string => (reduce ? '0ms' : `${Math.round((1 - depth / maxDepth) * TOTAL_MS)}ms`)
    layout.nodes.forEach((n, i) => {
      if (n.side === 'ctx') return // unsearched siblings stay faint — they're not part of the route
      nodeEls[i].style.transition = reduce ? 'none' : 'fill 0.3s ease'
      nodeEls[i].style.transitionDelay = delay(n.depth)
      nodeEls[i].style.fill = ROUTE_COLOR
    })
    for (const e of edgeEls) {
      if (e.faint) continue
      const depth = layout.nodes[e.child].depth
      e.line.style.transition = reduce ? 'none' : 'stroke 0.3s ease'
      e.line.style.transitionDelay = delay(depth)
      e.line.style.stroke = ROUTE_COLOR
    }
    nodeEls[layout.apexIndex].classList.remove('pulse')
  }

  const update = (s: RenderState): void => {
    if (!layout || phase === 'done') return

    // climb: light each chain node whose original id has been settled on its side.
    for (let i = 0; i < layout.nodes.length; i++) {
      if (lit[i]) continue
      const n = layout.nodes[i]
      if (n.side === 'apex' || n.side === 'ctx') continue // apex pulses separately; ctx siblings never light
      const on = n.side === 'f' ? s.settled.has(n.nodeId) : s.settledB.has(n.nodeId)
      if (on) {
        lit[i] = 1
        nodeEls[i].style.fill = n.side === 'f' ? S_COLOR : T_COLOR
      }
    }
    // a spine edge lights once its child node has been reached; faint sibling edges stay dim
    for (const e of edgeEls) {
      if (!e.faint && lit[e.child]) e.line.style.stroke = e.side === 'f' ? S_COLOR : T_COLOR
    }

    if (s.met && phase === 'climb') {
      phase = 'met'
      const apex = nodeEls[layout.apexIndex]
      apex.style.fill = APEX_COLOR
      if (!reduce) apex.classList.add('pulse')
      setCap('↑ the two searches meet at the apex')
    }
    if (s.done) {
      phase = 'done'
      descend()
      setCap('↓ unpacking shortcuts back to street level')
    }
  }

  return {
    show,
    update,
    hide() {
      container.hidden = true
      layout = null
    },
    dispose() {
      container.replaceChildren()
      container.remove()
    },
  }
}
