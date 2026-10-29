// editor/inspector.ts — the edge inspector panel. Shown when one or more edges are selected; edits
// kind / step-free / hours and applies them to every selected edge as a single undo step (one
// update_edge op each). Tri-state "only change what you touch": kind and step-free default to
// "— keep —", and hours has an explicit "change" toggle, so an Apply never clobbers a field you
// didn't intend to set.
import type { EditorState } from './state'
import type { EdgeKind, GraphEdge, OpenInterval } from '../src/graph/types'
import type { EditOp } from '../src/graph/edits'

const KINDS: EdgeKind[] = [
  'sidewalk',
  'footway',
  'path',
  'stairs',
  'pedestrian',
  'service',
  'track',
  'indoor',
  'passage',
  'lawn',
  'unknown',
]

// Parse "07:00-23:00; 09:00-17:00" into open intervals. Empty → undefined (clears hours = always
// open). ponytail: basic HH:MM parse; Phase 3 owns the real time model.
function parseHours(s: string): OpenInterval[] | undefined {
  const out: OpenInterval[] = []
  for (const part of s.split(/[;,]/)) {
    const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(part)
    if (m) out.push({ start: m[1], end: m[2] })
  }
  return out.length ? out : undefined
}

export function installInspector(state: EditorState): { refresh: () => void } {
  const panel = document.getElementById('panel')!
  panel.insertAdjacentHTML(
    'beforeend',
    `<div id="inspector" style="display:none;margin-top:12px;border-top:1px solid #eee;padding-top:10px">
       <h3 style="font-size:14px;margin:0 0 6px">Edge inspector (<span id="insp-count">0</span> selected)</h3>
       <p id="insp-summary" style="color:#666;margin:0 0 8px"></p>
       <label style="display:block;margin-bottom:6px">Kind
         <select id="insp-kind" style="width:100%">
           <option value="__keep__">— keep —</option>
           ${KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}
         </select>
       </label>
       <label style="display:block;margin-bottom:6px">Step-free
         <select id="insp-step" style="width:100%">
           <option value="__keep__">— keep —</option>
           <option value="yes">step-free</option>
           <option value="no">not step-free</option>
         </select>
       </label>
       <label style="display:block;margin-bottom:6px"><input type="checkbox" id="insp-hours-change"> set hours
         <input id="insp-hours" placeholder="07:00-23:00; blank = always open" style="width:100%" />
       </label>
       <button id="insp-apply" style="width:100%;padding:6px">Apply to selected</button>
       <p id="insp-msg" style="color:#1a7f37;min-height:1.2em;margin:6px 0 0"></p>
     </div>`,
  )

  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
  const wrap = byId<HTMLDivElement>('inspector')
  const countEl = byId<HTMLSpanElement>('insp-count')
  const summaryEl = byId<HTMLParagraphElement>('insp-summary')
  const kindSel = byId<HTMLSelectElement>('insp-kind')
  const stepSel = byId<HTMLSelectElement>('insp-step')
  const hoursChange = byId<HTMLInputElement>('insp-hours-change')
  const hoursInput = byId<HTMLInputElement>('insp-hours')
  const msgEl = byId<HTMLParagraphElement>('insp-msg')

  const selectedEdges = (): GraphEdge[] =>
    [...state.selection.edges].map((id) => state.graph.edges.find((e) => e.id === id)).filter((e): e is GraphEdge => !!e)

  const refresh = (): void => {
    const edges = selectedEdges()
    if (edges.length === 0) {
      wrap.style.display = 'none'
      return
    }
    wrap.style.display = 'block'
    countEl.textContent = String(edges.length)
    // Reset controls to "no change".
    kindSel.value = '__keep__'
    stepSel.value = '__keep__'
    hoursChange.checked = false
    // Summary of current values (what a "keep" leaves untouched).
    const kinds = new Set(edges.map((e) => e.kind))
    const steps = new Set(edges.map((e) => e.stepFree))
    summaryEl.textContent =
      `kind: ${kinds.size === 1 ? [...kinds][0] : 'mixed'} · ` +
      `step-free: ${steps.size === 1 ? ([...steps][0] ? 'yes' : 'no') : 'mixed'}`
    msgEl.textContent = ''
  }

  byId<HTMLButtonElement>('insp-apply').onclick = () => {
    const ids = [...state.selection.edges]
    if (ids.length === 0) return
    const base: Partial<Pick<GraphEdge, 'kind' | 'stepFree' | 'hours'>> = {}
    if (kindSel.value !== '__keep__') base.kind = kindSel.value as EdgeKind
    if (stepSel.value !== '__keep__') base.stepFree = stepSel.value === 'yes'
    const hoursOn = hoursChange.checked
    if (Object.keys(base).length === 0 && !hoursOn) {
      msgEl.textContent = 'Nothing to change.'
      return
    }
    // Fresh set object (with a fresh hours array) per edge, so stored ops never alias.
    const action: EditOp[] = ids.map((id): EditOp => {
      const set: Partial<Pick<GraphEdge, 'kind' | 'stepFree' | 'hours'>> = { ...base }
      if (hoursOn) set.hours = parseHours(hoursInput.value)
      return { op: 'update_edge', id, set }
    })
    state.commit(action)
    msgEl.textContent = `Applied to ${ids.length} edge(s).`
  }

  return { refresh }
}
