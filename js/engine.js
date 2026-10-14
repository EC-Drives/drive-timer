// Timing engine: turns a stream of GPS fixes into laps (circuit) or runs (road stage).
// The same code runs live in the car, in the replay harness and in the analysis screens,
// so what the driver sees and what the analysis shows always agree.
//
// A fix is { t (seconds on the session clock), lat, lon, speed (m/s, <0 if unknown), hAcc }.

import { LocalProjection, lineGeom, crossFraction, crossTime, nearestOnPath } from './geo.js';

export const ARM_DISTANCE_M = 30; // circuit: the car must first be this far from the line
const SPLIT_DEBOUNCE_S = 2; // ignore a split or restart within this time of a start
const REF_MAX_DIST_M = 50; // further than this from the reference path: no delta
export const GAP_INVALID_S = 5; // a lap with a GPS gap longer than this is not used as a best

export class TimingEngine {
  /**
   * @param {object|null} def  circuit or stage definition, or null for free drive
   * @param {object} opts { minSpeed m/s, reference (stored reference lap/run) }
   */
  constructor(def, opts = {}) {
    this.def = def || null;
    this.kind = def ? def.kind : 'free';
    this.laps = []; // completed laps or runs
    this.aborted = 0;
    this.cur = null; // lap or run in progress
    this.prev = null;
    this.best = null;
    this.ref = null; // reference used for live delta: the faster of own best and external
    this.extRef = null;
    this.minSpeed = opts.minSpeed ?? 1.5;
    if (!def) return;
    this.proj = new LocalProjection(def.start.lat, def.start.lon);
    this.gStart = lineGeom(def.start, this.proj);
    this.gFinish = this.kind === 'stage' ? lineGeom(def.finish, this.proj) : null;
    this.gSplits = (def.splits || []).map((l) => lineGeom(l, this.proj));
    this.minTime = this.kind === 'circuit' ? def.minLapSec ?? 60 : def.minRunSec ?? 10;
    this.maxTime = this.kind === 'circuit' ? Infinity : def.maxRunSec ?? 7200;
    this.armed = this.kind !== 'circuit';
    if (opts.reference) this.setExternalReference(opts.reference);
  }

  /** Feed one GPS fix. Returns a list of events produced by it. */
  push(f) {
    const ev = [];
    if (!this.def) return ev;
    const [x, y] = this.proj.toXY(f.lat, f.lon);
    const c = { t: f.t, x, y, lat: f.lat, lon: f.lon, v: f.speed != null && f.speed >= 0 ? f.speed : -1, utc: f.utc > 0 ? f.utc : 0 };
    const p = this.prev;
    if (p && !(c.t > p.t)) return ev; // duplicate or out of order: ignore
    if (p) {
      const dt = c.t - p.t;
      // the page clock can stand still while an iPhone sleeps; the fixes' UTC times do not
      const gap = p.utc && c.utc ? Math.max(dt, (c.utc - p.utc) / 1000) : dt;
      const chord = Math.hypot(c.x - p.x, c.y - p.y);
      const v = p.v >= 0 && c.v >= 0 ? (p.v + c.v) / 2 : chord / dt;
      // the gap counts against the lap that ends in this step and the one that starts in it
      if (this.cur && gap > this.cur.maxGap) this.cur.maxGap = gap;
      if (v >= this.minSpeed) this._crossings(p, c, ev);
      if (this.cur && gap > this.cur.maxGap) this.cur.maxGap = gap;
    }
    if (this.cur) {
      this._append(c);
      this._delta(c);
      if (c.t - this.cur.t0 > this.maxTime) {
        ev.push({ type: 'abort', reason: 'timeout', lap: this.cur });
        this.aborted++;
        this.cur = null;
      }
    }
    if (!this.armed && Math.hypot(x - this.gStart.cx, y - this.gStart.cy) >= ARM_DISTANCE_M) this.armed = true;
    this.prev = c;
    return ev;
  }

  _crossings(p, c, ev) {
    const hits = [];
    let u;
    if (this.armed && (u = crossFraction(p.x, p.y, c.x, c.y, this.gStart)) >= 0) hits.push({ what: 'start', u });
    if (this.gFinish && (u = crossFraction(p.x, p.y, c.x, c.y, this.gFinish)) >= 0) hits.push({ what: 'finish', u });
    for (let k = 0; k < this.gSplits.length; k++) {
      if ((u = crossFraction(p.x, p.y, c.x, c.y, this.gSplits[k])) >= 0) hits.push({ what: 'split', k, u });
    }
    if (!hits.length) return;
    hits.sort((a, b) => a.u - b.u);
    const dt = c.t - p.t;
    for (const h of hits) {
      const t = crossTime(p.t, c.t, p.v, c.v, h.u);
      const r = (t - p.t) / dt;
      const pt = {
        t,
        x: p.x + h.u * (c.x - p.x),
        y: p.y + h.u * (c.y - p.y),
        lat: p.lat + h.u * (c.lat - p.lat),
        lon: p.lon + h.u * (c.lon - p.lon),
        v: p.v >= 0 && c.v >= 0 ? p.v + r * (c.v - p.v) : Math.hypot(c.x - p.x, c.y - p.y) / dt,
      };
      if (h.what === 'start') this._onStart(pt, ev);
      else if (h.what === 'finish') this._onFinish(pt, ev);
      else this._onSplit(h.k, pt, ev);
    }
  }

  _onStart(pt, ev) {
    if (this.kind === 'circuit') {
      if (this.cur) {
        if (pt.t - this.cur.t0 < this.minTime) {
          ev.push({ type: 'ignored', reason: 'min-lap-time', t: pt.t });
          return;
        }
        this._finish(pt, ev);
      }
      this._begin(pt, ev);
      return;
    }
    // stage: crossing the start again during a run restarts it
    if (this.cur) {
      if (pt.t - this.cur.t0 < SPLIT_DEBOUNCE_S) return;
      ev.push({ type: 'abort', reason: 'restart', lap: this.cur });
      this.aborted++;
    }
    this._begin(pt, ev);
  }

  _onFinish(pt, ev) {
    if (!this.cur) return;
    if (pt.t - this.cur.t0 < this.minTime) {
      ev.push({ type: 'ignored', reason: 'min-run-time', t: pt.t });
      return;
    }
    this._finish(pt, ev);
  }

  _onSplit(k, pt, ev) {
    const lap = this.cur;
    if (!lap || k < lap.nextSplit) return;
    const el = pt.t - lap.t0;
    if (el < SPLIT_DEBOUNCE_S) return;
    lap.splits[k] = el;
    lap.nextSplit = k + 1;
    const ref = this.ref;
    const delta = ref && ref.splits && ref.splits[k] != null ? el - ref.splits[k] : null;
    ev.push({ type: 'split', k, n: lap.n, elapsed: el, delta, t: pt.t });
  }

  _begin(pt, ev) {
    const n = this.laps.length + 1;
    this.cur = {
      n,
      t0: pt.t,
      pts: [{ t: 0, x: pt.x, y: pt.y, lat: pt.lat, lon: pt.lon, v: pt.v, d: 0 }],
      splits: new Array(this.gSplits.length).fill(null),
      nextSplit: 0,
      maxGap: 0,
      refHint: 0,
      delta: null,
      deltaT: null,
    };
    ev.push({ type: 'start', n, t: pt.t });
  }

  _finish(pt, ev) {
    const lap = this.cur;
    const prevRefTime = this.ref ? this.ref.time : null;
    const prevBestTime = this.best ? this.best.time : null;
    lap.t1 = pt.t;
    lap.time = pt.t - lap.t0;
    this._appendPoint(lap, pt);
    lap.sectors = sectorTimes(lap.splits, lap.time);
    lap.valid = lap.maxGap <= GAP_INVALID_S;
    delete lap.refHint;
    this.laps.push(lap);
    if (lap.valid && (!this.best || lap.time < this.best.time)) this.best = lap;
    this._refreshReference();
    ev.push({ type: 'lap', lap, isBest: this.best === lap, prevBestTime, prevRefTime, t: pt.t });
    this.cur = null;
  }

  _append(c) {
    this._appendPoint(this.cur, c);
  }

  _appendPoint(lap, c) {
    const last = lap.pts[lap.pts.length - 1];
    const t = c.t - lap.t0;
    if (t <= last.t) return;
    const d = last.d + Math.hypot(c.x - last.x, c.y - last.y);
    lap.pts.push({ t, x: c.x, y: c.y, lat: c.lat, lon: c.lon, v: c.v, d });
  }

  _delta(c) {
    const lap = this.cur;
    const ref = this.ref;
    if (!ref) {
      lap.delta = null;
      return;
    }
    const loc = locateOnRef(ref, c.x, c.y, lap.refHint);
    if (!loc || loc.dist > REF_MAX_DIST_M) {
      lap.delta = null;
      return;
    }
    lap.refHint = loc.i;
    lap.delta = c.t - lap.t0 - loc.t;
    lap.deltaT = c.t;
    lap.refD = loc.d;
  }

  /** The app was hidden or the phone locked: the lap in progress can no longer be trusted. */
  interrupt() {
    if (this.cur) this.cur.maxGap = Infinity;
  }

  /** Use a stored reference (for example the best lap ever) for the live delta. */
  setExternalReference(stored) {
    this.extRef = stored ? refFromStored(stored, this.proj) : null;
    this._refreshReference();
  }

  _refreshReference() {
    let r = null;
    if (this.best) {
      if (!this._ownRef || this._ownRef.lap !== this.best) this._ownRef = refFromLap(this.best);
      r = this._ownRef;
    }
    if (this.extRef && (!r || this.extRef.time < r.time)) r = this.extRef;
    this.ref = r;
  }

  /** Snapshot for the live screen. tNow is the current time on the session clock (s). */
  status(tNow) {
    const c = this.cur;
    return {
      kind: this.kind,
      armed: this.armed,
      running: !!c,
      n: c ? c.n : this.laps.length + 1,
      elapsed: c ? tNow - c.t0 : null,
      delta: c ? c.delta : null,
      deltaAge: c && c.deltaT != null ? tNow - c.deltaT : null,
      lapsDone: this.laps.length,
      last: this.laps.length ? this.laps[this.laps.length - 1] : null,
      best: this.best,
      refTime: this.ref ? this.ref.time : null,
      refExternal: !!this.ref && this.ref === this.extRef,
      refLabel: this.ref ? this.ref.label || '' : '',
    };
  }
}

/** Sector times from split elapsed times; null where a split was missed. */
export function sectorTimes(splits, time) {
  const b = [0, ...splits, time];
  const out = [];
  for (let i = 0; i < b.length - 1; i++) out.push(b[i] != null && b[i + 1] != null ? b[i + 1] - b[i] : null);
  return out;
}

/** Reference trace from a lap of this engine (same projection). */
export function refFromLap(lap, label) {
  const n = lap.pts.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const ts = new Float64Array(n);
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = lap.pts[i];
    xs[i] = p.x;
    ys[i] = p.y;
    ts[i] = p.t;
    ds[i] = p.d;
  }
  return { lap, time: lap.time, splits: lap.splits ? lap.splits.slice() : null, xs, ys, ts, ds, label: label || '' };
}

/** Compact, storable form of a lap: [[lat, lon, t, v], ...] rounded. */
export function lapToStored(lap, meta = {}) {
  return {
    time: lap.time,
    splits: lap.splits ? lap.splits.slice() : [],
    pts: lap.pts.map((p) => [round(p.lat, 7), round(p.lon, 7), round(p.t, 3), round(p.v, 2)]),
    ...meta,
  };
}

/** Reference trace from a stored lap, projected into the given projection. */
export function refFromStored(stored, proj) {
  const n = stored.pts.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const ts = new Float64Array(n);
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [lat, lon, t] = stored.pts[i];
    const [x, y] = proj.toXY(lat, lon);
    xs[i] = x;
    ys[i] = y;
    ts[i] = t;
    ds[i] = i ? ds[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]) : 0;
  }
  return { lap: null, time: stored.time, splits: stored.splits || null, xs, ys, ts, ds, label: stored.label || '' };
}

/** Locate (x, y) on a reference trace near index hint. Returns { i, dist, t, d } or null. */
export function locateOnRef(ref, x, y, hint = 0) {
  const n = ref.xs.length;
  if (n < 2) return null;
  let m = nearestOnPath(ref.xs, ref.ys, x, y, hint - 3, hint + 30);
  if (!m || m.dist > 40) {
    const wide = nearestOnPath(ref.xs, ref.ys, x, y, hint - 3, n - 1);
    if (wide && (!m || wide.dist < m.dist)) m = wide;
  }
  if (!m) return null;
  const i = m.i;
  const r = m.r;
  return {
    i,
    dist: m.dist,
    t: ref.ts[i] + r * (ref.ts[i + 1] - ref.ts[i]),
    d: ref.ds[i] + r * (ref.ds[i + 1] - ref.ds[i]),
  };
}

/**
 * Compare a lap with a reference: for every point of the lap, the distance along the reference
 * path, the time difference and the speed. Used for the delta and speed charts.
 */
export function compareToRef(lap, ref) {
  const out = [];
  let hint = 0;
  for (const p of lap.pts) {
    const loc = locateOnRef(ref, p.x, p.y, hint);
    if (!loc || loc.dist > REF_MAX_DIST_M) continue;
    hint = loc.i;
    out.push({ d: loc.d, delta: p.t - loc.t, v: p.v, t: p.t });
  }
  // the end point of a complete lap sits on the line: pin it to the reference length
  if (lap.time != null && out.length) {
    const last = out[out.length - 1];
    const refLen = ref.ds[ref.ds.length - 1];
    if (refLen - last.d < 60) {
      last.d = refLen;
      last.delta = lap.time - ref.time;
    }
  }
  return out;
}

/** Run a whole recording through the engine. */
export function timeFixes(fixes, def, opts) {
  const eng = new TimingEngine(def, opts);
  for (const f of fixes) eng.push(f);
  return eng;
}

/** Summary numbers for a set of laps or runs. */
export function lapStats(laps) {
  const valid = laps.filter((l) => l.valid);
  const times = valid.map((l) => l.time).sort((a, b) => a - b);
  const best = valid.reduce((b, l) => (!b || l.time < b.time ? l : b), null);
  const nSec = laps.length ? laps[0].sectors.length : 0;
  const bestSectors = [];
  for (let s = 0; s < nSec; s++) {
    let m = null;
    for (const l of valid) if (l.sectors[s] != null && (m == null || l.sectors[s] < m)) m = l.sectors[s];
    bestSectors.push(m);
  }
  const ideal = nSec > 1 && bestSectors.every((v) => v != null) ? bestSectors.reduce((a, b) => a + b, 0) : null;
  const median = times.length ? (times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2) : null;
  return { count: laps.length, validCount: valid.length, best, bestSectors, ideal, median };
}

function round(v, k) {
  const m = 10 ** k;
  return Math.round(v * m) / m;
}
