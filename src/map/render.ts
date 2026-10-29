// Turn a Graph into MapLibre-ready GeoJSON for the overlay. Each edge becomes a LineString
// tagged with its connected-component index + a color, so islands are visually distinct.
import type { Graph } from '../graph/types'
import { connectedComponents } from '../graph/validate'
import { missingAttrs } from '../graph/editing'
import type { Feature, FeatureCollection } from 'geojson'

const PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#bcbd22', '#17becf', '#aec7e8',
]

// Component 0 is the largest (the "mainland"); others cycle through the palette.
export const componentColor = (i: number): string => PALETTE[i % PALETTE.length]

export function graphToGeoJSON(graph: Graph): FeatureCollection {
  const { componentOf } = connectedComponents(graph)
  const features: Feature[] = graph.edges.map((e) => {
    const component = componentOf.get(e.from) ?? -1
    // requiresKey collapses the requires[] array into one discrete value a MapLibre `match` can key
    // on: '' = public, the single permission, or 'multi' for 2+. (You can't match on an array.)
    const requiresKey = e.requires.length === 0 ? '' : e.requires.length === 1 ? e.requires[0] : 'multi'
    return {
      type: 'Feature',
      properties: {
        id: e.id,
        kind: e.kind,
        source: e.source,
        component,
        color: componentColor(component),
        isMain: component === 0,
        requiresKey,
        stepFree: e.stepFree,
        missingAttrs: missingAttrs(e),
      },
      geometry: { type: 'LineString', coordinates: e.geometry },
    }
  })
  return { type: 'FeatureCollection', features }
}
