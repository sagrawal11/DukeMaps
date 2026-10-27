import type { EdgeKind } from './types'

// Walking-cost calibration knobs. Tune these numbers, not the code.
// ponytail: flat multiplier for stairs since OSM rarely has reliable step counts.
export const WALK_SPEED_MPS = 1.4 // ~5 km/h preferred walking speed
export const STAIRS_PENALTY = 2.0 // stairs cost ~2x the flat-walking time per meter

// Base walking time (seconds) for an edge of the given length and kind.
//
// This is also the lower bound the Phase 5 A* heuristic relies on: the heuristic estimates
// cost as straight-line-distance / WALK_SPEED_MPS. Because no edge is ever traversed faster
// than WALK_SPEED_MPS (stairs are only slower), that estimate never exceeds the true cost,
// so the heuristic stays admissible.
export function edgeWeightS(lengthM: number, kind: EdgeKind): number {
  const base = lengthM / WALK_SPEED_MPS
  return kind === 'stairs' ? base * STAIRS_PENALTY : base
}
