// Test suite: synthetic courses with exactly known lap times, file-format checks, and a replay
// of the real 13 Oct 2026 Sepang session when that file is present in data/ (it is never in git).

import { timeFixes, lapStats, compareToRef, refFromLap, TimingEngine } from '../js/engine.js';
import { stadiumCourse, simulate } from '../js/synth.js';
import { parseSessionCsv, chunkToLines, sessionHeader, sessionFileName } from '../js/csv.js';
import { crossTime, wrap180 } from '../js/geo.js';
import { driveStats, gpsG, findRuns } from '../js/analysis.js';
import { LineMarker, libraryJson, parseLibraryJson, validateDef } from '../js/defs.js';

const results = [];
const numbers = {};
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: ok === null ? null : !!ok, detail }); // null = skipped
}
const fmt = (v, k = 3) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(k));

function lapErrors(engLaps, truth) {
  const trueLaps = truth.slice(1).map((t, i) => t - truth[i]);
  const errs = [];
  for (let i = 0; i < Math.min(engLaps.length, trueLaps.length); i++) errs.push(engLaps[i].time - trueLaps[i]);
  const max = errs.reduce((m, e) => Math.max(m, Math.abs(e)), 0);
  const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / Math.max(errs.length, 1));
  return { trueLaps, errs, max, rms };
}

function circuitDef(course, sLine, extra = {}) {
  return {
    kind: 'circuit',
    name: 'Synthetic stadium',
    start: course.lineAt(sLine, 25),
    splits: [course.lineAt(course.straight + course.arc / 2, 25), course.lineAt(course.straight + course.arc + 300, 25)],
    minLapSec: 20,
    ...extra,
  };
}

// ---------------------------------------------------------------- geometry basics
{
  check('geometry', 'crossing time, constant speed', Math.abs(crossTime(10, 11, 50, 50, 0.25) - 10.25) < 1e-9);
  // accelerating 50 -> 60 m/s over 1 s; distance at u = 0.5 of 55 m is 27.5 m: 50t + 5t^2 = 27.5
  const exact = (-50 + Math.sqrt(2500 + 4 * 5 * 27.5)) / 10;
  check('geometry', 'crossing time, accelerating', Math.abs(crossTime(0, 1, 50, 60, 0.5) - exact) < 1e-9, `got ${fmt(crossTime(0, 1, 50, 60, 0.5), 5)} expected ${fmt(exact, 5)}`);
  check('geometry', 'angle wrap', wrap180(350 - 10) === -20 && wrap180(10 - 350) === 20 && wrap180(180) === 180);
}

// ---------------------------------------------------------------- clean synthetic circuit
{
  const course = stadiumCourse();
  const sLine = 200;
  const def = circuitDef(course, sLine);
  const sSplit = [course.straight + course.arc / 2, course.straight + course.arc + 300];
  let worst = 0;
  let allRms = [];
  for (const [rate, phase, seed] of [
    [1, 0.37, 7],
    [1, 0.81, 8],
    [1, 0.05, 9],
    [1, 0.5, 10],
    [5, 0.13, 11],
    [10, 0.05, 12],
  ]) {
    const sim = simulate(course, { laps: 8, rate, phase, seed });
    const eng = timeFixes(
      sim.fixes.map((f) => ({ ...f })),
      def,
    );
    const truth = sim.crossings(sLine);
    const e = lapErrors(eng.laps, truth);
    worst = Math.max(worst, e.max);
    allRms.push(e.rms);
    check('synthetic circuit (clean)', `${rate} Hz, phase ${phase}: every lap found (${e.trueLaps.length})`, eng.laps.length === e.trueLaps.length, `found ${eng.laps.length}`);
    check('synthetic circuit (clean)', `${rate} Hz, phase ${phase}: lap time error < 0.05 s`, e.max < 0.05, `max ${fmt(e.max, 4)} s, rms ${fmt(e.rms, 4)} s`);
    // splits
    const tsA = truth;
    let sErr = 0;
    let nS = 0;
    for (let k = 0; k < sSplit.length; k++) {
      const tsS = sim.crossings(sSplit[k]);
      eng.laps.forEach((lap, i) => {
        const tStart = tsA[i];
        const tTrue = tsS.find((t) => t > tStart && t < tsA[i + 1]);
        if (tTrue != null && lap.splits[k] != null) {
          sErr = Math.max(sErr, Math.abs(lap.splits[k] - (tTrue - tStart)));
          nS++;
        }
      });
    }
    check('synthetic circuit (clean)', `${rate} Hz, phase ${phase}: all ${eng.laps.length * 2} splits found, error < 0.05 s`, nS === eng.laps.length * 2 && sErr < 0.05, `${nS} splits, max ${fmt(sErr, 4)} s`);
    if (rate === 1 && phase === 0.37) {
      // live delta (position based) against ground truth
      const best = eng.best;
      const ref = refFromLap(best);
      const bi = eng.laps.indexOf(best);
      let dErr = 0;
      let nD = 0;
      const refLen = ref.ds[ref.ds.length - 1];
      eng.laps.forEach((lap, i) => {
        if (lap === best) return;
        const cmp = compareToRef(lap, ref);
        for (const c of cmp) {
          // true delta: where this lap's car really was at that moment, and when the best lap's
          // car passed the same spot
          const sMod = ((sim.sAt(truth[i] + c.t) % course.length) + course.length) % course.length;
          const cand = sim.crossings(sMod).filter((t) => t >= truth[bi] - 1e-6 && t <= truth[bi + 1] + 1e-6);
          if (!cand.length) continue;
          const tb = c.d < refLen / 2 ? cand[0] : cand[cand.length - 1];
          const dTrue = c.t - (tb - truth[bi]);
          dErr = Math.max(dErr, Math.abs(c.delta - dTrue));
          nD++;
        }
      });
      numbers.deltaMaxErr = dErr;
      check('synthetic circuit (clean)', 'delta against best lap, by distance: error < 0.1 s at every point', nD > 100 && dErr < 0.1, `${nD} points, max ${fmt(dErr, 3)} s (approximate distance mapping; ideal course)`);
      const st = lapStats(eng.laps);
      const idealTrue = Math.min(...eng.laps.map((l) => l.sectors[0])) + Math.min(...eng.laps.map((l) => l.sectors[1])) + Math.min(...eng.laps.map((l) => l.sectors[2]));
      check('synthetic circuit (clean)', 'ideal lap = sum of best sectors', Math.abs(st.ideal - idealTrue) < 1e-9 && st.ideal <= st.best.time + 1e-9, `ideal ${fmt(st.ideal)} best ${fmt(st.best.time)}`);
    }
  }
  numbers.cleanWorstLapErr = worst;
  numbers.cleanRms = Math.max(...allRms);
}

// ---------------------------------------------------------------- noisy synthetic circuit
{
  const course = stadiumCourse();
  const def = circuitDef(course, 200);
  const errsAll = [];
  let found = 0;
  let expected = 0;
  for (let seed = 21; seed < 31; seed++) {
    const sim = simulate(course, { laps: 8, rate: 1, phase: (seed * 0.137) % 1, seed, noise: 2, speedNoise: 0.3 });
    const eng = timeFixes(sim.fixes, def);
    const e = lapErrors(eng.laps, sim.crossings(200));
    found += eng.laps.length;
    expected += e.trueLaps.length;
    errsAll.push(...e.errs);
  }
  const rms = Math.sqrt(errsAll.reduce((s, e) => s + e * e, 0) / errsAll.length);
  const max = errsAll.reduce((m, e) => Math.max(m, Math.abs(e)), 0);
  numbers.noisyRms = rms;
  numbers.noisyMax = max;
  check('synthetic circuit (2 m GPS noise)', `every lap found (${expected})`, found === expected, `found ${found}`);
  check('synthetic circuit (2 m GPS noise)', 'lap time error typical of phone GPS (rms < 0.15 s)', rms < 0.15, `rms ${fmt(rms)} s, worst ${fmt(max)} s over ${errsAll.length} laps`);
}

// ---------------------------------------------------------------- rejections
{
  const course = stadiumCourse();
  const def = circuitDef(course, 200);
  const rev = simulate(course, { laps: 5, rate: 1, reverse: true, seed: 3 });
  const eng = timeFixes(rev.fixes, def);
  check('rejections', 'driving the wrong way round: no laps', eng.laps.length === 0, `laps ${eng.laps.length}`);

  // small course (about 17 s a lap) with a 60 s minimum lap time: no lap shorter than 60 s
  const small = stadiumCourse({ straight: 120, radius: 30 });
  const def2 = { ...circuitDef(small, 60), minLapSec: 60 };
  const sim2 = simulate(small, { laps: 14, rate: 1, vMax: 30, seed: 4 });
  const eng2 = timeFixes(sim2.fixes, def2);
  const shortest = Math.min(...eng2.laps.map((l) => l.time));
  check('rejections', 'double triggers: no lap shorter than the minimum lap time', eng2.laps.length > 0 && shortest >= 60, `${eng2.laps.length} laps, shortest ${fmt(shortest, 2)} s`);

  // stopped just past the line with GPS jitter back and forth across it
  const L = course.lineAt(200);
  const fixes = [];
  const sim3 = simulate(course, { laps: 1, rate: 1, seed: 5 });
  for (const f of sim3.fixes) fixes.push(f);
  const tEnd = fixes[fixes.length - 1].t;
  const [cx, cy] = course.proj.toXY(L.lat, L.lon);
  for (let i = 1; i <= 30; i++) {
    const x = cx + (i % 2 ? -2.5 : 2.5);
    const [lat, lon] = course.proj.toLatLon(x, cy + 0.3);
    fixes.push({ t: tEnd + 200 + i, lat, lon, speed: 0.2, hAcc: 5 });
  }
  const eng3 = timeFixes(fixes, def);
  check('rejections', 'GPS jitter while stopped on the line: no extra laps', eng3.laps.length === 1, `laps ${eng3.laps.length}`);

  // arming: a line marked where the car stands does not trigger as the car drives off
  const defArm = { ...def, start: course.lineAt(10) };
  const sim4 = simulate(course, { laps: 2, rate: 1, seed: 6, startS: 0 + course.length * 0 + 2 });
  const eng4 = timeFixes(sim4.fixes, defArm);
  const firstStart = sim4.crossings(10)[0];
  check('rejections', 'line marked at the standing car: first lap starts on the next pass, not on pulling away', eng4.laps.length >= 1 && eng4.laps[0].t0 > firstStart + 5, `first lap starts at ${fmt(eng4.laps[0] && eng4.laps[0].t0, 1)} s`);
}

// ---------------------------------------------------------------- road stage (point to point)
{
  const course = stadiumCourse();
  const sStart = 100;
  const sFinish = course.straight + course.arc + 400;
  const sSplit = course.straight + course.arc / 2;
  const def = { kind: 'stage', name: 'Synthetic stage', start: course.lineAt(sStart), finish: course.lineAt(sFinish), splits: [course.lineAt(sSplit)], minRunSec: 10 };
  const sim = simulate(course, { laps: 4, rate: 1, seed: 13, phase: 0.6 });
  const eng = timeFixes(sim.fixes, def);
  const tS = sim.crossings(sStart);
  const tF = sim.crossings(sFinish);
  const runsTrue = [];
  for (const t of tS) {
    const f = tF.find((x) => x > t);
    if (f != null) runsTrue.push(f - t);
  }
  let maxErr = 0;
  eng.laps.forEach((r, i) => (maxErr = Math.max(maxErr, Math.abs(r.time - runsTrue[i]))));
  check('road stage', `every run found (${runsTrue.length})`, eng.laps.length === runsTrue.length, `found ${eng.laps.length}`);
  check('road stage', 'run time error < 0.05 s', maxErr < 0.05, `max ${fmt(maxErr, 4)} s`);
  check('road stage', 'split recorded on every run', eng.laps.every((r) => r.splits[0] != null));
  const rev = timeFixes(simulate(course, { laps: 3, rate: 1, reverse: true, seed: 14 }).fixes, def);
  check('road stage', 'driving the stage the wrong way: no runs', rev.laps.length === 0, `runs ${rev.laps.length}`);
  // retroactive: find runs across several recordings
  const recs = [1, 2, 3].map((k) => ({ id: 'r' + k, fixes: simulate(course, { laps: k, rate: 1, seed: 40 + k }).fixes }));
  recs.push({ id: 'elsewhere', fixes: simulate(stadiumCourse({ lat0: 3.2, lon0: 101.6 }), { laps: 2, rate: 1, seed: 50 }).fixes });
  const found = await findRuns(
    def,
    recs.map((r) => ({ id: r.id, bbox: bboxOf(r.fixes) })),
    async (id) => recs.find((r) => r.id === id).fixes,
  );
  const per = {};
  for (const f of found) per[f.sessionId] = (per[f.sessionId] || 0) + 1;
  check('road stage', 'retroactive search times runs in every past recording that covers the stage, skips others', per.r1 >= 1 && per.r2 >= 2 && per.r3 >= 3 && !per.elsewhere, JSON.stringify(per));
}

function bboxOf(fixes) {
  let a = 90, b = 180, c = -90, d = -180;
  for (const f of fixes) {
    a = Math.min(a, f.lat);
    b = Math.min(b, f.lon);
    c = Math.max(c, f.lat);
    d = Math.max(d, f.lon);
  }
  return [a, b, c, d];
}

// ---------------------------------------------------------------- free drive
{
  const course = stadiumCourse();
  const sim = simulate(course, { laps: 2, rate: 1, seed: 15 });
  const st = driveStats(sim.fixes);
  const trueDist = sim.fixes.length > 1 ? (sim.fixes[sim.fixes.length - 1].t - sim.fixes[0].t) * 0 : 0;
  check('free drive', 'distance, duration and moving time computed', st.distanceM > 2 * course.length && st.durationS > 60 && st.movingS > 60 && st.maxSpeed > 30, `distance ${fmt(st.distanceM / 1000, 2)} km, duration ${fmt(st.durationS, 0)} s, moving ${fmt(st.movingS, 0)} s, max ${fmt(st.maxSpeed * 3.6, 0)} km/h`);
  void trueDist;
  const g = gpsG(sim.fixes);
  const latMax = Math.max(...g.map((p) => Math.abs(p.lat)));
  check('free drive', 'G from GPS: cornering about 1 g on the synthetic 1 g corners', latMax > 0.85 && latMax < 1.2, `peak lateral ${fmt(latMax, 2)} g`);
}

// ---------------------------------------------------------------- marking lines and the library file
{
  const lat0 = 2.75;
  const lon0 = 101.7;
  const mPerDegLat = 110574;
  // start line: five fixes while stopped (small jitter), then the car drives off to the north-east
  const m = new LineMarker({ direction: 'departure', halfWidth: 15 });
  m.push({ perf: 0, lat: lat0, lon: lon0, speed: 3, hAcc: 4 }); // still rolling: ignored
  for (let i = 0; i < 5; i++) m.push({ perf: 1000 * (i + 1), lat: lat0 + (i % 2 ? 1e-6 : -1e-6), lon: lon0 + (i % 3 ? 1e-6 : 0), speed: 0.1, hAcc: 4 });
  const waiting = m.state;
  m.push({ perf: 7000, lat: lat0 + 0.00006, lon: lon0 + 0.00006, speed: 4, hAcc: 4 }); // about 9 m away: not yet
  m.push({ perf: 8000, lat: lat0 + 0.00014, lon: lon0 + 0.00014, speed: 8, hAcc: 4 }); // about 22 m away
  const l = m.line();
  const offM = l ? Math.hypot((l.lat - lat0) * mPerDegLat, (l.lon - lon0) * mPerDegLat) : null;
  check('marking lines', 'start line marked on the spot: position averaged while stopped, direction from driving away', waiting === 'direction' && l && Math.abs(l.heading - 45) < 2 && offM < 0.5, l ? `heading ${l.heading}°, ${offM.toFixed(2)} m from the spot` : 'no line');
  // finish line: the car arrived from the south and stopped
  const trail = [0, 1, 2, 3].map((k) => ({ perf: k * 1000, lat: lat0 - 0.0004 + k * 0.0001, lon: lon0, speed: 10, hAcc: 4 }));
  const m2 = new LineMarker({ direction: 'arrival', halfWidth: 15, trail });
  for (let i = 0; i < 5; i++) m2.push({ perf: 10000 + i * 1000, lat: lat0, lon: lon0, speed: 0, hAcc: 5 });
  const l2 = m2.line();
  check('marking lines', 'finish line marked on the spot: direction is the way the car arrived', l2 && (l2.heading < 2 || l2.heading > 358), l2 ? `heading ${l2.heading}°` : 'no line');
  const m3 = new LineMarker({ direction: 'departure' });
  for (let i = 0; i < 4; i++) m3.push({ perf: i * 1000, lat: lat0, lon: lon0, speed: 0, hAcc: 4 });
  m3.push({ perf: 5000, lat: lat0, lon: lon0, speed: 2, hAcc: 4 }); // moved before five fixes: start again
  check('marking lines', 'moving during marking starts the averaging again', m3.samples.length === 0 && m3.state === 'collecting', m3.message);
  // library export and import keep circuits and stages, skip built-ins and bad entries
  const course = stadiumCourse();
  const stage = { id: 'stage-test1', kind: 'stage', name: 'Hill <b>climb</b>', start: course.lineAt(100), finish: course.lineAt(900), splits: [], minRunSec: 10 };
  const text = libraryJson([stage, { id: 'builtin-x', kind: 'circuit', name: 'Built in', start: course.lineAt(10), splits: [] }]);
  const back = parseLibraryJson(text.replace('"builtin-x"', '"builtin-sepang-gp"'));
  const bad = parseLibraryJson(JSON.stringify({ defs: [{ id: 'x1', kind: 'stage', name: 'No finish', start: course.lineAt(100) }] }));
  check('marking lines', 'library file: stage survives export and import; built-ins and incomplete entries skipped', back.length === 1 && back[0].name === 'Hill <b>climb</b>' && validateDef(back[0]).length === 0 && bad.length === 0, `${back.length} imported, ${bad.length} incomplete accepted`);
}

// ---------------------------------------------------------------- file format
{
  const sess = { source: 'recorded', device: 'iPhone', platform: 'test', startUtcMs: 1767225600000, tzOffsetMin: 480, accelSign: -1, gyroMap: 'w3c', mode: 'circuit', defName: 'Synthetic' };
  const L = [];
  const fx = simulate(stadiumCourse(), { laps: 1, rate: 1, seed: 16 }).fixes;
  for (const f of fx) L.push(Math.round(f.t * 1e6), f.lat, f.lon, -9999, f.speed, f.bearing, f.hAcc, -1, -1, f.utc, 12);
  const chunk = {
    L: Float64Array.from(L),
    A: Float64Array.from([5000, 0.1, 0.2, -9.81, 15000, 0.0, 0.0, -9.8]),
    G: Float64Array.from([6000, 10, 20, 30]),
    E: [[0, 'START'], [fx[fx.length - 1].t * 1e6 + 1, 'STOP']],
  };
  const text = [...sessionHeader(sess), ...chunkToLines(chunk, sess)].join('\n') + '\n';
  const back = parseSessionCsv(text);
  const maxPos = Math.max(...back.fixes.map((f, i) => Math.max(Math.abs(f.lat - fx[i].lat), Math.abs(f.lon - fx[i].lon))));
  check('file format', 'write then read: every GPS row back, positions within 1e-8 degrees', back.fixes.length === fx.length && maxPos < 1e-8, `${back.fixes.length}/${fx.length} rows, max ${maxPos.toExponential(1)}`);
  check('file format', 'iPhone acceleration converted to the format sign (face up reads +9.81 on z)', Math.abs(back.A[3] - 9.81) < 1e-6 && Math.abs(back.A[1] + 0.1) < 1e-6, `z ${back.A[3]}`);
  const rad = Math.PI / 180;
  check('file format', 'rotation rate converted to rad/s on W3C axes (gx = beta, gy = gamma, gz = alpha)', Math.abs(back.G[1] - 20 * rad) < 1e-6 && Math.abs(back.G[2] - 30 * rad) < 1e-6 && Math.abs(back.G[3] - 10 * rad) < 1e-6);
  check('file format', 'header carries start_utc_ms, device and rows legend', back.meta.start_utc_ms === '1767225600000' && back.meta.device === 'iPhone' && !!back.meta.rows);
  check('file format', 'every GPS row carries UTC time', back.fixes.every((f) => f.utc > 1.7e12));
  check('file format', 'file name uses local start time', sessionFileName(1767225600000, 480) === 'session_20260101_080000.csv', sessionFileName(1767225600000, 480));
  const messy = [
    '# device,iPhone',
    '# start_utc_ms,1000',
    '',
    'L,2000000,2.7,101.7,10,20,90,4,-1,-1,1002000,5',
    'X,1,unknown row',
    'L,1000000,2.69,101.69,10,20,90,4,-1,-1,1001000,5\r',
    '   ',
    'A,1000,0.1,0.2,9.8',
    'Q,3,4',
    'L,1500000,2.695,101.695,10,20,90,4,-1,-1,1001500,5',
    'L,3000000,2.71,101.71,10,20,90,4,-1,-1',
  ].join('\n');
  const m = parseSessionCsv(messy);
  check('file format', 'reader tolerates blank lines, unknown rows, CRLF, out-of-order GPS rows and a truncated last line', m.fixes.length === 3 && m.fixes[0].t === 1 && m.fixes[2].t === 2 && m.stats.unknown === 2 && m.stats.bad === 1 && m.stats.outOfOrderL >= 1, JSON.stringify(m.stats));
}

// ---------------------------------------------------------------- real session (only if the file is present locally)
async function fetchText(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    return r.ok ? await r.text() : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function realSession() {
  // The recording and its expected results stay on the laptop in data/ (never in git). The
  // expected values come from the independent Python checker:
  //   python tools/lap_check.py <session.csv> --line <S/F> --split <S1> --split <S2> --json data/.../expected.json
  const group = 'real session (only on the laptop that holds the file)';
  const base = '../data/sepang-2026-10-13/';
  const gpsText = await fetchText(base + 'session_20261013_095638_gps.csv');
  const expText = gpsText ? await fetchText(base + 'expected.json') : null;
  if (!gpsText || !expText) {
    check(group, 'recording and expected results present in data/', null, 'not present here: skipped');
    return;
  }
  const exp = JSON.parse(expText);
  const lib = await (await fetch('../builtin/library.json', { cache: 'no-store' })).json();
  const sepang = lib.defs.find((d) => d.id === 'builtin-sepang-gp');
  const parsed = parseSessionCsv(gpsText);
  const t0 = performance.now();
  const eng = timeFixes(parsed.fixes, sepang);
  const ms = performance.now() - t0;
  const st = lapStats(eng.laps);
  const expBest = Math.min(...exp.laps);
  const maxDiff = Math.max(...eng.laps.map((l, i) => Math.abs(l.time - exp.laps[i])));
  numbers.real = { laps: eng.laps.map((l) => +l.time.toFixed(3)), best: st.best && +st.best.time.toFixed(3), bestLap: st.best && st.best.n, ideal: st.ideal && +st.ideal.toFixed(3), median: st.median && +st.median.toFixed(3), sectorsOfBest: st.best && st.best.sectors.map((s) => +s.toFixed(2)), ms: +ms.toFixed(1), fixes: parsed.fixes.length };
  check(group, `GPS rows read (${exp.fixes})`, parsed.fixes.length === exp.fixes, `${parsed.fixes.length} fixes`);
  check(group, `same number of laps as the Python checker (${exp.laps.length})`, eng.laps.length === exp.laps.length, `found ${eng.laps.length}`);
  check(group, 'same best lap as the Python checker', st.best && Math.abs(st.best.time - expBest) < 0.001, `best ${fmt(st.best && st.best.time)} s (lap ${st.best && st.best.n})`);
  check(group, 'every lap agrees with the independent Python checker within 1 ms', eng.laps.length === exp.laps.length && maxDiff < 0.001, `max difference ${fmt(maxDiff * 1000, 3)} ms`);
  // sector splits: the first crossing of each sector line inside each lap
  let sDiff = 0;
  let nSplits = 0;
  eng.laps.forEach((lap, i) => {
    const a = exp.crossings[i];
    const b = exp.crossings[i + 1];
    exp.splitCrossings.forEach((cs, k) => {
      const tc = cs.find((t) => t > a && t < b);
      if (tc != null && lap.splits[k] != null) {
        sDiff = Math.max(sDiff, Math.abs(lap.splits[k] - (tc - a)));
        nSplits++;
      }
    });
  });
  check(group, 'sector splits found on every lap and agree with the Python checker within 2 ms', eng.laps.every((l) => l.splits.every((s) => s != null)) && nSplits === eng.laps.length * exp.splitCrossings.length && sDiff < 0.002, `${nSplits} splits, max difference ${fmt(sDiff * 1000, 2)} ms`);
  check(group, 'ideal lap no slower than best lap', st.ideal != null && st.ideal <= st.best.time, `ideal ${fmt(st.ideal)} s`);

  // replay through a fresh engine one fix at a time, as the live screen does, with the delta
  const live = new TimingEngine(sepang);
  let deltas = 0;
  let maxAbs = 0;
  for (const f of parsed.fixes) {
    live.push(f);
    const s = live.status(f.t);
    if (s.delta != null) {
      deltas++;
      maxAbs = Math.max(maxAbs, Math.abs(s.delta));
    }
  }
  check(group, 'live delta available from the second lap on', deltas > 1500 && maxAbs < 20, `${deltas} fixes with a delta, largest ${fmt(maxAbs, 2)} s`);

  // all-kinds sample (first 60 s of the raw file, last line deliberately truncated)
  try {
    const sampleText = await fetchText(base + 'session_20261013_095638_sample60s.csv');
    if (sampleText) {
      const s = parseSessionCsv(sampleText);
      numbers.sample = { A: s.A.length / 4, G: s.G.length / 4, L: s.fixes.length, S: s.stats.S, K: s.stats.K, E: s.events.map((e) => e.name), bad: s.stats.bad };
      check(group, 'raw sample with every row kind parses; truncated last line rejected', s.A.length > 1000 && s.G.length > 1000 && s.fixes.length > 50 && s.stats.bad === 1 && s.events.some((e) => e.name === 'CAL'), JSON.stringify(numbers.sample));
    }
  } catch (e) {
    /* optional */
  }
}

await realSession();

// ---------------------------------------------------------------- render
const pass = results.filter((r) => r.ok === true).length;
const skipped = results.filter((r) => r.ok === null).length;
const run = results.length - skipped;
const out = document.getElementById('out');
const sum = document.getElementById('summary');
sum.textContent = `${pass} of ${run} checks passed${skipped ? `, ${skipped} skipped (private data not on this computer)` : ''}`;
sum.className = pass === run ? 'ok' : 'bad';
let group = '';
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    const h = document.createElement('h2');
    h.textContent = group;
    out.appendChild(h);
  }
  const row = document.createElement('div');
  row.className = 'row ' + (r.ok === null ? 'skip' : r.ok ? 'ok' : 'bad');
  const a = document.createElement('span');
  a.className = 'mark';
  a.textContent = r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
  const b = document.createElement('span');
  b.textContent = r.name;
  const c = document.createElement('span');
  c.className = 'detail';
  c.textContent = r.detail;
  row.append(a, b, c);
  out.appendChild(row);
}
document.getElementById('json').textContent = JSON.stringify({ pass, total: run, skipped, failed: results.filter((r) => r.ok === false), numbers }, null, 1);
