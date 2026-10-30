// The elimination-tree inset (SVG). Draws the two chains from the pure `layoutElimTree`, then animates
// them IN SYNC with the CH/CCH run by reading the player's RenderState every frame — no second timeline:
//   • a chain node lights the moment its id turns up in settled (forward, green) / settledB (back, red),
//   • the apex pulses once the two searches have met (RenderState.met),
//   • on done, the "symbolic descent" sweeps both chains green from the apex back down to s and t
//     (per-element transition-delay = a pure-CSS downward sweep) while the real route draws on the map.
// SVG (tens of nodes) is the right tool here vs the map's canvas (thousands); it's crisp + accessible
// and needs no map projection — the tree is abstract rank-space.
import type { RenderState } from './player'
import type { TreeLayout } from './elimtree'

const NS = 'http://www.w3.org/2000/svg'
const S_COLOR = '#2e9e5b' // forward / From (matches the map marker)
const T_COLOR = '#d64545' // backward / To
const APEX_COLOR = '#0b7285' // the design accent — the meeting node
const ROUTE_COLOR = '#1b7a37' // descent / final route green
const DIM = '#d2cfc6' // not-yet-reached (on the search path)
const FAINT = '#e8e5de' // unsearched sibling branches — just there for tree context

// viewBox coordinate space; layout's [0,1]^2 maps into it with padding for the labels.
const VW = 120
const VH = 132
const PAD_X = 9
const PAD_TOP = 15 // room for the apex label
const PAD_BOT = 15 // room for the From/To labels
const X = (x: number): number => PAD_X + x * (VW - 2 * PAD_X)
const Y = (y: number): number => PAD_TOP + y * (VH - PAD_TOP - PAD_BOT)

export interface ElimTreeView {
  show(layout: TreeLayout, opts: { algoName: string }): void
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

  const show = (l: TreeLayout, opts: { algoName: string }): void => {
    layout = l
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

    const sLen = l.nodes.filter((n) => n.side === 'f').length + 1
    const tLen = l.nodes.filter((n) => n.side === 'b').length + 1
    svg.setAttribute('aria-label', `Elimination tree for ${opts.algoName}: the search climbs ${sLen} steps from the start and ${tLen} from the destination, meeting at the apex, then unpacks back down to the route.`)
    title.textContent = `${opts.algoName} · elimination tree`
    setCap('two searches climb the hierarchy')
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
