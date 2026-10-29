// editor/tools.ts — the editor's interaction layer: toolbar, keyboard shortcuts, and the
// single-active-tool state machine. Tools emit EditOps through EditorState (which recomputes the
// merged graph, autosaves, and fires onChange). Static display + hit-testing use MapLibre layers;
// transient drag feedback uses the canvas Overlay, scoped to a single mousedown→mouseup gesture
// with dragPan disabled (so it can't desync during a pan).
import type * as maplibregl from 'maplibre-gl'
import type { EditorState, Tool } from './state'
import type { Overlay } from './overlay'
import type { EditOp } from '../src/graph/edits'
import { updateGraphLayers, setSelection, NODES_SRC, EDGES_SRC } from './layers'

type Gesture =
  | { type: 'draw-edge'; fromId: number; fromPx: [number, number] }
  | { type: 'move-node'; id: number; otherEnds: [number, number][] }

const HINTS: Record<Tool, string> = {
  select: 'Click a node or edge to select it; Delete removes it. Drag to pan.',
  'add-node': 'Click the map to drop a node.',
  'draw-edge':
    'Press on a node, drag to another node, release. Release on empty space to create a new node. Snaps to nearby nodes.',
  'move-node': 'Drag a node to move it — its edges follow. Drag empty space to pan.',
}
const CURSORS: Record<Tool, string> = { select: '', 'add-node': 'crosshair', 'draw-edge': 'crosshair', 'move-node': 'move' }

export function installTools(map: maplibregl.Map, state: EditorState, overlay: Overlay): void {
  const container = map.getCanvasContainer()
  let gesture: Gesture | null = null

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
  // Nearest node within a pixel box to the cursor (circles are small, so a point query is
  // unreliable — a box + nearest-to-cursor is the robust pick, and doubles as the snap test).
  const nearestNode = (px: [number, number], radius = 10): number | null => {
    const box: [[number, number], [number, number]] = [
      [px[0] - radius, px[1] - radius],
      [px[0] + radius, px[1] + radius],
    ]
    const feats = map.queryRenderedFeatures(box, { layers: [NODES_SRC] })
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
    const box: [[number, number], [number, number]] = [
      [px[0] - radius, px[1] - radius],
      [px[0] + radius, px[1] + radius],
    ]
    const feats = map.queryRenderedFeatures(box, { layers: [EDGES_SRC] })
    return feats.length ? (feats[0].properties?.id as string) : null
  }

  // ---- toolbar DOM (appended under the existing intro/status in #panel) ----
  const panel = document.getElementById('panel')!
  panel.insertAdjacentHTML(
    'beforeend',
    `<div style="margin-top:12px;border-top:1px solid #eee;padding-top:10px">
       <div style="display:flex;flex-wrap:wrap;gap:4px">
         <button data-tool="select">Select <kbd>V</kbd></button>
         <button data-tool="add-node">Add node <kbd>N</kbd></button>
         <button data-tool="draw-edge">Draw edge <kbd>E</kbd></button>
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

  const describeSelection = (): string => {
    const sel = state.selection
    if (!sel) return ''
    if (sel.kind === 'node') return `Selected node ${sel.id}${sel.id < 0 ? ' (mine)' : ''}`
    const e = state.graph.edges.find((x) => x.id === sel.id)
    return e ? `Selected edge ${sel.id} · ${e.kind}${e.source === 'mine' ? ' (mine)' : ''}` : `Selected edge ${sel.id}`
  }
  const updateUI = (): void => {
    for (const b of toolButtons) b.style.fontWeight = b.dataset.tool === state.tool ? '700' : '400'
    undoBtn.disabled = !state.canUndo()
    redoBtn.disabled = !state.canRedo()
    delBtn.disabled = !state.selection
    hintEl.textContent = HINTS[state.tool]
    statusEl.innerHTML =
      `<b>${state.graph.edges.length.toLocaleString()} edges · ${state.graph.nodes.length.toLocaleString()} nodes</b>` +
      ` <span style="color:#888">· ${state.editCount()} edit(s) this session</span>`
    selEl.textContent = describeSelection()
    container.style.cursor = CURSORS[state.tool]
  }

  // The single render path: re-push graph data, update the selection filter, refresh the panel.
  const render = (): void => {
    updateGraphLayers(map, state.graph)
    setSelection(map, state.selection)
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
    } else {
      for (const ll of gesture.otherEnds) {
        const p = map.project(ll)
        overlay.line([p.x, p.y], px, '#d62728', 1.5, true)
      }
      overlay.dot(px, 5, '#d62728')
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
        state.selection = { kind: 'edge', id: edgeId }
      }
    } else {
      const ll = map.unproject(px)
      state.commit([{ op: 'move_node', id: g.id, lat: ll.lat, lon: ll.lng }])
    }
    render()
  }

  // ---- tool switching + delete ----
  const setTool = (t: Tool): void => {
    cancelGesture()
    state.tool = t
    render()
  }
  const deleteSelection = (): void => {
    const sel = state.selection
    if (!sel) return
    if (sel.kind === 'edge') {
      state.commit([{ op: 'delete_edge', id: sel.id }])
    } else {
      // Deleting a node cascades its incident edges, all in one atomic (one-undo) action — so no
      // orphan edges are left referencing a missing node.
      const action: EditOp[] = state.graph.edges
        .filter((e) => e.from === sel.id || e.to === sel.id)
        .map((e): EditOp => ({ op: 'delete_edge', id: e.id }))
      action.push({ op: 'delete_node', id: sel.id })
      state.commit(action)
    }
    state.selection = null
    render()
  }

  // ---- wiring: buttons ----
  for (const b of toolButtons) b.onclick = () => setTool(b.dataset.tool as Tool)
  undoBtn.onclick = () => state.undo()
  redoBtn.onclick = () => state.redoAction()
  delBtn.onclick = () => deleteSelection()

  // ---- wiring: click = add-node / select (dragPan stays on, so empty-drag still pans) ----
  map.on('click', (e) => {
    const px: [number, number] = [e.point.x, e.point.y]
    if (state.tool === 'add-node') {
      const id = state.newNodeId()
      state.commit([{ op: 'add_node', id, lat: e.lngLat.lat, lon: e.lngLat.lng }])
      state.selection = { kind: 'node', id }
      render()
    } else if (state.tool === 'select') {
      const nid = nearestNode(px)
      if (nid != null) state.selection = { kind: 'node', id: nid }
      else {
        const eid = nearestEdge(px)
        state.selection = eid != null ? { kind: 'edge', id: eid } : null
      }
      render()
    }
  })

  // ---- wiring: mousedown = start a draw-edge / move-node gesture (only when pressing a node) ----
  container.addEventListener('mousedown', (ev: MouseEvent) => {
    if (ev.button !== 0) return
    if (state.tool !== 'draw-edge' && state.tool !== 'move-node') return
    const px = containerXY(ev)
    const nid = nearestNode(px)
    if (nid == null) return // not on a node → let the map pan
    ev.preventDefault()
    if (state.tool === 'draw-edge') {
      gesture = { type: 'draw-edge', fromId: nid, fromPx: nodePx(nid) }
    } else {
      // Precompute incident edges' far endpoints so the move ghost is cheap per mousemove frame.
      const otherEnds: [number, number][] = []
      for (const e of state.graph.edges) {
        const far = e.from === nid ? e.to : e.to === nid ? e.from : null
        if (far == null) continue
        const n = state.nodeIndex.get(far)
        if (n) otherEnds.push([n.lon, n.lat])
      }
      gesture = { type: 'move-node', id: nid, otherEnds }
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
        state.selection = null
        setTool('select')
        break
    }
  })

  render() // initial paint
}
