// editor/state.ts — the editor's data model, independent of DOM/MapLibre.
//
// The edit log is the single source of truth. `baseline` is the log loaded from disk (this
// session never undoes past it, so you can't accidentally wipe earlier work); `actions` are this
// session's edits, each an atomic group of EditOps = one undo step. The displayed graph is
// applyEdits(base, baseline + actions.flat()) — the same function build:graph uses, so what the
// editor shows is what the build produces. The full log autosaves (debounced) to data/my_edits.json.
import type { Graph, GraphNode } from '../src/graph/types'
import type { EditOp } from '../src/graph/edits'
import { applyEdits } from '../src/graph/edits'

export type Tool = 'select' | 'add-node' | 'draw-edge' | 'move-node'
export type Selection = { kind: 'node'; id: number } | { kind: 'edge'; id: string } | null

export class EditorState {
  readonly base: Graph
  baseline: EditOp[]
  actions: EditOp[][] = []
  redo: EditOp[][] = []
  graph: Graph
  nodeIndex: Map<number, GraphNode>
  tool: Tool = 'select'
  selection: Selection = null
  onChange: () => void = () => {}

  private nextNodeId: number
  private nextEdgeSeq: number
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(base: Graph, loaded: EditOp[]) {
    this.base = base
    this.baseline = loaded
    // Seed id counters below/above anything already in the loaded log so new ids never collide.
    // Editor-created nodes use negative ids; editor edges use "mine:<seq>".
    let nextNode = -1
    let nextSeq = 0
    for (const op of loaded) {
      if (op.op === 'add_node') nextNode = Math.min(nextNode, op.id - 1)
      if (op.op === 'add_edge') {
        const m = /^mine:(\d+)$/.exec(op.id)
        if (m) nextSeq = Math.max(nextSeq, Number(m[1]) + 1)
      }
    }
    this.nextNodeId = nextNode
    this.nextEdgeSeq = nextSeq
    this.graph = applyEdits(base, this.log()).graph
    this.nodeIndex = this.indexNodes()
  }

  log(): EditOp[] {
    return [...this.baseline, ...this.actions.flat()]
  }

  newNodeId(): number {
    return this.nextNodeId--
  }
  newEdgeId(): string {
    return `mine:${this.nextEdgeSeq++}`
  }

  // Record one user action (1+ ops) as a single undo step.
  commit(action: EditOp[]): void {
    if (action.length === 0) return
    this.actions.push(action)
    this.redo = [] // a new action invalidates the redo stack
    this.refresh()
  }

  undo(): void {
    const a = this.actions.pop()
    if (!a) return
    this.redo.push(a)
    this.refresh()
  }

  redoAction(): void {
    const a = this.redo.pop()
    if (!a) return
    this.actions.push(a) // replayed verbatim — stored ids are reused, so refs never dangle
    this.refresh()
  }

  canUndo(): boolean {
    return this.actions.length > 0
  }
  canRedo(): boolean {
    return this.redo.length > 0
  }
  editCount(): number {
    return this.actions.length
  }

  private indexNodes(): Map<number, GraphNode> {
    return new Map(this.graph.nodes.map((n) => [n.id, n]))
  }

  private refresh(): void {
    this.graph = applyEdits(this.base, this.log()).graph
    this.nodeIndex = this.indexNodes()
    this.onChange()
    this.scheduleSave()
  }

  // Debounced POST of the whole log; the dev server writes it atomically to data/my_edits.json.
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void fetch('/__edits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.log()),
      }).catch((e: unknown) => console.error('[editor] autosave failed:', e))
    }, 400)
  }
}
