// editor/tools.ts — the editor's interaction layer: toolbar, keyboard shortcuts, and the
// single-active-tool state machine. Tools emit EditOps through EditorState (which recomputes the
// merged graph, autosaves, and fires onChange). Static display + hit-testing use MapLibre layers;
// transient drag feedback (rubber-band, move ghost, marquee box) uses the canvas Overlay, scoped
// to one mousedown→mouseup gesture with dragPan disabled so it can't desync during a pan.
import type * as maplibregl from 'maplibre-gl'
import type { EditorState, Tool } from './state'
import { emptySelection } from './state'
import type { Overlay } from './overlay'
import type { EditOp } from '../src/graph/edits'
import { splitEdgeOps } from '../src/graph/editing'
import { installInspector } from './inspector'
import { updateGraphLayers, setSelection, NODES_SRC, EDGES_SRC } from './layers'

type Gesture =
  | { type: 'draw-edge'; fromId: number; fromPx: [number, number] }
  | { type: 'move-node'; id: number; otherEnds: [number, number][] }
  | { type: 'marquee'; start: [number, number] }

const HINTS: Record<Tool, string> = {
  select: 'Click selects (replaces); Shift-click toggles; Shift-drag box-selects. Delete removes. Drag empty space to pan.',
  'add-node': 'Click the map to drop a node.',
  'draw-edge':
    'Press on a node, drag to another node, release. Release on empty space to create a new node. Snaps to nearby nodes.',
  'split-edge': 'Click an edge to split it at that point (inserts a node).',
  'move-node': 'Drag a node to move it — its edges follow. Drag empty space to pan.',
}
const CURSORS: Record<Tool, string> = {
  select: '',
  'add-node': 'crosshair',
  'draw-edge': 'crosshair',
  'split-edge': 'crosshair',
  'move-node': 'move',
}

export function installTools(map: maplibregl.Map, state: EditorState, overlay: Overlay): void {
  const container = map.getCanvasContainer()
  let gesture: Gesture | null = null
  const inspector = installInspector(state)

  // ---- geometry / hit-testing helpers ----
  const containerXY = (ev: MouseEvent): [number, number] => {
    const r = container.getBoundingClientRect()
    return [ev.clientX - r.left, ev.clientY - r.top]
  }
  const nodePx = (id: number): [number, number] => {
    const n = state.nodeIndex.get(id)!
    const p = map.project([n.lon, n.lat])
    return [p.x, p.y]
  }
  const boxAround = (px: [number, number], r: number): [[number, number], [number, number]] => [
    [px[0] - r, px[1] - r],
    [px[0] + r, px[1] + r],
  ]
  // Nearest node within a pixel box to the cursor (small circles → a box + nearest-to-cursor is the
  // robust pick, and doubles as the snap test).
  const nearestNode = (px: [number, number], radius = 10): number | null => {
    const feats = map.queryRenderedFeatures(boxAround(px, radius), { layers: [NODES_SRC] })
    let best: number | null = null
    let bestD = Infinity
    for (const f of feats) {
      const g = f.geometry
      if (g.type !== 'Point') continue
      const id = f.properties?.id as number
      const p = map.project([g.coordinates[0], g.coordinates[1]] as [number, number])
      const d = (p.x - px[0]) ** 2 + (p.y - px[1]) ** 2
      if (d < bestD) {
        bestD = d
        best = id
      }
    }
    return best
  }
  const nearestEdge = (px: [number, number], radius = 5): string | null => {
    const feats = map.queryRenderedFeatures(boxAround(px, radius), { layers: [EDGES_SRC] })
    return feats.length ? (feats[0].properties?.id as string) : null
  }
  const idsInBox = (layer: string, a: [number, number], b: [number, number]): unknown[] => {
    const min: [number, number] = [Math.min(a[0], b[0]), Math.min(a[1], b[1])]
    const max: [number, number] = [Math.max(a[0], b[0]), Math.max(a[1], b[1])]
    return map.queryRenderedFeatures([min, max], { layers: [layer] }).map((f) => f.properties?.id)
  }

  // ---- toolbar DOM ----
  const panel = document.getElementById('panel')!
  panel.insertAdjacentHTML(
    'beforeend',
    `<div style="margin-top:12px;border-top:1px solid #eee;padding-top:10px">
       <div style="display:flex;flex-wrap:wrap;gap:4px">
         <button data-tool="select">Select <kbd>V</kbd></button>
         <button data-tool="add-node">Add node <kbd>N</kbd></button>
         <button data-tool="draw-edge">Draw edge <kbd>E</kbd></button>
         <button data-tool="split-edge">Split <kbd>S</kbd></button>
         <button data-tool="move-node">Move <kbd>M</kbd></button>
       </div>
       <div style="display:flex;gap:4px;margin-top:6px">
         <button id="t-undo">Undo <kbd>⌘Z</kbd></button>
         <button id="t-redo">Redo <kbd>⇧⌘Z</kbd></button>
         <button id="t-del">Delete <kbd>⌫</kbd></button>
       </div>
       <p id="t-hint" style="color:#555;margin:8px 0 0"></p>
       <p id="t-sel" style="color:#333;margin:4px 0 0;min-height:1.2em"></p>
     </div>`,
  )
  const toolButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-tool]'))
  const undoBtn = document.getElementById('t-undo') as HTMLButtonElement
  const redoBtn = document.getElementById('t-redo') as HTMLButtonElement
  const delBtn = document.getElementById('t-del') as HTMLButtonElement
  const hintEl = document.getElementById('t-hint')!
  const selEl = document.getElementById('t-sel')!
  const statusEl = document.getElementById('status')!

  const updateUI = (): void => {
    for (const b of toolButtons) b.style.fontWeight = b.dataset.tool === state.tool ? '700' : '400'
    undoBtn.disabled = !state.canUndo()
    redoBtn.disabled = !state.canRedo()
    const nSel = state.selection.nodes.size
    const eSel = state.selection.edges.size
    delBtn.disabled = nSel + eSel === 0
    hintEl.textContent = HINTS[state.tool]
    statusEl.innerHTML =
      `<b>${state.graph.edges.length.toLocaleString()} edges · ${state.graph.nodes.length.toLocaleString()} nodes</b>` +
      ` <span style="color:#888">· ${state.editCount()} edit(s) this session</span>`
    selEl.textContent = nSel + eSel ? `${nSel} node(s), ${eSel} edge(s) selected` : ''
    container.style.cursor = CURSORS[state.tool]
  }

  // The single render path: re-push graph data, update selection filters, refresh inspector + panel.
  const render = (): void => {
    updateGraphLayers(map, state.graph)
    setSelection(map, state.selection)
    inspector.refresh()
    updateUI()
  }
  state.onChange = render // commit/undo/redo call this

  // ---- gesture lifecycle ----
  const onMove = (ev: MouseEvent): void => {
    if (!gesture) return
    const px = containerXY(ev)
    overlay.clear()
    if (gesture.type === 'draw-edge') {
      const snap = nearestNode(px)
      const snapped = snap != null && snap !== gesture.fromId
      const end = snapped ? nodePx(snap) : px
      overlay.line(gesture.fromPx, end, '#d62728', 2, true)
      overlay.dot(gesture.fromPx, 4, '#d62728')
      if (snapped) overlay.ring(end, 8, '#d62728')
    } else if (gesture.type === 'move-node') {
      for (const ll of gesture.otherEnds) {
        const p = map.project(ll)
        overlay.line([p.x, p.y], px, '#d62728', 1.5, true)
      }
      overlay.dot(px, 5, '#d62728')
    } else {
      const [x0, y0] = gesture.start
      const [x1, y1] = px
      overlay.line([x0, y0], [x1, y0], '#2563eb', 1.5)
      overlay.line([x1, y0], [x1, y1], '#2563eb', 1.5)
      overlay.line([x1, y1], [x0, y1], '#2563eb', 1.5)
      overlay.line([x0, y1], [x0, y0], '#2563eb', 1.5)
    }
  }
  const cancelGesture = (): void => {
    if (!gesture) return
    gesture = null
    overlay.clear()
    map.dragPan.enable()
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  function onUp(ev: MouseEvent): void {
    if (!gesture) return
    const g = gesture
    cancelGesture()
    const px = containerXY(ev)
    if (g.type === 'draw-edge') {
      const action: EditOp[] = []
      const snap = nearestNode(px)
      let toId: number
      if (snap != null) {
        toId = snap
      } else {
        const ll = map.unproject(px)
        toId = state.newNodeId()
        action.push({ op: 'add_node', id: toId, lat: ll.lat, lon: ll.lng })
      }
      if (toId !== g.fromId) {
        const edgeId = state.newEdgeId()
        action.push({ op: 'add_edge', id: edgeId, from: g.fromId, to: toId, kind: 'path' })
        state.commit(action)
        state.selection = { nodes: new Set(), edges: new Set([edgeId]) }
      }
    } else if (g.type === 'move-node') {
      const ll = map.unproject(px)
      state.commit([{ op: 'move_node', id: g.id, lat: ll.lat, lon: ll.lng }])
    } else {
      // marquee: tiny box = toggle a single feature; a real box = add everything inside it
      const dx = Math.abs(px[0] - g.start[0])
      const dy = Math.abs(px[1] - g.start[1])
      if (dx < 4 && dy < 4) {
        const nid = nearestNode(px)
        if (nid != null) toggle(state.selection.nodes, nid)
        else {
          const eid = nearestEdge(px)
          if (eid != null) toggle(state.selection.edges, eid)
        }
      } else {
        for (const id of idsInBox(NODES_SRC, g.start, px)) state.selection.nodes.add(id as number)
        for (const id of idsInBox(EDGES_SRC, g.start, px)) state.selection.edges.add(id as string)
      }
    }
    render()
  }
  function toggle<T>(set: Set<T>, v: T): void {
    if (set.has(v)) set.delete(v)
    else set.add(v)
  }

  // ---- tool switching + delete ----
  const setTool = (t: Tool): void => {
    cancelGesture()
    state.tool = t
    render()
  }
  const deleteSelection = (): void => {
    const { nodes, edges } = state.selection
    if (nodes.size + edges.size === 0) return
    const action: EditOp[] = []
    const dropped = new Set<string>()
    for (const id of edges) {
      action.push({ op: 'delete_edge', id })
      dropped.add(id)
    }
    // Deleting a node cascades its incident edges (deduped), all in one atomic undo step.
    for (const nid of nodes) {
      for (const e of state.graph.edges) {
        if ((e.from === nid || e.to === nid) && !dropped.has(e.id)) {
          action.push({ op: 'delete_edge', id: e.id })
          dropped.add(e.id)
        }
      }
      action.push({ op: 'delete_node', id: nid })
    }
    state.commit(action)
    state.selection = emptySelection()
    render()
  }

  // ---- wiring: buttons ----
  for (const b of toolButtons) b.onclick = () => setTool(b.dataset.tool as Tool)
  undoBtn.onclick = () => state.undo()
  redoBtn.onclick = () => state.redoAction()
  delBtn.onclick = () => deleteSelection()

  // ---- wiring: click = add-node / split / plain select (shift handled by the marquee path) ----
  map.on('click', (e) => {
    const px: [number, number] = [e.point.x, e.point.y]
    if (state.tool === 'add-node') {
      const id = state.newNodeId()
      state.commit([{ op: 'add_node', id, lat: e.lngLat.lat, lon: e.lngLat.lng }])
      state.selection = { nodes: new Set([id]), edges: new Set() }
      render()
    } else if (state.tool === 'split-edge') {
      const eid = nearestEdge(px)
      const edge = eid != null ? state.graph.edges.find((x) => x.id === eid) : undefined
      if (!edge) return
      const r = splitEdgeOps(edge, [e.lngLat.lng, e.lngLat.lat], state.newNodeId(), state.newEdgeId(), state.newEdgeId())
      if ('ops' in r) {
        state.commit(r.ops)
        state.selection = emptySelection()
        render()
      } else {
        hintEl.textContent = `⚠ ${r.error}`
      }
    } else if (state.tool === 'select' && !e.originalEvent.shiftKey) {
      const nid = nearestNode(px)
      if (nid != null) state.selection = { nodes: new Set([nid]), edges: new Set() }
      else {
        const eid = nearestEdge(px)
        state.selection = eid != null ? { nodes: new Set(), edges: new Set([eid]) } : emptySelection()
      }
      render()
    }
  })

  // ---- wiring: mousedown = start a gesture (draw/move on a node, or shift-marquee in select) ----
  container.addEventListener('mousedown', (ev: MouseEvent) => {
    if (ev.button !== 0) return
    const px = containerXY(ev)
    if (state.tool === 'draw-edge' || state.tool === 'move-node') {
      const nid = nearestNode(px)
      if (nid == null) return // not on a node → let the map pan
      ev.preventDefault()
      if (state.tool === 'draw-edge') {
        gesture = { type: 'draw-edge', fromId: nid, fromPx: nodePx(nid) }
      } else {
        const otherEnds: [number, number][] = []
        for (const e of state.graph.edges) {
          const far = e.from === nid ? e.to : e.to === nid ? e.from : null
          if (far == null) continue
          const n = state.nodeIndex.get(far)
          if (n) otherEnds.push([n.lon, n.lat])
        }
        gesture = { type: 'move-node', id: nid, otherEnds }
      }
    } else if (state.tool === 'select' && ev.shiftKey) {
      ev.preventDefault()
      gesture = { type: 'marquee', start: px }
    } else {
      return // let the map pan
    }
    map.dragPan.disable()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  // ---- wiring: keyboard ----
  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    const t = ev.target
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return
    const mod = ev.metaKey || ev.ctrlKey
    if (mod && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault()
      if (ev.shiftKey) state.redoAction()
      else state.undo()
      return
    }
    if (mod && (ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault()
      state.redoAction()
      return
    }
    switch (ev.key) {
      case 'v':
      case 'V':
        setTool('select')
        break
      case 'n':
      case 'N':
        setTool('add-node')
        break
      case 'e':
      case 'E':
        setTool('draw-edge')
        break
      case 's':
      case 'S':
        setTool('split-edge')
        break
      case 'm':
      case 'M':
        setTool('move-node')
        break
      case 'Delete':
      case 'Backspace':
        ev.preventDefault()
        deleteSelection()
        break
      case 'Escape':
        cancelGesture()
        state.selection = emptySelection()
        setTool('select')
        break
    }
  })

  render() // initial paint
}
