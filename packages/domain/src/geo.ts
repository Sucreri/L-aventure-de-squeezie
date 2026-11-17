/**
 * Geography without PostGIS (HYPOTHESES.md H-10).
 *
 * The service area is one town of about 2 km2 with a handful of polygons, so
 * a ray-casting containment test and a haversine distance are exact enough and
 * keep the schema runnable on a plain Postgres. These mirror
 * `app.point_in_polygon` and `app.haversine_m`.
 */

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** GeoJSON Polygon: an array of linear rings, each an array of [lon, lat]. */
export interface GeoJsonPolygon {
  readonly type: 'Polygon';
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineM(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(h));
}

/** Containment against the outer ring only: LLN zones have no holes. */
export function pointInPolygon(point: LatLon, polygon: GeoJsonPolygon): boolean {
  const ring = polygon.coordinates[0];
  if (!ring || ring.length < 4) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;

    const [xi, yi] = pi;   // lon, lat
    const [xj, yj] = pj;

    if (yi > point.lat !== yj > point.lat) {
      const denominator = yj - yi;
      if (denominator !== 0 && point.lon < ((xj - xi) * (point.lat - yi)) / denominator + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}
