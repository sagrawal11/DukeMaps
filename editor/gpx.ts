// editor/gpx.ts — GPX import. Load a recorded walk, preview where it diverges from the existing
// graph (points more than THRESHOLD_M off any edge), and accept the divergent runs as new edges,
// snapping each run's graph-side anchors onto nearby existing nodes so the new path connects.
import type * as maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import type { EditorState } from './state'
import type { EditOp } from '../src/graph/edits'
import type { DivergencePoint } from '../src/graph/editing'
import { parseGpx, trackDivergence, snapToNearestNode } from '../src/graph/editing'

const THRESHOLD_M = 15 // beyond this from any edge, a track point counts as "diverged" (off-graph)
const SNAP_M = 15 // snap a run's anchor points onto an existing node within this radius
const GPX_SRC = 'gpx-preview'

// Contiguous runs of diverged point indices.
function divergedRuns(div: DivergencePoint[]): number[][] {
  const runs: number[][] = []
  let cur: number[] = []
  div.forEach((d, i) => {
    if (d.diverged) cur.push(i)
    else if (cur.length) {
      runs.push(cur)
      cur = []
    }
  })
  if (cur.length) runs.push(cur)
  return runs
}

// One LineString per track segment, flagged diverged if either endpoint is off-graph.
function previewFC(div: DivergencePoint[]): FeatureCollection {
  const features: Feature[] = []
  for (let i = 0; i < div.length - 1; i++) {
    features.push({
      type: 'Feature',
      properties: { diverged: div[i].diverged || div[i + 1].diverged },
      geometry: { type: 'LineString', coordinates: [div[i].point, div[i + 1].point] },
    })
  }
  return { type: 'FeatureCollection', features }
}

export function installGpx(map: maplibregl.Map, state: EditorState): void {
  map.addSource(GPX_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: GPX_SRC,
    type: 'line',
    source: GPX_SRC,
    paint: {
      'line-color': ['case', ['get', 'diverged'], '#e11d48', '#16a34a'], // red = off-graph, green = already on it
      'line-width': 4,
      'line-opacity': 0.85,
    },
  })

  const panel = document.getElementById('panel')!
  panel.insertAdjacentHTML(
    'beforeend',
    `<div style="margin-top:12px;border-top:1px solid #eee;padding-top:10px">
       <h3 style="font-size:14px;margin:0 0 6px">GPX import</h3>
       <input type="file" id="gpx-file" accept=".gpx,application/gpx+xml,text/xml" style="width:100%" />
       <p id="gpx-stats" style="color:#666;margin:6px 0 0"></p>
       <div style="display:flex;gap:4px;margin-top:6px">
         <button id="gpx-accept" disabled>Accept divergent runs as edges</button>
         <button id="gpx-clear" disabled>Clear</button>
       </div>
     </div>`,
  )
  const fileInput = document.getElementById('gpx-file') as HTMLInputElement
  const statsEl = document.getElementById('gpx-stats')!
  const acceptBtn = document.getElementById('gpx-accept') as HTMLButtonElement
  const clearBtn = document.getElementById('gpx-clear') as HTMLButtonElement

  let track: [number, number][] = []
  let divergence: DivergencePoint[] = []

  const setPreview = (data: FeatureCollection): void => {
    ;(map.getSource(GPX_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(data)
  }
  const clear = (): void => {
    track = []
    divergence = []
    setPreview({ type: 'FeatureCollection', features: [] })
    statsEl.textContent = ''
    acceptBtn.disabled = true
    clearBtn.disabled = true
    fileInput.value = ''
  }

  fileInput.onchange = () => {
    const file = fileInput.files?.[0]
    if (!file) return
    void file.text().then((xml) => {
      const tracks = parseGpx(xml)
      if (tracks.length === 0) {
        statsEl.textContent = 'No <trkpt> points found in that file.'
        return
      }
      // Use the longest segment (a recorded walk is usually one).
      track = tracks.reduce((a, b) => (b.length > a.length ? b : a))
      divergence = trackDivergence(track, state.graph, THRESHOLD_M)
      setPreview(previewFC(divergence))
      const diverged = divergence.filter((d) => d.diverged).length
      const maxOff = Math.max(...divergence.map((d) => (Number.isFinite(d.nearestDistM) ? d.nearestDistM : 0)))
      statsEl.innerHTML =
        `${track.length} points · <b style="color:#e11d48">${diverged} diverged</b> (> ${THRESHOLD_M} m off-graph) · ` +
        `max ${maxOff.toFixed(0)} m off` +
        (tracks.length > 1 ? ` · ${tracks.length} segments (using the longest)` : '')
      acceptBtn.disabled = diverged === 0
      clearBtn.disabled = false
    })
  }

  acceptBtn.onclick = () => {
    const ops: EditOp[] = []
    for (const run of divergedRuns(divergence)) {
      // Include the on-graph point just before and after the run as anchors, so the new path ties
      // back into the network.
      const idxs: number[] = []
      if (run[0] - 1 >= 0) idxs.push(run[0] - 1)
      idxs.push(...run)
      if (run[run.length - 1] + 1 < track.length) idxs.push(run[run.length - 1] + 1)

      const nodeIds: number[] = []
      for (const i of idxs) {
        const [lon, lat] = track[i]
        const snapped = snapToNearestNode(state.graph.nodes, lon, lat, SNAP_M)
        if (snapped) {
          nodeIds.push(snapped.id)
        } else {
          const id = state.newNodeId()
          ops.push({ op: 'add_node', id, lat, lon })
          nodeIds.push(id)
        }
      }
      for (let k = 0; k < nodeIds.length - 1; k++) {
        if (nodeIds[k] !== nodeIds[k + 1]) {
          ops.push({ op: 'add_edge', id: state.newEdgeId(), from: nodeIds[k], to: nodeIds[k + 1], kind: 'path' })
        }
      }
    }
    if (ops.length) state.commit(ops) // onChange re-renders the graph
    statsEl.textContent = `Accepted ${ops.filter((o) => o.op === 'add_edge').length} new edge(s).`
    clear()
  }
  clearBtn.onclick = () => clear()
}
