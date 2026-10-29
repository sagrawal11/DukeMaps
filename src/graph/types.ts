// Core graph data model. The brief's edge schema lives here; every algorithm in Phase 5
// runs on this Graph, and the pipeline (fetch -> build -> edits -> validate) produces it.

export type Area = 'west' | 'east' | 'athletic' | 'hospital'

export type EdgeKind =
  | 'sidewalk'
  | 'footway'
  | 'path'
  | 'stairs'
  | 'pedestrian'
  | 'service'
  | 'track'
  | 'indoor'
  | 'passage'
  | 'lawn'
  | 'unknown'

// Optional open interval for an edge (Phase 3 time-dependent routing extends this).
// Minimal for now: local 24-hour "HH:MM" start/end.
export interface OpenInterval {
  start: string
  end: string
}

export interface GraphNode {
  id: number // OSM node id; nodes I create in the editor use negative ids
  lat: number
  lon: number
}

export interface GraphEdge {
  id: string // deterministic: "<wayId>:<segIndex>" for OSM, "mine:<n>" for my edits
  source: 'osm' | 'mine'
  from: number // node id
  to: number // node id
  kind: EdgeKind
  hours?: OpenInterval[] // if set, usable only inside these intervals (Phase 3)
  stepFree: boolean
  geometry: [number, number][] // [lon, lat] polyline incl. intermediate shape points
  lengthM: number // haversine length in meters
  weightS: number // base walking time in seconds
  osmWayId?: number
}

export interface Place {
  id: string // "osm:way/<id>" or "osm:relation/<id>"
  name: string
  lat: number // centroid
  lon: number
  area?: Area
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: {
    builtAt?: string
    osmFetchedAt?: string
    nodeCount: number
    edgeCount: number
  }
}
