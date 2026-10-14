// Sessions tab: the list of recordings, import, and the analysis of one recording.

import { h, icon, toast, sheet, confirmSheet, fmtLap, fmtDelta, fmtDist, fmtDuration, fmtDateTime, kmh } from './ui.js';
import * as db from './db.js';
import { allDefs, getDef } from './defs.js';
import { sessionLabel, importSessionFile, buildSessionFile, shareOrDownload, summarise } from './store.js';
import { timeFixes, lapStats, refFromLap, refFromStored, compareToRef, lapToStored } from './engine.js';
import { driveStats, gpsG, driveTrace, findRuns } from './analysis.js';
import { lineChart, trackMap, ggChart, sectorBars, outlineIcon } from './charts.js';
import { pickOnRecording } from './library.js';

const ACCURACY_NOTE = 'Phone GPS at about 1 update a second: lap and sector times are good to roughly 0.1 to 0.3 s. Treat smaller differences as a tie.';

// ------------------------------------------------------------------ list

export async function renderSessions(app, root) {
  const list = await db.listSessions();
  const fileIn = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'hidden', onchange: () => doImport(app, fileIn) });
  const head = h('div', { class: 'screen-head' }, h('h1', null, 'Sessions'), h('button', { class: 'btn small', onclick: () => fileIn.click() }, icon('import'), 'Import file'), fileIn);
  if (!list.length) {
    root.replaceChildren(head, h('div', { class: 'empty-state' }, icon('list'), h('p', null, 'No recordings yet.'), h('p', { class: 'small' }, 'Start one on the Drive tab, or import a session file (for example from the Android logger).')));
    return;
  }
  const items = list.map((s) => {
    const sum = s.summary || {};
    const right =
      sum.best != null
        ? h('div', { class: 'right' }, h('div', { class: 'big' }, fmtLap(sum.best)), h('div', { class: 'meta' }, `best of ${sum.laps}`))
        : h('div', { class: 'right' }, h('div', { class: 'big' }, fmtDist(s.distanceM || sum.distanceM || 0)), h('div', { class: 'meta' }, sum.laps === 0 && s.defId ? 'no laps' : ''));
    const chips = [];
    if (s.status === 'interrupted') chips.push(h('span', { class: 'chip warn' }, 'interrupted'));
    if (s.status === 'recording') chips.push(h('span', { class: 'chip rec' }, 'recording'));
    if (s.source === 'imported') chips.push(h('span', { class: 'chip' }, 'imported'));
    return h(
      'a',
      { class: 'item', href: '#/session/' + encodeURIComponent(s.id) },
      outlineIcon(s.thumb || null, 46),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, sessionLabel(s)), h('div', { class: 'meta' }, fmtDateTime(s.startUtcMs, s.tzOffsetMin)), h('div', { class: 'meta' }, [sum.durationS != null ? fmtDuration(sum.durationS) : null, ...chips].filter(Boolean).flatMap((x, i) => (i ? [' ', x] : [x])))),
      right,
    );
  });
  root.replaceChildren(head, h('div', { class: 'list' }, items));
}

async function doImport(app, input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const status = h('p', { class: 'muted' }, 'Starting...');
  const sh = sheet('Importing ' + file.name, status);
  try {
    const sess = await importSessionFile(file, (m) => (status.textContent = m));
    await addThumb(sess);
    sh.close();
    toast(sess.defName ? `Imported: ${sess.defName}, ${sess.summary.laps} laps` : 'Imported as a free drive');
    location.hash = '#/session/' + encodeURIComponent(sess.id);
  } catch (e) {
    status.textContent = 'Could not import: ' + (e && e.message ? e.message : e);
  }
}

async function addThumb(sess) {
  const fixes = await db.getFixes(sess.id);
  const step = Math.max(1, Math.floor(fixes.length / 120));
  sess.thumb = fixes.filter((f, i) => i % step === 0).map((f) => [Math.round(f.lat * 1e5) / 1e5, Math.round(f.lon * 1e5) / 1e5]);
  await db.putSession(sess);
}

// ------------------------------------------------------------------ analysis

export async function renderSession(app, root, id) {
  const sess = await db.getSession(id);
  if (!sess) {
    root.replaceChildren(h('div', { class: 'empty-state' }, h('p', null, 'This recording is no longer on the phone.'), h('a', { class: 'btn', href: '#/sessions' }, 'Back to sessions')));
    return;
  }
  const fixes = await db.getFixes(id);
  if (!sess.thumb && fixes.length) await addThumb(sess);
  app.view = app.view || {};
  const vs = (app.view[id] = app.view[id] || {});
  const defId = vs.defId !== undefined ? vs.defId : sess.defId;
  const def = defId ? await getDef(defId) : null;
  const exportBtn = h('button', { class: 'btn small', onclick: () => prepareExport(sess) }, icon('share'), 'Export');
  const head = h(
    'div',
    null,
    h('div', { class: 'screen-head' }, h('a', { class: 'icon-btn', href: '#/sessions', 'aria-label': 'Back to sessions', icon: 'back' }), h('h1', { class: 'title-sm' }, def ? def.name : 'Free drive'), exportBtn),
    h('div', { class: 'muted small' }, fmtDateTime(sess.startUtcMs, sess.tzOffsetMin), sess.source === 'imported' ? ` · imported from ${sess.device || 'file'}` : '', sess.status === 'interrupted' ? ' · recording was interrupted (saved up to that point)' : ''),
  );
  const asBtn = h('button', { class: 'btn small', onclick: () => chooseAnalysis(app, sess, fixes, vs) }, icon('track'), def ? 'Analyse as...' : 'Time with a circuit or stage...');
  const tools = h(
    'div',
    { class: 'btn-row' },
    asBtn,
    h('button', { class: 'btn small', onclick: () => pickOnRecording(app, sess, fixes) }, icon('flag'), 'Define a stage here'),
    h('button', { class: 'btn small danger', onclick: () => deleteSession(sess) }, icon('trash'), 'Delete'),
  );
  root.replaceChildren(head);
  if (fixes.length < 2) {
    root.append(h('p', { class: 'muted' }, 'No GPS data in this recording.'), tools);
    return;
  }
  if (!def) {
    renderFree(root, fixes);
    root.append(tools);
    return;
  }
  renderTimed(app, root, sess, fixes, def, vs);
  root.append(tools);
}

async function chooseAnalysis(app, sess, fixes, vs) {
  const defs = await allDefs();
  const bb = sess.bbox;
  const pad = 0.003;
  const near = defs.filter((d) => {
    if (!bb) return true;
    const pts = [d.start, d.kind === 'stage' ? d.finish : d.start];
    return pts.every((p) => p && p.lat >= bb[0] - pad && p.lat <= bb[2] + pad && p.lon >= bb[1] - pad && p.lon <= bb[3] + pad);
  });
  const pick = (id) => {
    vs.defId = id;
    vs.sel = null;
    vs.ref = null;
    sh.close();
    app.route();
  };
  const body = h(
    'div',
    { class: 'list' },
    h('button', { class: 'item', onclick: () => pick(null) }, h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Free drive'), h('div', { class: 'meta' }, 'Route, speed and G-forces'))),
    near.map((d) => h('button', { class: 'item', onclick: () => pick(d.id) }, outlineIcon(d.outline || null, 40), h('div', { class: 'grow' }, h('div', { class: 'title' }, d.name), h('div', { class: 'meta' }, d.kind === 'stage' ? 'Road stage' : 'Circuit')))),
    near.length ? null : h('p', { class: 'small muted' }, 'No saved circuit or stage lies on this route. Use "Define a stage here".'),
  );
  const sh = sheet('Analyse this recording as', body);
}

async function deleteSession(sess) {
  const ok = await confirmSheet({ title: 'Delete this recording?', message: 'It is removed from this phone. Export it first if you want to keep a copy.', confirm: 'Delete', danger: true });
  if (!ok) return;
  await db.deleteSession(sess.id);
  toast('Recording deleted.');
  location.hash = '#/sessions';
}

/** Two taps: prepare the file (may take a moment), then share it from a fresh tap (Safari rule). */
async function prepareExport(sess) {
  const status = h('p', { class: 'muted' }, 'Preparing the file...');
  const body = h('div', null, status);
  const sh = sheet('Export session file', body);
  try {
    const file = await buildSessionFile(sess.id);
    status.textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB. Plain CSV in the shared format; every GPS row carries UTC time for the heart-rate merge.`;
    body.append(
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              const r = await shareOrDownload(file);
              if (r !== 'cancelled') sh.close();
            },
          },
          icon('share'),
          'Share or save',
        ),
      ),
      h('p', { class: 'small muted' }, 'On iPhone the share sheet offers Save to Files and AirDrop to the laptop.'),
    );
  } catch (e) {
    status.textContent = 'Could not build the file: ' + (e.message || e);
  }
}

// ------------------------------------------------------------------ free drive

function renderFree(root, fixes) {
  const st = driveStats(fixes);
  const trace = driveTrace(fixes);
  const step = Math.max(1, Math.floor(trace.length / 1500));
  const g = gpsG(fixes).filter((p, i) => i % step === 0);
  root.append(
    h('div', { class: 'hero' }, h('div', { class: 'lbl' }, 'Distance'), h('div', { class: 'val' }, fmtDist(st.distanceM))),
    h(
      'div',
      { class: 'tiles' },
      tile('Duration', fmtDuration(st.durationS)),
      tile('Moving time', fmtDuration(st.movingS)),
      tile('Top speed', kmh(st.maxSpeed), 'km/h'),
      tile('Average moving', kmh(st.avgMovingSpeed), 'km/h'),
    ),
  );
  const map = trackMap({ title: 'Route coloured by speed', sub: 'GPS path only, no map tiles', path: trace, annotate: false });
  const speed = lineChart({
    title: 'Speed along the route',
    series: [{ name: 'Speed', color: 'var(--series-1)', points: trace.filter((p, i) => i % step === 0).map((p) => ({ x: p.d / 1000, y: p.v * 3.6, lat: p.lat, lon: p.lon })) }],
    xFmt: (v) => `${+v.toFixed(1)} km`,
    yFmt: (v) => `${Math.round(v)}`,
    tipFmt: (v) => `${Math.round(v)} km/h`,
    onCursor: (x) => {
      if (x == null) return map.setMarker(null);
      const p = trace[Math.min(trace.length - 1, Math.max(0, bisectD(trace, x * 1000)))];
      map.setMarker(p.lat, p.lon);
    },
    table: {
      columns: ['km', 'km/h'],
      rows: sampleEvery(trace, 500).map((p) => [(p.d / 1000).toFixed(1), kmh(p.v)]),
    },
  });
  const gg = ggChart({ title: 'G-forces from GPS', sub: 'Longitudinal from change in speed, lateral from speed × turn rate', series: [{ name: 'Drive', color: 'var(--series-1)', pts: g }], table: ggTable(g) });
  root.append(map.el, speed.el, gg.el, note(ACCURACY_NOTE));
}

function bisectD(arr, d) {
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (arr[m].d < d) lo = m;
    else hi = m;
  }
  return Math.abs(arr[lo].d - d) < Math.abs(arr[hi].d - d) ? lo : hi;
}

function sampleEvery(trace, metres) {
  const out = [];
  let next = 0;
  for (const p of trace) {
    if (p.d >= next) {
      out.push(p);
      next = p.d + metres;
    }
  }
  return out;
}

// ------------------------------------------------------------------ circuit or stage

function renderTimed(app, root, sess, fixes, def, vs) {
  const eng = timeFixes(fixes, def);
  const laps = eng.laps;
  const st = lapStats(laps);
  const word = def.kind === 'stage' ? 'run' : 'lap';
  const Word = def.kind === 'stage' ? 'Run' : 'Lap';
  const drive = driveStats(fixes);
  if (!laps.length) {
    root.append(
      h('div', { class: 'banner' }, icon('warn'), h('div', null, h('strong', null, `No ${word}s found with these lines.`), h('div', { class: 'small' }, def.kind === 'stage' ? 'The recording must cross the start line and then the finish line in the direction they point.' : 'The recording must cross the start/finish line twice in the direction it points. You can analyse it as a free drive instead.'))),
    );
    renderFree(root, fixes);
    return;
  }
  const best = st.best || laps[0];
  const sel = laps.find((l) => l.n === vs.sel) || best;
  vs.sel = sel.n;
  const secNames = def.sectorNames || (def.splits || []).map((_, i) => `S${i + 1}`).concat([`S${(def.splits || []).length + 1}`]);
  const nSec = sel.sectors ? sel.sectors.length : 0;

  // hero and tiles
  root.append(
    h('div', { class: 'hero' }, h('div', { class: 'lbl' }, `Best ${word}`), h('div', { class: 'val' }, fmtLap(best.time)), h('div', { class: 'sub' }, `${Word} ${best.n} of ${laps.length}`)),
    h(
      'div',
      { class: 'tiles' },
      st.ideal != null ? tile('Ideal lap', fmtLap(st.ideal), 'best sectors added') : null,
      tile(`${Word}s`, String(laps.length), st.validCount < laps.length ? `${laps.length - st.validCount} with GPS gaps` : 'all clean GPS'),
      tile(`Median ${word}`, fmtLap(st.median)),
      tile('Top speed', kmh(drive.maxSpeed), 'km/h'),
    ),
    note(ACCURACY_NOTE),
  );

  // reference for comparisons
  const refInfo = resolveRef(vs, laps, best, eng);
  const ref = refInfo.ref;

  // lap table
  const tbl = h('table', { class: 'laps' });
  const headRow = h('tr', null, h('th', null, Word), h('th', null, 'Time'), h('th', null, 'Δ best'), nSec > 1 ? secNames.slice(0, nSec).map((n) => h('th', null, n)) : null);
  const body = h('tbody');
  for (const l of laps) {
    const d = l.time - best.time;
    const tr = h(
      'tr',
      {
        class: (l === sel ? 'sel ' : '') + (refInfo.lap === l ? 'ref' : ''),
        onclick: () => {
          vs.sel = l.n;
          app.route();
        },
      },
      h('td', null, String(l.n), ' ', l === best ? icon('star', 'ic star') : null, !l.valid ? h('span', { class: 'flag', title: 'GPS gap in this lap' }, ' gap') : null),
      h('td', null, fmtLap(l.time)),
      h('td', { class: d > 0.0005 ? 'dpos' : '' }, l === best ? '' : fmtDelta(d)),
      nSec > 1
        ? l.sectors.map((sv, i) => h('td', { class: sv != null && st.bestSectors[i] != null && Math.abs(sv - st.bestSectors[i]) < 1e-9 ? 'bestcell' : '' }, sv != null ? fmtLap(sv) : '-'))
        : null,
    );
    body.append(tr);
  }
  tbl.append(h('thead', null, headRow), body);
  root.append(
    h('h2', { class: 'section' }, `${Word}s`),
    h('div', { class: 'small muted', style: { marginBottom: '6px' } }, `Tap a ${word} to analyse it. `, h('span', { class: 'star' }, icon('star', 'ic star')), ` best ${word}; shaded cells are the best sector times (they add up to the ideal lap).`),
    h('div', { class: 'card table-wrap' }, tbl),
  );

  // comparison controls
  const cmpBtn = h('button', { class: 'btn small', onclick: () => chooseReference(app, sess, def, laps, vs) }, icon('flip'), 'Compare with...');
  root.append(
    h('h2', { class: 'section' }, `${Word} ${sel.n} against ${refInfo.label}`),
    h('div', { class: 'row' }, h('div', { class: 'grow small muted' }, 'Blue: this ' + word + '. Orange: the reference.'), cmpBtn),
  );
  if (!ref || (refInfo.lap === sel && !refInfo.external)) {
    root.append(h('p', { class: 'muted small' }, `This is the reference ${word}. Pick another ${word} in the table, or compare with another session.`));
  }

  const mine = compareToRef(sel, ref || refFromLap(sel));
  const refTrace = ref ? refTraceFromRef(ref) : null;
  // sector bars
  if (nSec > 1 && ref && ref.splits && refInfo.lap !== sel) {
    const refSectors = sectorsOf(ref);
    const rows = sel.sectors.map((v, i) => ({ label: `${secNames[i] || 'S' + (i + 1)}`, delta: v != null && refSectors[i] != null ? v - refSectors[i] : null }));
    root.append(sectorBars({ title: 'Sector by sector', sub: `Time gained or lost against ${refInfo.label}`, rows }).el);
  }
  // linked charts
  const selPts = mine.map((c) => ({ x: c.d, y: c.v * 3.6 }));
  const refPts = refTrace ? refTrace.map((p) => ({ x: p.d, y: p.v * 3.6 })) : [];
  const locate = (x) => {
    let bi = 0;
    for (let i = 0; i < mine.length; i++) if (Math.abs(mine[i].d - x) < Math.abs(mine[bi].d - x)) bi = i;
    const t = mine.length ? mine[bi].t : 0;
    let pi = 0;
    for (let i = 0; i < sel.pts.length; i++) if (Math.abs(sel.pts[i].t - t) < Math.abs(sel.pts[pi].t - t)) pi = i;
    return sel.pts[pi];
  };
  let speedC;
  let deltaC;
  let mapC;
  const onCursor = (src) => (x) => {
    if (src !== speedC && speedC) speedC.setCursor(x);
    if (src !== deltaC && deltaC) deltaC.setCursor(x);
    if (mapC) {
      if (x == null) mapC.setMarker(null);
      else {
        const p = locate(x);
        mapC.setMarker(p.lat, p.lon);
      }
    }
  };
  const xFmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`);
  if (ref && refInfo.lap !== sel) {
    deltaC = lineChart({
      title: 'Gain or loss along the lap',
      sub: `Time difference to ${refInfo.label}, by distance. Above the line: losing time.`,
      series: [{ name: `${Word} ${sel.n}`, color: 'var(--series-1)', points: mine.map((c) => ({ x: c.d, y: c.delta })) }],
      zero: true,
      washes: true,
      xFmt,
      yFmt: (v) => fmtDelta(v, 1),
      tipFmt: (v) => `${fmtDelta(v)} s`,
      onCursor: (x) => onCursor(deltaC)(x),
      table: { columns: ['Distance', 'Gain/loss (s)'], rows: thin(mine, 40).map((c) => [xFmt(c.d), fmtDelta(c.delta)]) },
    });
  }
  speedC = lineChart({
    title: 'Speed along the lap',
    sub: 'km/h against distance from the line',
    series: [
      { name: `${Word} ${sel.n}`, color: 'var(--series-1)', points: selPts },
      ...(ref && refInfo.lap !== sel ? [{ name: refInfo.label, color: 'var(--series-2)', points: refPts }] : []),
    ],
    xFmt,
    yFmt: (v) => `${Math.round(v)}`,
    tipFmt: (v) => `${Math.round(v)} km/h`,
    onCursor: (x) => onCursor(speedC)(x),
    table: { columns: ['Distance', `${Word} ${sel.n} km/h`, ...(ref && refInfo.lap !== sel ? ['Reference km/h'] : [])], rows: thin(mine, 40).map((c) => [xFmt(c.d), kmh(c.v), ...(ref && refInfo.lap !== sel ? [refSpeedAt(refTrace, c.d)] : [])]) },
  });
  const colorBy = vs.mapColor === 'delta' && ref && refInfo.lap !== sel ? 'delta' : 'speed';
  const mapToggle = h(
    'div',
    { class: 'seg', style: { margin: '0 4px 8px' } },
    h('button', { 'aria-pressed': String(colorBy === 'speed'), onclick: () => ((vs.mapColor = 'speed'), app.route()) }, 'Colour by speed'),
    h('button', { 'aria-pressed': String(colorBy === 'delta'), disabled: !(ref && refInfo.lap !== sel), onclick: () => ((vs.mapColor = 'delta'), app.route()) }, 'Time gained / lost'),
  );
  const lines = [{ line: def.start, kind: 'start', label: def.kind === 'stage' ? 'Start' : 'S/F' }, ...(def.kind === 'stage' ? [{ line: def.finish, kind: 'finish', label: 'Finish' }] : []), ...(def.splits || []).map((l, i) => ({ line: l, kind: 'split', label: String(i + 1) }))];
  const deltasPerPoint = colorBy === 'delta' ? perPointDelta(sel, ref) : null;
  mapC = trackMap({ title: `Map of ${word} ${sel.n}`, sub: colorBy === 'speed' ? 'Labels: slowest corners and top speed (km/h)' : 'Green where this lap gained time, red where it lost time', path: sel.pts, colorBy, deltas: deltasPerPoint, lines, turns: def.turns, annotate: true, outline: def.outline, outlineOpen: def.kind === 'stage' });
  mapC.el.insertBefore(mapToggle, mapC.el.children[1]);
  const gSel = gpsG(sel.pts);
  const gRef = refTrace ? gpsG(refTrace) : [];
  const gg = ggChart({
    title: 'G-G diagram',
    sub: 'From GPS: braking and acceleration against cornering. Rings every 0.5 g.',
    series: [{ name: `${Word} ${sel.n}`, color: 'var(--series-1)', pts: gSel }, ...(ref && refInfo.lap !== sel ? [{ name: refInfo.label, color: 'var(--series-2)', pts: gRef }] : [])],
    table: ggTable(gSel),
  });
  root.append(...[deltaC && deltaC.el, speedC.el, mapC.el, gg.el].filter(Boolean));
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function note(text) {
  return h('div', { class: 'note' }, icon('info'), h('span', null, text));
}

function thin(arr, n) {
  const step = Math.max(1, Math.ceil(arr.length / n));
  return arr.filter((_, i) => i % step === 0);
}

function ggTable(pts) {
  return { columns: ['Distance', 'Lateral g', 'Longitudinal g', 'km/h'], rows: thin(pts, 60).map((p) => [p.d != null ? `${Math.round(p.d)} m` : '-', p.lat.toFixed(2), p.lon.toFixed(2), kmh(p.v)]) };
}

function sectorsOf(ref) {
  const b = [0, ...(ref.splits || []), ref.time];
  const out = [];
  for (let i = 0; i < b.length - 1; i++) out.push(b[i] != null && b[i + 1] != null ? b[i + 1] - b[i] : null);
  return out;
}

/** Reference trace points {d, v, t, lat, lon} for charts. */
function refTraceFromRef(ref) {
  if (ref.lap) return ref.lap.pts.map((p) => ({ d: p.d, v: p.v, t: p.t, lat: p.lat, lon: p.lon }));
  return ref.pts.map((p, i) => ({ d: ref.ds[i], v: p[3], t: p[2], lat: p[0], lon: p[1] }));
}

function refSpeedAt(trace, d) {
  if (!trace || !trace.length) return '-';
  let bi = 0;
  for (let i = 0; i < trace.length; i++) if (Math.abs(trace[i].d - d) < Math.abs(trace[bi].d - d)) bi = i;
  return kmh(trace[bi].v);
}

function perPointDelta(lap, ref) {
  if (!ref) return null;
  const cmp = compareToRef(lap, ref);
  const byT = new Map(cmp.map((c) => [c.t, c.delta]));
  return lap.pts.map((p) => (byT.has(p.t) ? byT.get(p.t) : null));
}

/** The reference chosen in this view: a lap of this session or a stored lap from another. */
function resolveRef(vs, laps, best, eng) {
  if (vs.ref && vs.ref.stored) {
    const r = refFromStored(vs.ref.stored, eng.proj);
    r.pts = vs.ref.stored.pts;
    return { ref: r, lap: null, label: vs.ref.label, external: true };
  }
  const lap = (vs.ref && laps.find((l) => l.n === vs.ref.n)) || best;
  return { ref: refFromLap(lap), lap, label: lap === best ? `best lap (${lap.n})` : `lap ${lap.n}`, external: false };
}

async function chooseReference(app, sess, def, laps, vs) {
  const status = h('p', { class: 'small muted' }, 'Looking for this circuit or stage in your other recordings...');
  const own = h(
    'div',
    { class: 'list' },
    laps.map((l) =>
      h(
        'button',
        {
          class: 'item',
          onclick: () => {
            vs.ref = { n: l.n };
            sh.close();
            app.route();
          },
        },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, `${def.kind === 'stage' ? 'Run' : 'Lap'} ${l.n} of this session`)),
        h('div', { class: 'right' }, fmtLap(l.time)),
      ),
    ),
  );
  const others = h('div', { class: 'list' });
  const fileIn = h('input', {
    type: 'file',
    accept: '.csv,text/csv,text/plain',
    class: 'hidden',
    onchange: async () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      status.textContent = 'Importing ' + f.name + '...';
      try {
        const s2 = await importSessionFile(f, (m) => (status.textContent = m));
        await addThumb(s2);
        const fx2 = await db.getFixes(s2.id);
        const e2 = timeFixes(fx2, def);
        const b2 = lapStats(e2.laps).best;
        if (!b2) {
          status.textContent = `That file has no ${def.kind === 'stage' ? 'runs' : 'laps'} of ${def.name}. It was saved in Sessions.`;
          return;
        }
        vs.ref = { stored: lapToStored(b2), label: `best of ${fmtDateTime(s2.startUtcMs, s2.tzOffsetMin, false)} (${fmtLap(b2.time)})` };
        sh.close();
        app.route();
      } catch (e) {
        status.textContent = 'Could not import: ' + (e.message || e);
      }
    },
  });
  const body = h('div', null, h('h2', { class: 'section' }, 'This session'), own, h('h2', { class: 'section' }, 'Other sessions'), status, others, h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('import'), 'Compare with a session file...'), fileIn));
  const sh = sheet('Compare with', body);
  const sessions = (await db.listSessions()).filter((s) => s.id !== sess.id);
  const found = await findRuns(def, sessions, db.getFixes);
  const bestPer = new Map();
  for (const f of found) {
    if (!f.lap.valid) continue;
    const cur = bestPer.get(f.sessionId);
    if (!cur || f.lap.time < cur.lap.time) bestPer.set(f.sessionId, f);
  }
  status.textContent = bestPer.size ? '' : 'No other recordings of this circuit or stage yet.';
  for (const f of [...bestPer.values()].sort((a, b) => a.lap.time - b.lap.time)) {
    others.append(
      h(
        'button',
        {
          class: 'item',
          onclick: () => {
            vs.ref = { stored: lapToStored(f.lap), label: `best of ${fmtDateTime(f.session.startUtcMs, f.session.tzOffsetMin, false)} (${fmtLap(f.lap.time)})` };
            sh.close();
            app.route();
          },
        },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, fmtDateTime(f.session.startUtcMs, f.session.tzOffsetMin)), h('div', { class: 'meta' }, `best ${def.kind === 'stage' ? 'run' : 'lap'} ${f.lap.n}`)),
        h('div', { class: 'right' }, fmtLap(f.lap.time)),
      ),
    );
  }
}

export { summarise };
