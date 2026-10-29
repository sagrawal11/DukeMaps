// editor/inspector.ts — the edge inspector panel. Shown when one or more edges are selected; edits
// kind / step-free / requires (permissions) / hours and applies them to every selected edge as a
// single undo step (one update_edge op each). Tri-state "only change what you touch": kind and
// step-free default to "— keep —", and requires/hours each have an explicit "change" toggle, so an
// Apply never clobbers a field you didn't intend to set. Permission choices come from
// config/access.json (the brief's source of truth for access rules).
import access from '../config/access.json'
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
const PERMS: string[] = access.permissions

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
       <fieldset style="margin:0 0 6px;border:1px solid #eee;padding:6px">
         <legend><label><input type="checkbox" id="insp-req-change"> set permissions (requires)</label></legend>
         <div id="insp-perms">${PERMS.map(
           (p) => `<label style="display:block"><input type="checkbox" data-perm="${p}"> ${p}</label>`,
         ).join('')}</div>
       </fieldset>
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
  const reqChange = byId<HTMLInputElement>('insp-req-change')
  const hoursChange = byId<HTMLInputElement>('insp-hours-change')
  const hoursInput = byId<HTMLInputElement>('insp-hours')
  const msgEl = byId<HTMLParagraphElement>('insp-msg')
  const permBoxes = new Map<string, HTMLInputElement>()
  for (const b of wrap.querySelectorAll<HTMLInputElement>('[data-perm]')) permBoxes.set(b.dataset.perm!, b)

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
    reqChange.checked = false
    hoursChange.checked = false
    // Initialise permission checkboxes to the common state (checked if ALL selected edges require it).
    for (const [p, box] of permBoxes) box.checked = edges.every((e) => e.requires.includes(p))
    // Summary of current values (what a "keep" leaves untouched).
    const kinds = new Set(edges.map((e) => e.kind))
    const steps = new Set(edges.map((e) => e.stepFree))
    const reqs = new Set(edges.map((e) => [...e.requires].sort().join(',') || '(public)'))
    summaryEl.textContent =
      `kind: ${kinds.size === 1 ? [...kinds][0] : 'mixed'} · ` +
      `step-free: ${steps.size === 1 ? ([...steps][0] ? 'yes' : 'no') : 'mixed'} · ` +
      `requires: ${reqs.size === 1 ? [...reqs][0] : 'mixed'}`
    msgEl.textContent = ''
  }

  byId<HTMLButtonElement>('insp-apply').onclick = () => {
    const ids = [...state.selection.edges]
    if (ids.length === 0) return
    const base: Partial<Pick<GraphEdge, 'kind' | 'requires' | 'stepFree' | 'hours'>> = {}
    if (kindSel.value !== '__keep__') base.kind = kindSel.value as EdgeKind
    if (stepSel.value !== '__keep__') base.stepFree = stepSel.value === 'yes'
    const reqOn = reqChange.checked
    const hoursOn = hoursChange.checked
    if (Object.keys(base).length === 0 && !reqOn && !hoursOn) {
      msgEl.textContent = 'Nothing to change.'
      return
    }
    // Fresh set object (with fresh arrays) per edge, so stored ops never alias.
    const action: EditOp[] = ids.map((id): EditOp => {
      const set: Partial<Pick<GraphEdge, 'kind' | 'requires' | 'stepFree' | 'hours'>> = { ...base }
      if (reqOn) set.requires = [...permBoxes].filter(([, b]) => b.checked).map(([p]) => p)
      if (hoursOn) set.hours = parseHours(hoursInput.value)
      return { op: 'update_edge', id, set }
    })
    state.commit(action)
    msgEl.textContent = `Applied to ${ids.length} edge(s).`
  }

  return { refresh }
}
