// Geometry helpers: a local flat projection (metres east/north of an origin), distances,
// bearings, and timing-line geometry. Accurate to well under 0.1 % across a few kilometres,
// which is far below phone-GPS error.

export const DEG = Math.PI / 180;
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

export class LocalProjection {
  constructor(lat0, lon0) {
    const s = Math.sin(lat0 * DEG);
    const w = 1 - WGS84_E2 * s * s;
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.ky = (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5) * DEG; // metres per degree of latitude
    this.kx = (WGS84_A / Math.sqrt(w)) * Math.cos(lat0 * DEG) * DEG; // metres per degree of longitude
  }
  toXY(lat, lon) {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }
  toLatLon(x, y) {
    return [this.lat0 + y / this.ky, this.lon0 + x / this.kx];
  }
}

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees from true north (0-360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Wrap an angle difference into (-180, 180]. */
export function wrap180(d) {
  let r = ((d + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}

/**
 * A timing line is stored as its centre point, the direction of travel across it (degrees from
 * true north) and a half-width in metres. Returns its segment end points in the projection,
 * plus the unit vector of the direction of travel.
 */
export function lineGeom(line, proj) {
  const [cx, cy] = proj.toXY(line.lat, line.lon);
  const h = line.heading * DEG;
  const nx = Math.sin(h);
  const ny = Math.cos(h); // direction of travel (east, north)
  const tx = Math.cos(h);
  const ty = -Math.sin(h); // along the line, towards the driver's right
  const w = line.halfWidth > 0 ? line.halfWidth : 25;
  return { cx, cy, nx, ny, ax: cx - w * tx, ay: cy - w * ty, bx: cx + w * tx, by: cy + w * ty, w };
}

/**
 * If the move from P to Q crosses line g in its direction of travel, returns the fraction u
 * (0 < u <= 1) of the way from P to Q at which it crosses; otherwise -1.
 */
export function crossFraction(px, py, qx, qy, g) {
  const rx = qx - px;
  const ry = qy - py;
  if (rx * g.nx + ry * g.ny <= 0) return -1; // moving the wrong way, or not moving
  const sx = g.bx - g.ax;
  const sy = g.by - g.ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const wx = g.ax - px;
  const wy = g.ay - py;
  const u = (wx * sy - wy * sx) / den;
  const v = (wx * ry - wy * rx) / den;
  return u > 0 && u <= 1 && v >= 0 && v <= 1 ? u : -1;
}

/**
 * Time at which the car was a fraction u of the way along the straight line between two fixes,
 * assuming constant acceleration between them (uses the two GPS speeds when both are known).
 */
export function crossTime(t0, t1, v0, v1, u) {
  const dt = t1 - t0;
  if (!(v0 >= 0) || !(v1 >= 0) || v0 + v1 < 0.5) return t0 + u * dt;
  const acc = (v1 - v0) / dt;
  const dist = (u * (v0 + v1) * dt) / 2;
  let tau;
  if (Math.abs(acc) < 1e-6) tau = v0 > 0 ? dist / v0 : u * dt;
  else tau = (-v0 + Math.sqrt(Math.max(v0 * v0 + 2 * acc * dist, 0))) / acc;
  if (!(tau >= 0)) tau = 0;
  if (tau > dt) tau = dt;
  return t0 + tau;
}

/** Point on a polyline (typed arrays xs, ys) nearest to (x, y), searching segments i0..i1. */
export function nearestOnPath(xs, ys, x, y, i0, i1) {
  const n = xs.length;
  let best = -1;
  let bestD2 = Infinity;
  let bestR = 0;
  const a = Math.max(0, i0 | 0);
  const b = Math.min(n - 1, i1 | 0);
  for (let i = a; i < b; i++) {
    const ax = xs[i];
    const ay = ys[i];
    const dx = xs[i + 1] - ax;
    const dy = ys[i + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let r = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    if (r < 0) r = 0;
    else if (r > 1) r = 1;
    const ex = ax + r * dx - x;
    const ey = ay + r * dy - y;
    const d2 = ex * ex + ey * ey;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
      bestR = r;
    }
  }
  return best < 0 ? null : { i: best, r: bestR, dist: Math.sqrt(bestD2) };
}
