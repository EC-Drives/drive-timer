// Session files: the plain-text CSV format shared with the Android logger (TrackLogger 1.2 rows).
// One record per line; header lines start with '#'; every data row starts with a kind letter and
// t_us (integer microseconds since the session start, one shared clock).
//
//   A,t_us,ax,ay,az            m/s^2, phone axes, gravity included (face up reads about +9.81 on z)
//   G,t_us,gx,gy,gz            rad/s, phone axes, right-hand rule
//   L,t_us,lat,lon,alt,speed,bearing,hAcc,sAcc,bAcc,utc_ms,lag_ms   (missing -1, altitude -9999)
//   S,t_us,visible,used        optional
//   E,t_us,NAME[,values]       START, CAL, LAP n seconds, STOP
//   K,t_us,A|G,lag_ms          optional

import { DEG } from './geo.js';

export const ROWS_LEGEND =
  '# rows: A,t_us,ax,ay,az | G,t_us,gx,gy,gz | L,t_us,lat,lon,alt,speed,bearing,hAcc,sAcc,bAcc,utc_ms,lag_ms | S,t_us,vis,used | E,t_us,NAME,... | K,t_us,A/G,lag_ms';
export const APP_VERSION = '1.0';

// ---------- reading ----------

class GrowF64 {
  constructor(n = 4096) {
    this.a = new Float64Array(n);
    this.n = 0;
  }
  push4(a, b, c, d) {
    if (this.n + 4 > this.a.length) {
      const z = new Float64Array(this.a.length * 2);
      z.set(this.a);
      this.a = z;
    }
    const a0 = this.a;
    let i = this.n;
    a0[i++] = a;
    a0[i++] = b;
    a0[i++] = c;
    a0[i++] = d;
    this.n = i;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * Parse a session file. Tolerates blank lines, unknown rows, a truncated last line and GPS rows
 * slightly out of time order. Returns fixes in time order plus the raw sensor arrays.
 */
export function parseSessionCsv(text) {
  const headerLines = [];
  const meta = {};
  const fixes = [];
  const A = new GrowF64(1 << 16);
  const G = new GrowF64(1 << 16);
  const events = [];
  const stats = { lines: 0, blank: 0, header: 0, unknown: 0, bad: 0, S: 0, K: 0, outOfOrderL: 0, duplicateL: 0 };
  let lastLt = -Infinity;
  const n = text.length;
  let pos = 0;
  if (text.charCodeAt(0) === 0xfeff) pos = 1; // byte-order mark
  while (pos < n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    let line = text.slice(pos, end);
    pos = end + 1;
    stats.lines++;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) {
      stats.blank++;
      continue;
    }
    if (line.charCodeAt(0) === 35) {
      stats.header++;
      headerLines.push(line);
      const body = line.slice(1).trim();
      if (body.startsWith('rows:')) meta.rows = body.slice(5).trim();
      else {
        const k = body.indexOf(',');
        if (k > 0) meta[body.slice(0, k).trim()] = body.slice(k + 1).trim();
        else if (body) meta[body] = '';
      }
      continue;
    }
    const p = line.split(',');
    const kind = p[0].trim();
    const t = Number(p[1]);
    if (!Number.isFinite(t)) {
      if (kind.length === 1 && 'AGLSEK'.includes(kind)) stats.bad++;
      else stats.unknown++;
      continue;
    }
    switch (kind) {
      case 'A':
      case 'G': {
        if (p.length < 5) {
          stats.bad++;
          break;
        }
        const x = Number(p[2]);
        const y = Number(p[3]);
        const z = Number(p[4]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || p[4] === '') {
          stats.bad++;
          break;
        }
        (kind === 'A' ? A : G).push4(t, x, y, z);
        break;
      }
      case 'L': {
        if (p.length < 12 || p[11] === '') {
          stats.bad++;
          break;
        }
        const v = p.slice(2, 12).map(Number);
        if (!v.every(Number.isFinite)) {
          stats.bad++;
          break;
        }
        if (t < lastLt) stats.outOfOrderL++;
        lastLt = t;
        fixes.push({
          t: t / 1e6,
          t_us: t,
          lat: v[0],
          lon: v[1],
          alt: v[2],
          speed: v[3],
          bearing: v[4],
          hAcc: v[5],
          sAcc: v[6],
          bAcc: v[7],
          utc: v[8],
          lag: v[9],
        });
        break;
      }
      case 'E': {
        const name = (p[2] || '').trim();
        if (!name) {
          stats.bad++;
          break;
        }
        events.push({ t_us: t, name, values: p.slice(3).map((v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v.trim())) });
        break;
      }
      case 'S':
        stats.S++;
        break;
      case 'K':
        stats.K++;
        break;
      default:
        stats.unknown++;
    }
  }
  fixes.sort((a, b) => a.t_us - b.t_us);
  const clean = [];
  for (const f of fixes) {
    if (clean.length && f.t_us <= clean[clean.length - 1].t_us) {
      stats.duplicateL++;
      continue;
    }
    if (Math.abs(f.lat) > 90 || Math.abs(f.lon) > 180 || (f.lat === 0 && f.lon === 0)) {
      stats.bad++;
      continue;
    }
    clean.push(f);
  }
  events.sort((a, b) => a.t_us - b.t_us);
  const startUtcMs = Number(meta.start_utc_ms);
  return {
    headerLines,
    meta,
    startUtcMs: Number.isFinite(startUtcMs) ? startUtcMs : clean.length ? clean[0].utc - clean[0].t * 1000 : null,
    fixes: clean,
    A: A.done(),
    G: G.done(),
    events,
    stats,
  };
}

// ---------- writing ----------

const clean = (s) => String(s ?? '').replace(/[\r\n,]+/g, ' ').trim();

/** Header lines for a session recorded by this app (or the stored header of an imported one). */
export function sessionHeader(sess) {
  if (sess.source === 'imported' && Array.isArray(sess.headerLines) && sess.headerLines.length) return sess.headerLines.slice();
  const h = [];
  h.push(`# Drive Timer ${APP_VERSION} (iPhone web app; raw phone-frame log in TrackLogger 1.2 row format)`);
  h.push(`# device,${clean(sess.device || 'iPhone')}`);
  h.push(`# ios,${clean(sess.platform || '')}`);
  h.push(`# start_utc_ms,${Math.round(sess.startUtcMs)}`);
  h.push(`# tz_offset_min,${sess.tzOffsetMin ?? ''}`);
  const rate = (k) => (sess.motion && sess.motion[k] ? `${sess.motion[k].toFixed(1)} Hz` : 'rate unknown');
  const sign = sess.accelSign === -1 ? 'values multiplied by -1 to match the format' : 'values as delivered';
  h.push(`# accel,DeviceMotionEvent.accelerationIncludingGravity,${rate('aHz')},${sign},sign check: ${clean(sess.accelSignSource || 'default')}`);
  const gmap =
    sess.gyroMap === 'xyz'
      ? 'gx=alpha gy=beta gz=gamma'
      : 'gx=beta gy=gamma gz=alpha (W3C axes)';
  h.push(`# gyro,DeviceMotionEvent.rotationRate,${rate('gHz')},deg/s converted to rad/s,${gmap}`);
  h.push('# gps,navigator.geolocation.watchPosition high accuracy maximumAge 0,L t_us = fix time on the session clock (received minus lag_ms),utc_ms = Position.timestamp');
  h.push('# cal,fields: mean_ax,mean_ay,mean_az,a_std,mean_gx,mean_gy,mean_gz,stationary(1/0)');
  if (sess.defName) h.push(`# definition,${clean(sess.defName)},${clean(sess.mode)}`);
  h.push(ROWS_LEGEND);
  return h;
}

const f2 = (v) => (v == null || !Number.isFinite(v) ? '-1' : v.toFixed(2));
const f1 = (v) => (v == null || !Number.isFinite(v) ? '-1' : v.toFixed(1));

// Raw iPhone motion values are converted only here, at export (sign of acceleration, rotation
// rate degrees to radians and axis mapping), so stored data never has to be rewritten if a
// convention turns out different on a newer iPhone.
function motionConv(sess) {
  return sess.source === 'imported' || sess.motionUnits === 'si' ? null : { s: sess.accelSign === -1 ? -1 : 1, map: sess.gyroMap || 'w3c' };
}

function fmtL(L, i) {
  const alt = L[i + 3];
  return `L,${Math.round(L[i])},${L[i + 1].toFixed(8)},${L[i + 2].toFixed(8)},${alt <= -9999 || !Number.isFinite(alt) ? '-9999' : alt.toFixed(2)},${f2(L[i + 4])},${f1(L[i + 5])},${f2(L[i + 6])},${f2(L[i + 7])},${f2(L[i + 8])},${Math.round(L[i + 9])},${Math.round(L[i + 10])}`;
}

function fmtA(A, i, conv) {
  const s = conv ? conv.s : 1;
  return `A,${Math.round(A[i])},${(s * A[i + 1]).toFixed(5)},${(s * A[i + 2]).toFixed(5)},${(s * A[i + 3]).toFixed(5)}`;
}

function fmtG(G, i, conv) {
  let gx;
  let gy;
  let gz;
  if (!conv) {
    gx = G[i + 1];
    gy = G[i + 2];
    gz = G[i + 3];
  } else if (conv.map === 'xyz') {
    gx = G[i + 1] * DEG;
    gy = G[i + 2] * DEG;
    gz = G[i + 3] * DEG;
  } else {
    // stored raw as [alpha, beta, gamma] deg/s; W3C: alpha about z, beta about x, gamma about y
    gx = G[i + 2] * DEG;
    gy = G[i + 3] * DEG;
    gz = G[i + 1] * DEG;
  }
  return `G,${Math.round(G[i])},${gx.toFixed(6)},${gy.toFixed(6)},${gz.toFixed(6)}`;
}

function fmtE(e) {
  const [t, name, ...vals] = e;
  return `E,${Math.round(t)},${clean(name)}${vals.length ? ',' + vals.map((v) => (typeof v === 'number' ? String(+v.toFixed(6)) : clean(v))).join(',') : ''}`;
}

/** Convert one stored chunk into CSV lines in time order (used for small exports and tests). */
export function chunkToLines(chunk, sess) {
  return csvBody([chunk], sess);
}

function concatKind(chunks, key) {
  let n = 0;
  for (const c of chunks) if (c[key]) n += c[key].length;
  const out = new Float64Array(n);
  let o = 0;
  for (const c of chunks)
    if (c[key]) {
      out.set(c[key], o);
      o += c[key].length;
    }
  return out;
}

/** Row order by time for a flat array with `width` numbers per row (usually already in order). */
function rowOrder(arr, width) {
  const n = Math.floor(arr.length / width);
  const idx = new Uint32Array(n);
  let sorted = true;
  for (let i = 0; i < n; i++) {
    idx[i] = i;
    if (i && arr[i * width] < arr[(i - 1) * width]) sorted = false;
  }
  if (!sorted) idx.sort((a, b) => arr[a * width] - arr[b * width]);
  return idx;
}

/**
 * All rows of a session in time order, merged across every stored chunk (GPS rows carry the
 * time the fix was taken, which is a little earlier than when they were stored).
 */
export function csvBody(chunks, sess, onBatch) {
  const conv = motionConv(sess);
  const L = concatKind(chunks, 'L');
  const A = concatKind(chunks, 'A');
  const G = concatKind(chunks, 'G');
  const E = [];
  for (const c of chunks) if (c.E) for (const e of c.E) E.push(e);
  E.sort((a, b) => a[0] - b[0]);
  const iL = rowOrder(L, 11);
  const iA = rowOrder(A, 4);
  const iG = rowOrder(G, 4);
  let l = 0;
  let a = 0;
  let g = 0;
  let e = 0;
  let out = [];
  const all = [];
  for (;;) {
    const te = e < E.length ? E[e][0] : Infinity;
    const tl = l < iL.length ? L[iL[l] * 11] : Infinity;
    const ta = a < iA.length ? A[iA[a] * 4] : Infinity;
    const tg = g < iG.length ? G[iG[g] * 4] : Infinity;
    const m = Math.min(te, tl, ta, tg);
    if (m === Infinity) break;
    if (te === m) out.push(fmtE(E[e++]));
    else if (tl === m) out.push(fmtL(L, iL[l++] * 11));
    else if (ta === m) out.push(fmtA(A, iA[a++] * 4, conv));
    else out.push(fmtG(G, iG[g++] * 4, conv));
    if (onBatch && out.length >= 5000) {
      onBatch(out);
      out = [];
    }
  }
  if (onBatch) {
    if (out.length) onBatch(out);
    return all;
  }
  return out;
}

/** File name in local start time: session_YYYYMMDD_HHMMSS.csv */
export function sessionFileName(startUtcMs, tzOffsetMin) {
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : -new Date(startUtcMs).getTimezoneOffset();
  const d = new Date(startUtcMs + off * 60000);
  const p = (v) => String(v).padStart(2, '0');
  return `session_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.csv`;
}
