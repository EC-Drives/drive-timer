// Circuits and road stages are data, not code. Built-in ones ship in builtin/library.json; the
// driver's own are stored on the phone and can be exported and imported as a JSON file.
//
// A line is { lat, lon, heading, halfWidth }: its centre, the direction of travel across it in
// degrees from true north, and how far it reaches either side, in metres.
// A circuit: { kind:'circuit', start, splits[], minLapSec }.
// A stage:   { kind:'stage', start, finish, splits[], minRunSec, maxRunSec }.

import * as db from './db.js';
import { bearingDeg, distanceM } from './geo.js';

const round = (v, k) => Math.round(v * 10 ** k) / 10 ** k;
let builtins = null;

export async function loadBuiltins() {
  if (builtins) return builtins;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('builtin/library.json', { signal: ctl.signal });
    const j = await r.json();
    builtins = (j.defs || []).map((d) => ({ ...d, builtIn: true }));
  } catch (e) {
    return []; // not cached: try again next time
  } finally {
    clearTimeout(timer);
  }
  return builtins;
}

export async function allDefs() {
  const [b, u] = await Promise.all([loadBuiltins(), db.listDefs()]);
  u.sort((x, y) => (x.name || '').localeCompare(y.name || ''));
  return [...b, ...u];
}

export async function getDef(id) {
  if (!id) return null;
  const b = (await loadBuiltins()).find((d) => d.id === id);
  return b || (await db.get('defs', id)) || null;
}

export function newDefId(kind) {
  return `${kind === 'stage' ? 'stage' : 'circuit'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Short fingerprint of everything that affects timing; a stored best is only valid for the same lines. */
export function linesKey(d) {
  const s = JSON.stringify([d.kind, d.start, d.finish || null, d.splits || [], d.minLapSec ?? null, d.minRunSec ?? null]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

const clampNum = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), lo), hi) : dflt);

export function makeLine(lat, lon, heading, halfWidth = 15) {
  return { lat: round(lat, 7), lon: round(lon, 7), heading: round(((heading % 360) + 360) % 360, 1), halfWidth: round(halfWidth, 1) };
}

export function flipLine(l) {
  return { ...l, heading: (l.heading + 180) % 360 };
}

const lineOk = (l) =>
  !!l && Number.isFinite(l.lat) && Number.isFinite(l.lon) && Math.abs(l.lat) <= 90 && Math.abs(l.lon) <= 180 && Number.isFinite(l.heading) && l.halfWidth > 0 && l.halfWidth <= 200;

/** Problems with a definition, as plain sentences (empty when it is usable). */
export function validateDef(d) {
  const errs = [];
  if (!d || typeof d !== 'object') return ['Not a circuit or stage.'];
  if (!d.name || !String(d.name).trim()) errs.push('Give it a name.');
  if (d.kind !== 'circuit' && d.kind !== 'stage') errs.push('Choose circuit or road stage.');
  if (!lineOk(d.start)) errs.push(d.kind === 'stage' ? 'Set the start line.' : 'Set the start/finish line.');
  if (d.kind === 'stage') {
    if (!lineOk(d.finish)) errs.push('Set the finish line.');
    else if (lineOk(d.start) && distanceM(d.start.lat, d.start.lon, d.finish.lat, d.finish.lon) < 30)
      errs.push('Start and finish are in the same place. For a loop, make it a circuit.');
  }
  for (const l of d.splits || []) if (!lineOk(l)) errs.push('A split line is incomplete.');
  if (d.kind === 'circuit' && d.minLapSec != null && !(d.minLapSec >= 5 && d.minLapSec <= 3600)) errs.push('Shortest possible lap must be 5 to 3600 seconds.');
  if (d.kind === 'stage' && d.minRunSec != null && !(d.minRunSec >= 3 && d.minRunSec <= 3600)) errs.push('Shortest possible run must be 3 to 3600 seconds.');
  return errs;
}

/** A line across a recorded trace at fix i, pointing the way the car was going. */
export function lineFromTrace(fixes, i, halfWidth = 15) {
  const k = 2;
  const a = fixes[Math.max(0, i - k)];
  const b = fixes[Math.min(fixes.length - 1, i + k)];
  let heading = bearingDeg(a.lat, a.lon, b.lat, b.lon);
  if (a === b && fixes[i].bearing >= 0) heading = fixes[i].bearing;
  return makeLine(fixes[i].lat, fixes[i].lon, heading, halfWidth);
}

/** Parse "2.760752, 101.73806" or two separate numbers. */
export function parseLatLon(text) {
  const m = String(text || '')
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// ---------------------------------------------------------------- marking a line on the spot

/**
 * "Mark the line here": averages a few fixes while the car is stopped, then sets the direction
 * either from the way the car arrived (finish and split lines) or from the first 15 m it drives
 * away (start lines).
 */
export class LineMarker {
  constructor({ direction = 'departure', halfWidth = 15, trail = [], needed = 5 } = {}) {
    this.direction = direction;
    this.halfWidth = halfWidth;
    this.trail = trail.slice(-240);
    this.needed = needed;
    this.samples = [];
    this.center = null;
    this.heading = null;
    this.state = 'collecting'; // collecting | direction | done
    this.message = 'Hold still...';
  }
  push(f) {
    if (this.state === 'collecting') {
      if (f.speed > 1.0) {
        this.samples = [];
        this.message = 'Stop the car to mark the line.';
        return this;
      }
      if (!(f.hAcc > 0) || f.hAcc > 25) {
        this.message = `Waiting for a better GPS fix (now ${f.hAcc > 0 ? '±' + Math.round(f.hAcc) + ' m' : 'unknown'})`;
        return this;
      }
      this.samples.push(f);
      this.message = `Hold still... ${this.samples.length} of ${this.needed}`;
      if (this.samples.length >= this.needed) this._place();
      return this;
    }
    if (this.state === 'direction') {
      if (distanceM(this.center.lat, this.center.lon, f.lat, f.lon) >= 15 && (f.speed < 0 || f.speed > 1)) {
        this.heading = bearingDeg(this.center.lat, this.center.lon, f.lat, f.lon);
        this.state = 'done';
        this.message = 'Line set.';
      }
    }
    return this;
  }
  _place() {
    let w = 0;
    let lat = 0;
    let lon = 0;
    for (const f of this.samples) {
      const k = 1 / Math.max(f.hAcc, 1) ** 2;
      w += k;
      lat += k * f.lat;
      lon += k * f.lon;
    }
    this.center = { lat: lat / w, lon: lon / w };
    this.accuracy = Math.min(...this.samples.map((f) => f.hAcc));
    if (this.direction === 'arrival') {
      const t0 = this.samples[0].perf;
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const f = this.trail[i];
        if (f.perf >= t0) continue;
        if (distanceM(f.lat, f.lon, this.center.lat, this.center.lon) >= 15) {
          this.heading = bearingDeg(f.lat, f.lon, this.center.lat, this.center.lon);
          break;
        }
      }
    }
    if (this.heading != null) {
      this.state = 'done';
      this.message = 'Line set.';
    } else {
      this.state = 'direction';
      this.message = 'Line placed. Drive away across it to set its direction.';
    }
  }
  line() {
    return this.state === 'done' ? makeLine(this.center.lat, this.center.lon, this.heading, this.halfWidth) : null;
  }
}

// ---------------------------------------------------------------- export and import

const KEEP = ['id', 'kind', 'name', 'variant', 'start', 'finish', 'splits', 'sectorNames', 'minLapSec', 'minRunSec', 'maxRunSec', 'lengthM', 'turns', 'outline', 'notes', 'created'];

function sanitize(d) {
  const out = {};
  for (const k of KEEP) if (d[k] != null) out[k] = d[k];
  out.name = String(out.name || '').slice(0, 60);
  if (out.variant) out.variant = String(out.variant).slice(0, 120);
  if (out.notes) out.notes = String(out.notes).slice(0, 600);
  const line = (l) => (lineOk(l) ? makeLine(Number(l.lat), Number(l.lon), Number(l.heading), Number(l.halfWidth)) : null);
  out.start = line(d.start);
  out.finish = d.kind === 'stage' ? line(d.finish) : null;
  out.splits = Array.isArray(d.splits) ? d.splits.map(line).filter(Boolean).slice(0, 12) : [];
  out.sectorNames = Array.isArray(d.sectorNames) ? d.sectorNames.map((s) => String(s).slice(0, 20)).slice(0, 13) : undefined;
  out.outline = Array.isArray(d.outline) ? d.outline.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, 4000) : undefined;
  out.turns = Array.isArray(d.turns) ? d.turns.filter((t) => t && Number.isFinite(t.lat) && Number.isFinite(t.lon)).slice(0, 40) : undefined;
  if (out.lengthM != null && !Number.isFinite(Number(out.lengthM))) delete out.lengthM;
  // limits that protect against double counting must stay sensible whatever a file says
  if (d.kind === 'circuit') out.minLapSec = clampNum(out.minLapSec, 5, 3600, 60);
  else {
    delete out.minLapSec;
    out.minRunSec = clampNum(out.minRunSec, 3, 3600, 10);
    if (out.maxRunSec != null) out.maxRunSec = clampNum(out.maxRunSec, 60, 86400, 7200);
  }
  return out;
}

export function libraryJson(defs) {
  return JSON.stringify({ schema: 'drive-timer-library@1', exported: new Date().toISOString(), defs: defs.map(sanitize) }, null, 1);
}

/** Definitions from an exported library file; built-in ones are skipped. */
export function parseLibraryJson(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error('This is not a circuit/stage library file.');
  }
  const list = Array.isArray(j) ? j : j && j.defs;
  if (!Array.isArray(list)) throw new Error('No circuits or stages found in this file.');
  const out = [];
  for (const raw of list) {
    if (!raw || String(raw.id || '').startsWith('builtin-')) continue;
    const d = sanitize(raw);
    if (!d.id || !/^[\w-]{4,60}$/.test(d.id)) d.id = newDefId(d.kind);
    if (validateDef(d).length === 0) out.push(d);
  }
  return out;
}
