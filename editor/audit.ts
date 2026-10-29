// editor/audit.ts — the audit view modes. Each mode recolors the edge layer by a different
// attribute (a cheap setPaintProperty swap on precomputed feature properties from graphToGeoJSON),
// so you can eyeball the graph by source, step-free status, connected component, or "missing
// attributes". Includes a dropdown (keys 1–4) and a swatch legend.
import type { ExpressionSpecification } from 'maplibre-gl'
import type * as maplibregl from 'maplibre-gl'
import { EDGES_SRC } from './layers'

export type AuditMode = 'component' | 'source' | 'stepFree' | 'missing'
export const AUDIT_ORDER: AuditMode[] = ['component', 'source', 'stepFree', 'missing']
const LABELS: Record<AuditMode, string> = {
  component: 'Connected component',
  source: 'Source (OSM / mine)',
  stepFree: 'Step-free',
  missing: 'Missing attributes',
}

const EXPR: Record<AuditMode, ExpressionSpecification> = {
  component: ['get', 'color'] as ExpressionSpecification, // color precomputed per component in graphToGeoJSON
  source: ['match', ['get', 'source'], 'osm', '#1f77b4', 'mine', '#d62728', '#999999'] as ExpressionSpecification,
  stepFree: ['case', ['get', 'stepFree'], '#2ca02c', '#ff7f0e'] as ExpressionSpecification,
  missing: ['case', ['get', 'missingAttrs'], '#e377c2', '#dddddd'] as ExpressionSpecification,
}

function legendItems(mode: AuditMode): { color: string; label: string }[] {
  switch (mode) {
    case 'component':
      return [
        { color: '#1f77b4', label: 'mainland (component 0)' },
        { color: '#ff7f0e', label: 'islands (drawn thick)' },
      ]
    case 'source':
      return [
        { color: '#1f77b4', label: 'OSM' },
        { color: '#d62728', label: 'mine' },
      ]
    case 'stepFree':
      return [
        { color: '#2ca02c', label: 'step-free' },
        { color: '#ff7f0e', label: 'not step-free' },
      ]
    case 'missing':
      return [
        { color: '#e377c2', label: 'flagged' },
        { color: '#dddddd', label: 'ok' },
      ]
  }
}

export function installAudit(map: maplibregl.Map): { setMode: (m: AuditMode) => void } {
  const panel = document.getElementById('panel')!
  panel.insertAdjacentHTML(
    'beforeend',
    `<div style="margin-top:12px;border-top:1px solid #eee;padding-top:10px">
       <label style="display:block">Audit view <kbd>1–4</kbd>
         <select id="audit-mode" style="width:100%">
           ${AUDIT_ORDER.map((m, i) => `<option value="${m}">${i + 1}. ${LABELS[m]}</option>`).join('')}
         </select>
       </label>
       <div id="audit-legend" style="margin-top:6px;font-size:12px"></div>
     </div>`,
  )
  const sel = document.getElementById('audit-mode') as HTMLSelectElement
  const legendEl = document.getElementById('audit-legend')!

  const setMode = (m: AuditMode): void => {
    sel.value = m
    map.setPaintProperty(EDGES_SRC, 'line-color', EXPR[m])
    legendEl.innerHTML = legendItems(m)
      .map(
        (x) =>
          `<span style="display:inline-flex;align-items:center;gap:4px;margin:0 8px 4px 0">` +
          `<span style="width:12px;height:12px;background:${x.color};display:inline-block;border:1px solid #ccc"></span>${x.label}</span>`,
      )
      .join('')
  }
  sel.onchange = () => setMode(sel.value as AuditMode)
  setMode('component') // default
  return { setMode }
}
