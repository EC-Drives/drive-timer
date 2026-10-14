// After-the-drive analysis: drive statistics, G-forces derived from GPS, and the search for runs
// of a stage (or laps of a circuit) across all saved recordings.

import { timeFixes, lapStats } from './engine.js';
import { distanceM, wrap180, bearingDeg, DEG } from './geo.js';

const G0 = 9.80665;

/** Distance, duration, moving time and top speed of a recording. */
export function driveStats(fixes) {
  let dist = 0;
  let moving = 0;
  let vmax = 0;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    const dt = b.t - a.t;
    if (!(dt > 0)) continue;
    const d = distanceM(a.lat, a.lon, b.lat, b.lon);
    const vDoppler = a.speed >= 0 && b.speed >= 0 ? (a.speed + b.speed) / 2 : -1;
    const v = vDoppler >= 0 && dt <= 10 ? vDoppler : d / dt;
    if (v >= 1.0) dist += d; // ignore position jitter while standing still
    if (v >= 1.5) moving += Math.min(dt, 10);
    if (b.speed >= 0 && !(b.hAcc > 25)) vmax = Math.max(vmax, b.speed);
  }
  const durationS = fixes.length > 1 ? fixes[fixes.length - 1].t - fixes[0].t : 0;
  return { distanceM: dist, durationS, movingS: moving, maxSpeed: vmax, avgMovingSpeed: moving > 0 ? dist / moving : 0 };
}

/**
 * Longitudinal and lateral acceleration in g from GPS alone: longitudinal from the change in
 * speed, lateral from speed times turn rate (right turn positive). Central differences, then a
 * light 3-point smoothing. Points need t, lat, lon and speed (or v); bearing is used when valid.
 */
export function gpsG(points) {
  const n = points.length;
  const raw = [];
  const sp = (p) => (p.speed != null ? p.speed : p.v);
  for (let i = 1; i < n - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const dt = c.t - a.t;
    if (!(dt > 0) || dt > 4.5) continue;
    const va = sp(a);
    const vb = sp(b);
    const vc = sp(c);
    if (!(va >= 0 && vc >= 0 && vb >= 0)) continue;
    const lon = (vc - va) / dt / G0;
    let w;
    if (a.bearing >= 0 && c.bearing >= 0 && va > 5 && vc > 5) {
      w = (wrap180(c.bearing - a.bearing) * DEG) / dt;
    } else {
      const h1 = bearingDeg(a.lat, a.lon, b.lat, b.lon);
      const h2 = bearingDeg(b.lat, b.lon, c.lat, c.lon);
      const d1 = distanceM(a.lat, a.lon, b.lat, b.lon);
      const d2 = distanceM(b.lat, b.lon, c.lat, c.lon);
      if (d1 < 2 || d2 < 2) continue;
      w = (wrap180(h2 - h1) * DEG) / (dt / 2);
    }
    const lat = (vb * w) / G0;
    raw.push({ i, t: b.t, lon, lat, v: vb, d: b.d });
  }
  // 3-point smoothing (only across neighbours that are also consecutive fixes)
  return raw.map((p, k) => {
    const q = raw[k - 1];
    const r = raw[k + 1];
    if (q && r && q.i === p.i - 1 && r.i === p.i + 1) {
      return { ...p, lon: (q.lon + 2 * p.lon + r.lon) / 4, lat: (q.lat + 2 * p.lat + r.lat) / 4 };
    }
    return p;
  });
}

/** Bounding box [minLat, minLon, maxLat, maxLon] of a list of fixes. */
export function bboxOf(fixes) {
  let a = 90;
  let b = 180;
  let c = -90;
  let d = -180;
  for (const f of fixes) {
    if (f.lat < a) a = f.lat;
    if (f.lon < b) b = f.lon;
    if (f.lat > c) c = f.lat;
    if (f.lon > d) d = f.lon;
  }
  return fixes.length ? [a, b, c, d] : null;
}

/**
 * Time a definition (stage or circuit) across saved recordings. Only recordings whose area
 * covers the definition's lines are loaded. Returns [{ sessionId, session, lap }].
 */
export async function findRuns(def, sessions, loadFixes) {
  const out = [];
  const pad = 0.003; // about 300 m
  const pts = [def.start, def.kind === 'stage' ? def.finish : def.start];
  for (const s of sessions) {
    const bb = s.bbox;
    if (!bb) continue;
    const inside = (p) => p.lat >= bb[0] - pad && p.lat <= bb[2] + pad && p.lon >= bb[1] - pad && p.lon <= bb[3] + pad;
    if (!pts.every(inside)) continue;
    const fixes = await loadFixes(s.id);
    if (!fixes || fixes.length < 3) continue;
    const eng = timeFixes(fixes, def);
    for (const lap of eng.laps) out.push({ sessionId: s.id, session: s, lap });
  }
  return out;
}

/** Everything the analysis screen needs for one recording and one definition (or free drive). */
export function analyseSession(fixes, def, opts = {}) {
  const stats = driveStats(fixes);
  if (!def) return { kind: 'free', stats, laps: [], lapStats: null, engine: null };
  const engine = timeFixes(fixes, def, opts);
  return { kind: def.kind, stats, engine, laps: engine.laps, lapStats: lapStats(engine.laps) };
}

/** Speed (m/s) and own cumulative distance (m) along a lap, for charts and the map. */
export function lapTrace(lap) {
  return lap.pts.map((p) => ({ d: p.d, v: p.v, t: p.t, lat: p.lat, lon: p.lon, x: p.x, y: p.y }));
}

/** Trace of a whole recording with cumulative distance (for free-drive charts and maps). */
export function driveTrace(fixes) {
  const out = [];
  let d = 0;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    if (i) {
      const a = fixes[i - 1];
      const step = distanceM(a.lat, a.lon, f.lat, f.lon);
      const dt = f.t - a.t;
      const v = a.speed >= 0 && f.speed >= 0 ? (a.speed + f.speed) / 2 : step / Math.max(dt, 1e-3);
      if (v >= 1.0) d += step;
    }
    out.push({ d, v: f.speed >= 0 ? f.speed : 0, t: f.t, lat: f.lat, lon: f.lon, bearing: f.bearing, speed: f.speed });
  }
  return out;
}
