// Session-level operations: summaries, best laps, crash recovery, import and export of files.

import * as db from './db.js';
import { parseSessionCsv, sessionHeader, csvBody, sessionFileName } from './csv.js';
import { timeFixes, lapStats, lapToStored } from './engine.js';
import { driveStats, bboxOf, findRuns } from './analysis.js';
import { allDefs, getDef, linesKey } from './defs.js';
import { compactTrack } from './recorder.js';

/** Short label for lists: the definition used, or "Free drive". */
export function sessionLabel(s) {
  return s.defName || (s.mode === 'free' || !s.mode ? 'Free drive' : 'Drive');
}

/** Work out laps/runs and drive numbers for a session and store them on its record. */
export async function summarise(sess, fixes, def) {
  fixes = fixes || (await db.getFixes(sess.id));
  def = def === undefined ? await getDef(sess.defId) : def;
  const st = driveStats(fixes);
  const sum = { distanceM: st.distanceM, durationS: st.durationS, movingS: st.movingS, maxSpeed: st.maxSpeed, laps: 0, best: null, bestLap: null };
  if (def) {
    const eng = timeFixes(fixes, def);
    const ls = lapStats(eng.laps);
    sum.laps = eng.laps.length;
    sum.best = ls.best ? ls.best.time : null;
    sum.bestLap = ls.best ? ls.best.n : null;
    if (ls.best) await offerBest(def, ls.best, sess);
  }
  sess.summary = sum;
  sess.bbox = bboxOf(fixes) || sess.bbox;
  sess.distanceM = st.distanceM;
  await db.putSession(sess);
  return sess;
}

/** Keep the fastest lap or run ever recorded for a definition (used as the "best ever" reference). */
export async function offerBest(def, lap, sess) {
  if (!lap || !lap.valid) return false;
  const key = 'best:' + def.id;
  const fp = linesKey(def);
  let cur = await db.getMeta(key);
  if (cur && cur.fp !== fp) cur = null; // timed on different lines: no longer comparable
  if (cur && cur.time <= lap.time + 1e-6 && cur.sessionId !== sess.id) return false;
  if (cur && cur.sessionId === sess.id && Math.abs(cur.time - lap.time) < 1e-6) return false;
  await db.setMeta(key, lapToStored(lap, { sessionId: sess.id, startUtcMs: sess.startUtcMs, tzOffsetMin: sess.tzOffsetMin, label: 'Best ever', lapNo: lap.n, fp }));
  return true;
}

/** Best lap or run ever for a definition; rebuilt if its recording was deleted or the lines moved. */
export async function getBest(defId) {
  const rec = await db.getMeta('best:' + defId);
  if (!rec) return rec;
  const def = await getDef(defId);
  if (def && rec.fp === linesKey(def) && (await db.getSession(rec.sessionId))) return rec;
  return recomputeBest(defId);
}

/** Search every saved recording for the fastest clean lap or run of a definition. */
export async function recomputeBest(defId) {
  const def = await getDef(defId);
  await db.setMeta('best:' + defId, null);
  if (!def) return null;
  const found = await findRuns(def, await db.listSessions(), db.getFixes);
  let best = null;
  for (const f of found) if (f.lap.valid && (!best || f.lap.time < best.lap.time)) best = f;
  if (!best) return null;
  await offerBest(def, best.lap, best.session);
  return db.getMeta('best:' + defId);
}

/** Sessions left "recording" by a crash or reload are closed and kept. */
export async function recoverInterrupted(activeId) {
  const all = await db.listSessions();
  const out = [];
  for (const s of all) {
    if (s.status !== 'recording' || s.id === activeId) continue;
    s.status = 'interrupted';
    try {
      await compactTrack(s.id);
      await summarise(s);
    } catch (e) {
      await db.putSession(s);
    }
    out.push(s);
  }
  return out;
}

/** Which circuit or stage does this recording cover? Returns the definition with the most laps. */
export async function detectDefinition(fixes) {
  const bb = bboxOf(fixes);
  if (!bb) return null;
  const pad = 0.003;
  let best = null;
  for (const d of await allDefs()) {
    const pts = [d.start, d.kind === 'stage' ? d.finish : d.start];
    if (!pts.every((p) => p && p.lat >= bb[0] - pad && p.lat <= bb[2] + pad && p.lon >= bb[1] - pad && p.lon <= bb[3] + pad)) continue;
    const n = timeFixes(fixes, d).laps.length;
    if (n > 0 && (!best || n > best.n)) best = { def: d, n };
  }
  return best ? best.def : null;
}

/** Import a session file (this app's or the Android logger's). */
export async function importSessionFile(file, onProgress = () => {}) {
  onProgress('Reading file...');
  const text = await file.text();
  onProgress('Reading rows...');
  await new Promise((r) => setTimeout(r, 0));
  const p = parseSessionCsv(text);
  if (p.fixes.length < 2) throw new Error('No GPS rows found in this file.');
  onProgress('Finding circuit or stage...');
  const def = await detectDefinition(p.fixes);
  const startUtcMs = p.startUtcMs != null ? p.startUtcMs : p.fixes[0].utc;
  const tz = Number(p.meta.tz_offset_min);
  const sess = {
    id: `I${Math.round(startUtcMs)}-${Math.random().toString(36).slice(2, 6)}`,
    defId: def ? def.id : null,
    defName: def ? def.name : null,
    mode: def ? def.kind : 'free',
    startUtcMs,
    tzOffsetMin: Number.isFinite(tz) && p.meta.tz_offset_min !== '' ? tz : tzFromName(file.name, startUtcMs) ?? -new Date(startUtcMs).getTimezoneOffset(),
    status: 'imported',
    source: 'imported',
    fileName: String(file.name || '').slice(0, 80),
    device: (p.meta.device || 'unknown').slice(0, 60),
    headerLines: p.headerLines.slice(0, 40),
    motionUnits: 'si',
    counts: { L: p.fixes.length, A: p.A.length / 4, G: p.G.length / 4 },
    readStats: p.stats,
    created: Date.now(),
  };
  onProgress('Saving...');
  const chunks = [];
  let seq = 0;
  chunks.push({ sid: sess.id, seq: seq++, L: db.encodeL(p.fixes), A: new Float64Array(0), G: new Float64Array(0), E: p.events.map((e) => [e.t_us, e.name, ...e.values]) });
  const STEP = 4 * 20000;
  for (let i = 0; i < Math.max(p.A.length, p.G.length); i += STEP) {
    chunks.push({ sid: sess.id, seq: seq++, L: new Float64Array(0), A: p.A.slice(i, i + STEP), G: p.G.slice(i, i + STEP), E: [] });
  }
  await db.putSession(sess);
  await db.putMany('chunks', chunks);
  await db.saveTrack(sess.id, chunks[0].L);
  onProgress('Timing laps...');
  await summarise(sess, p.fixes, def);
  return sess;
}

/** The file name carries the local start time (session_YYYYMMDD_HHMMSS); compare it with UTC. */
export function tzFromName(name, startUtcMs) {
  const m = /session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(String(name || ''));
  if (!m || !Number.isFinite(startUtcMs)) return null;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const off = Math.round((local - startUtcMs) / 900000) * 15; // nearest 15 minutes
  return Math.abs(off) <= 14 * 60 ? off : null;
}

/** Build the session file (CSV) for sharing. */
export async function buildSessionFile(sid) {
  const sess = await db.getSession(sid);
  const chunks = await db.getChunks(sid);
  const parts = [sessionHeader(sess).join('\n') + '\n'];
  csvBody(chunks, sess, (lines) => parts.push(lines.join('\n') + '\n'));
  const name = sess.source === 'imported' && /^session_\d{8}_\d{6}\.csv$/.test(sess.fileName || '') ? sess.fileName : sessionFileName(sess.startUtcMs, sess.tzOffsetMin);
  return new File(parts, name, { type: 'text/csv' });
}

/** Share a prepared file through the iPhone share sheet, or download it. Call from a tap. */
export async function shareOrDownload(file) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
