// Records a session: every GPS fix and motion sample goes into a one-second buffer that is written
// to the on-phone database each second, so a Safari reload or crash loses at most a second.
// Recording does not depend on the circuit or stage chosen: free-drive logging always works.

import * as db from './db.js';
import { IS_IOS } from './sensors.js';
import { distanceM } from './geo.js';

const FLUSH_MS = 1000;
const CAL_SECONDS = 3;
const D2R = Math.PI / 180;

function newId(now) {
  const d = new Date(now);
  const p = (v) => String(v).padStart(2, '0');
  return `S${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export class Recorder {
  constructor() {
    this.active = false;
    this.sess = null;
  }

  async begin({ def }) {
    const now = Date.now();
    this.t0 = performance.now();
    this.sess = {
      id: newId(now),
      defId: def ? def.id : null,
      defName: def ? def.name : null,
      mode: def ? def.kind : 'free',
      startUtcMs: now,
      tzOffsetMin: -new Date(now).getTimezoneOffset(),
      status: 'recording',
      source: 'recorded',
      device: IS_IOS ? (/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone') : 'browser',
      platform: navigator.userAgent,
      accelSign: IS_IOS ? -1 : 1,
      accelSignSource: IS_IOS ? 'iPhone default, orientation check pending' : 'browser default',
      gyroMap: 'w3c',
      motionUnits: 'raw',
      motion: {},
      counts: { L: 0, A: 0, G: 0 },
      bbox: null,
      distanceM: 0,
      created: now,
    };
    await db.putSession(this.sess);
    this.seq = 0;
    this.pending = [];
    this.buf = { L: [], A: [], G: [], E: [[0, 'START']] };
    this.cal = { n: 0, sa: [0, 0, 0], sa2: 0, ng: 0, sg: [0, 0, 0], up: [0, 0, 0], nu: 0, done: false };
    this.lastFix = null;
    this.active = true;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    return this.sess;
  }

  /** Seconds on the session clock. */
  now() {
    return (performance.now() - this.t0) / 1000;
  }
  tUs(perf) {
    return Math.round((perf - this.t0) * 1000);
  }

  /** Store a GPS fix; returns its time on the session clock (s), or null. */
  addFix(f) {
    if (!this.active) return null;
    const t = this.tUs(f.perf);
    if (t < 0) return null;
    this.buf.L.push(t, f.lat, f.lon, f.alt, f.speed, f.heading, f.hAcc, -1, -1, f.utc, f.lag);
    const s = this.sess;
    s.counts.L++;
    const bb = s.bbox || [f.lat, f.lon, f.lat, f.lon];
    s.bbox = [Math.min(bb[0], f.lat), Math.min(bb[1], f.lon), Math.max(bb[2], f.lat), Math.max(bb[3], f.lon)];
    const p = this.lastFix;
    if (p) {
      const dt = (f.perf - p.perf) / 1000;
      const d = distanceM(p.lat, p.lon, f.lat, f.lon);
      const v = p.speed >= 0 && f.speed >= 0 && dt <= 10 ? (p.speed + f.speed) / 2 : d / Math.max(dt, 1e-3);
      if (v >= 1) s.distanceM += d;
    }
    this.lastFix = f;
    return t / 1e6;
  }

  addMotion(m) {
    if (!this.active) return;
    const t = this.tUs(m.perf);
    if (t < 0) return;
    if (m.ax != null) {
      this.buf.A.push(t, m.ax, m.ay, m.az);
      this.sess.counts.A++;
    }
    if (m.alpha != null) {
      this.buf.G.push(t, m.alpha, m.beta, m.gamma);
      this.sess.counts.G++;
    }
    if (!this.cal.done) this._calSample(t, m);
  }

  /** deviceorientation events, used only during calibration to check the acceleration sign. */
  addOrientation(e) {
    if (!this.active || this.cal.done || e.beta == null || e.gamma == null) return;
    const b = e.beta * D2R;
    const g = e.gamma * D2R;
    // "up" in phone axes implied by the orientation angles (W3C definition); the same vector
    // results whichever of the two equivalent angle ranges the browser uses
    const c = this.cal;
    c.up[0] += -Math.cos(b) * Math.sin(g);
    c.up[1] += Math.sin(b);
    c.up[2] += Math.cos(b) * Math.cos(g);
    c.nu++;
  }

  _calSample(t, m) {
    const c = this.cal;
    if (m.ax == null) return;
    c.n++;
    c.sa[0] += m.ax;
    c.sa[1] += m.ay;
    c.sa[2] += m.az;
    c.sa2 += m.ax * m.ax + m.ay * m.ay + m.az * m.az;
    if (m.alpha != null) {
      c.ng++;
      c.sg[0] += m.alpha;
      c.sg[1] += m.beta;
      c.sg[2] += m.gamma;
    }
    if (t >= CAL_SECONDS * 1e6 && c.n >= 30) this._finishCal(t);
  }

  _finishCal(t) {
    const c = this.cal;
    c.done = true;
    const mean = c.sa.map((v) => v / c.n);
    const mag = Math.hypot(mean[0], mean[1], mean[2]);
    const std = Math.sqrt(Math.max(c.sa2 / c.n - mag * mag, 0));
    const s = this.sess;
    if (c.nu >= 5 && mag > 5) {
      const un = Math.hypot(c.up[0], c.up[1], c.up[2]);
      const dot = (mean[0] * c.up[0] + mean[1] * c.up[1] + mean[2] * c.up[2]) / (mag * un);
      if (dot > 0.7) {
        s.accelSign = 1;
        s.accelSignSource = `measured: gravity agrees with device orientation (dot ${dot.toFixed(2)})`;
      } else if (dot < -0.7) {
        s.accelSign = -1;
        s.accelSignSource = `measured: gravity opposite to device orientation (dot ${dot.toFixed(2)}); values inverted`;
      } else {
        s.accelSignSource += `; orientation check inconclusive (dot ${dot.toFixed(2)})`;
      }
    } else {
      s.accelSignSource = s.accelSignSource.replace('orientation check pending', 'no orientation data to check against');
    }
    const g = c.ng ? c.sg.map((v) => v / c.ng) : [0, 0, 0];
    const still = std < 0.5 && (!this.lastFix || (this.lastFix.speed >= 0 && this.lastFix.speed < 1)) ? 1 : 0;
    const k = s.accelSign;
    // CAL: mean_ax, mean_ay, mean_az (file convention), a_std, mean_gx, mean_gy, mean_gz (rad/s), stationary
    this.buf.E.push([t, 'CAL', k * mean[0], k * mean[1], k * mean[2], std, g[1] * D2R, g[2] * D2R, g[0] * D2R, still]);
  }

  /** Lap or run completed: written as an event so the file carries the live result too. */
  lap(n, seconds, tCross) {
    if (!this.active) return;
    this.buf.E.push([Math.round(tCross * 1e6), 'LAP', n, Math.round(seconds * 1000) / 1000]);
  }

  /** The definition was set or changed during the recording (for example a marked line). */
  setDefinition(def) {
    if (!this.sess) return;
    this.sess.defId = def ? def.id : null;
    this.sess.defName = def ? def.name : null;
    this.sess.mode = def ? def.kind : 'free';
    db.putSession(this.sess).catch(() => {});
  }

  async flush() {
    const b = this.buf;
    if (b.L.length || b.A.length || b.G.length || b.E.length) {
      this.buf = { L: [], A: [], G: [], E: [] };
      this.pending.push({
        sid: this.sess.id,
        seq: this.seq++,
        L: Float64Array.from(b.L),
        A: Float64Array.from(b.A),
        G: Float64Array.from(b.G),
        E: b.E,
      });
    }
    if (!this.pending.length || this.writing) return;
    this.writing = true;
    try {
      const batch = this.pending.slice();
      await db.putMany('chunks', batch);
      this.pending.splice(0, batch.length);
      this.writeError = null;
      if (this.seq % 10 === 0) await db.putSession(this.sess);
    } catch (e) {
      this.writeError = e && e.message ? e.message : String(e);
    } finally {
      this.writing = false;
    }
  }

  async end(extra = {}) {
    if (!this.active) return null;
    this.buf.E.push([this.tUs(performance.now()), 'STOP']);
    clearInterval(this.timer);
    this.active = false;
    // write what is left; give up after a few seconds rather than hang the stop button
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      if (this.writing) {
        await sleep(50);
        continue;
      }
      if (!this.pending.length && !this.buf.L.length && !this.buf.A.length && !this.buf.G.length && !this.buf.E.length) break;
      await this.flush();
      if (this.pending.length) await sleep(250);
    }
    const s = this.sess;
    const unsaved = this.pending.length;
    s.status = unsaved ? 'interrupted' : 'done';
    if (unsaved) s.unsavedSeconds = unsaved;
    s.endUtcMs = Date.now();
    Object.assign(s, extra);
    await db.putSession(s);
    await compactTrack(s.id);
    return s;
  }
}

/** Build the compact GPS track of a session from its raw chunks. */
export async function compactTrack(sid) {
  const chunks = await db.getChunks(sid);
  let n = 0;
  for (const c of chunks) n += c.L ? c.L.length : 0;
  const L = new Float64Array(n);
  let o = 0;
  for (const c of chunks)
    if (c.L) {
      L.set(c.L, o);
      o += c.L.length;
    }
  await db.saveTrack(sid, L);
  return L;
}
