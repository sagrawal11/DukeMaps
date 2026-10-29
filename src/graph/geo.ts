// Great-circle distance helpers. Reused by the graph builder (edge lengths) and by the
// Phase 5 A* heuristic (straight-line distance). No dependencies — plain trig.

const EARTH_RADIUS_M = 6_371_000

const toRad = (deg: number): number => (deg * Math.PI) / 180

// Haversine distance in meters between two lat/lon points.
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const lat1 = toRad(aLat)
  const lat2 = toRad(bLat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Initial great-circle bearing A→B, degrees clockwise from north (0 = N, 90 = E). Used by the
// directions builder to turn a route's geometry into "head northeast" / "turn left" maneuvers.
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const lat1 = toRad(aLat)
  const lat2 = toRad(bLat)
  const dLon = toRad(bLon - aLon)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// Summed haversine length of a [lon, lat] polyline.
export function polylineLengthM(coords: [number, number][]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1]
    const [lon2, lat2] = coords[i]
    total += haversineM(lat1, lon1, lat2, lon2)
  }
  return total
}

// Ray-casting point-in-polygon. `ring` is a [lon, lat] array (open or closed).
export function pointInPolygon(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}
