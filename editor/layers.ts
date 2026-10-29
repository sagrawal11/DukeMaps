// MapLibre sources + layers for the editor's graph view. CP1: edges colored by connected
// component (islands stand out, matching the app) + a nodes circle layer so every graph node is
// clickable later. Later checkpoints extend this with audit-mode paint swaps and a selection
// highlight layer; for now it just draws the merged graph.
import type * as maplibregl from 'maplibre-gl'
import type { Graph } from '../src/graph/types'
import type { Feature, FeatureCollection } from 'geojson'
import { graphToGeoJSON } from '../src/map/render'

export const EDGES_SRC = 'graph-edges'
export const NODES_SRC = 'graph-nodes'

// One Point feature per graph node. `mine` flags editor-created nodes (negative ids) so they can
// be drawn distinctly.
function nodesToGeoJSON(graph: Graph): FeatureCollection {
  const features: Feature[] = graph.nodes.map((n) => ({
    type: 'Feature',
    properties: { id: n.id, mine: n.id < 0 },
    geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
  }))
  return { type: 'FeatureCollection', features }
}

// Add the edge + node sources and layers. Call once after the map's `load` event.
export function addGraphLayers(map: maplibregl.Map, graph: Graph): void {
  map.addSource(EDGES_SRC, { type: 'geojson', data: graphToGeoJSON(graph) })
  map.addLayer({
    id: EDGES_SRC,
    type: 'line',
    source: EDGES_SRC,
    paint: {
      'line-color': ['get', 'color'],
      // Non-mainland islands drawn thicker so they stand out (same as the app).
      'line-width': ['case', ['get', 'isMain'], 1.6, 3],
      'line-opacity': 0.9,
    },
  })
  map.addSource(NODES_SRC, { type: 'geojson', data: nodesToGeoJSON(graph) })
  map.addLayer({
    id: NODES_SRC,
    type: 'circle',
    source: NODES_SRC,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 17, 4],
      'circle-color': ['case', ['get', 'mine'], '#d62728', '#334155'],
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#fff',
      'circle-opacity': 0.9,
    },
  })
}

// Re-push both sources after the graph changes (used from CP2 on).
export function updateGraphLayers(map: maplibregl.Map, graph: Graph): void {
  ;(map.getSource(EDGES_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(graphToGeoJSON(graph))
  ;(map.getSource(NODES_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(nodesToGeoJSON(graph))
}
