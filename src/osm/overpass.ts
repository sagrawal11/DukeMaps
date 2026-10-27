// OpenStreetMap Overpass types, query builder, and tag classifiers. Kept separate from the
// network call (scripts/fetch.ts) and the graph builder (src/graph/build.ts) so the query
// shape and tag mapping are unit-testable.
import type { Area, EdgeKind } from '../graph/types'

export interface OsmTags {
  [key: string]: string
}
export interface OsmNode {
  type: 'node'
  id: number
  lat: number
  lon: number
  tags?: OsmTags
}
export interface OsmWay {
  type: 'way'
  id: number
  nodes: number[]
  tags?: OsmTags
}
export interface OsmRelation {
  type: 'relation'
  id: number
  members: { type: string; ref: number; role: string }[]
  tags?: OsmTags
}
export type OsmElement = OsmNode | OsmWay | OsmRelation
export interface OsmResponse {
  elements: OsmElement[]
}

export interface AreaBBox {
  area: Area
  bbox: [number, number, number, number] // [south, west, north, east] (for OSM fetch)
  polygon?: [number, number][] // optional [lon, lat] ring for precise area tagging
}

// highway=* values that are walkable on campus. Shared with the graph builder.
export const WALKABLE_HIGHWAY = [
  'footway',
  'path',
  'steps',
  'pedestrian',
  'living_street',
  'cycleway',
  'track',
  'service',
  'residential',
  'unclassified',
  'tertiary',
  'corridor',
]

// Overpass QL query: for every area bbox, pull walkable ways, indoor corridors, crossing
// nodes, and named buildings; then recurse to each way's member nodes so we get coordinates.
export function buildOverpassQuery(areas: AreaBBox[]): string {
  const hw = WALKABLE_HIGHWAY.join('|')
  const clauses = areas
    .map(({ bbox: [s, w, n, e] }) => {
      const b = `(${s},${w},${n},${e})`
      return [
        `  way["highway"~"^(${hw})$"]${b};`,
        `  way["indoor"="corridor"]${b};`,
        `  node["highway"="crossing"]${b};`,
        `  way["building"]["name"]${b};`,
      ].join('\n')
    })
    .join('\n')
  return `[out:json][timeout:90];
(
${clauses}
);
out body;
>;
out skel qt;
`
}

// Map OSM tags to our edge kind.
export function kindFromTags(tags: OsmTags = {}): EdgeKind {
  if (tags.indoor === 'corridor' || tags.highway === 'corridor') return 'indoor'
  switch (tags.highway) {
    case 'steps':
      return 'stairs'
    case 'footway':
      return tags.footway === 'sidewalk' ? 'sidewalk' : 'footway'
    case 'path':
      return 'path'
    case 'pedestrian':
    case 'living_street':
      return 'pedestrian'
    case 'service':
    case 'residential':
    case 'unclassified':
    case 'tertiary':
      return 'service'
    case 'track':
      return 'track'
    default:
      return 'unknown'
  }
}

// Whether an edge is traversable without steps.
export function stepFreeFromTags(tags: OsmTags = {}): boolean {
  if (tags.highway === 'steps') return false
  if (tags.wheelchair === 'no') return false
  return true
}
