// Synthetic sessions with exactly known lap times, used to prove the timing maths and to drive
// the demo. The course is a "stadium": two straights joined by two right-hand semicircles
// (clockwise, like Sepang). The car's motion is integrated in 1 ms steps, so the true moment it
// crosses any line is known to well under a millisecond.

import { LocalProjection } from './geo.js';

/** Deterministic pseudo-random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export function stadiumCourse({ straight = 600, radius = 100, lat0 = 2.75, lon0 = 101.7 } = {}) {
  const arc = Math.PI * radius;
  const length = 2 * straight + 2 * arc;
  const proj = new LocalProjection(lat0, lon0);
  // s from 0: straight A eastwards along y=0, right-hand arc 1, straight B westwards, arc 2
  function pos(s) {
    s = ((s % length) + length) % length;
    if (s < straight) return { x: s, y: 0, h: 90, seg: 'A', q: s };
    s -= straight;
    if (s < arc) {
      const a = Math.PI / 2 - s / radius; // from +90 deg clockwise
      return { x: straight + radius * Math.cos(a), y: -radius + radius * Math.sin(a), h: 90 + (s / arc) * 180, seg: 'arc1', q: s };
    }
    s -= arc;
    if (s < straight) return { x: straight - s, y: -2 * radius, h: 270, seg: 'B', q: s };
    s -= straight;
    const a = -Math.PI / 2 - s / radius;
    return { x: radius * Math.cos(a), y: -radius + radius * Math.sin(a), h: (270 + (s / arc) * 180) % 360, seg: 'arc2', q: s };
  }
  function lineAt(s, halfWidth = 25, reverse = false) {
    const p = pos(s);
    const [lat, lon] = proj.toLatLon(p.x, p.y);
    return { lat, lon, heading: reverse ? (p.h + 180) % 360 : p.h, halfWidth };
  }
  return { straight, radius, arc, length, pos, lineAt, proj };
}

/**
 * Drive the course. Returns GPS fixes at `rate` Hz and a function giving the true times at which
 * the car passed arc position sLine (every lap).
 */
export function simulate(course, opts = {}) {
  const {
    laps = 6,
    vMax = 60,
    aLat = 9.81,
    accel = 4,
    brake = 9,
    rate = 1,
    phase = 0.37,
    noise = 0,
    speedNoise = 0,
    variation = 0.015,
    seed = 1,
    startS = course.length - 150,
    reverse = false,
    t0 = 0,
    utc0 = 1767225600000,
  } = opts;
  const r = rng(seed);
  const nLap = laps + 2;
  const factors = Array.from({ length: nLap + 1 }, () => 1 + variation * (2 * r() - 1));
  const vc0 = Math.sqrt(aLat * course.radius);
  function speedAt(sTotal) {
    const lap = Math.floor(sTotal / course.length);
    const f = factors[Math.min(Math.max(lap, 0), factors.length - 1)];
    const p = course.pos(sTotal);
    const vc = vc0 * f;
    if (p.seg === 'arc1' || p.seg === 'arc2') return vc;
    const q = p.q;
    const L = course.straight;
    return Math.min(vMax * f, Math.sqrt(vc * vc + 2 * accel * q), Math.sqrt(vc * vc + 2 * brake * (L - q)));
  }
  const dt = 0.001;
  const sEnd = startS + (laps + 1) * course.length + 100;
  const ts = [];
  const ss = [];
  let s = startS;
  let t = 0;
  // integrate with midpoint steps
  while (s < sEnd) {
    ts.push(t);
    ss.push(s);
    const v1 = speedAt(s);
    const v2 = speedAt(s + 0.5 * dt * v1);
    s += dt * v2;
    t += dt;
  }
  const T = Float64Array.from(ts);
  const S = Float64Array.from(ss);
  const sAt = (tq) => {
    const i = Math.min(Math.max(Math.floor(tq / dt), 0), T.length - 2);
    const fr = (tq - T[i]) / dt;
    return S[i] + fr * (S[i + 1] - S[i]);
  };
  const fixes = [];
  for (let tq = phase / rate; tq < T[T.length - 1]; tq += 1 / rate) {
    const sTot = sAt(tq);
    const sPath = reverse ? -sTot : sTot;
    const p = course.pos(sPath);
    const x = p.x + noise * gauss(r);
    const y = p.y + noise * gauss(r);
    const [lat, lon] = course.proj.toLatLon(x, y);
    const v = Math.max(0, speedAt(sTot) + speedNoise * gauss(r));
    fixes.push({ t: t0 + tq, lat, lon, speed: v, bearing: reverse ? (p.h + 180) % 360 : p.h, hAcc: noise ? 2 * noise : 3, utc: utc0 + Math.round(tq * 1000) });
  }
  /** True times (session clock) at which the car passed arc position sLine, in order. */
  function crossings(sLine) {
    const out = [];
    let k = Math.ceil((startS - sLine) / course.length);
    for (;;) {
      const target = sLine + k * course.length;
      if (target > S[S.length - 1]) break;
      if (target >= S[0]) {
        let lo = 0;
        let hi = S.length - 1;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (S[m] < target) lo = m;
          else hi = m;
        }
        out.push(t0 + T[lo] + ((target - S[lo]) / (S[hi] - S[lo])) * dt);
      }
      k++;
    }
    return out;
  }
  return { fixes, crossings, duration: T[T.length - 1], sAt: (tq) => sAt(tq - t0), length: course.length };
}
