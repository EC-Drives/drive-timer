// Tracks tab: the library of circuits and road stages, a page per definition with every lap or
// run found in past recordings, the editor (mark here, pick on a recording, enter coordinates),
// and "define a stage on this recording".

import { h, put, icon, toast, sheet, confirmSheet, promptSheet, fmtLap, fmtDelta, fmtDateTime } from './ui.js';
import * as db from './db.js';
import { allDefs, getDef, newDefId, makeLine, flipLine, validateDef, lineFromTrace, parseLatLon, LineMarker, libraryJson, parseLibraryJson } from './defs.js';
import { findRuns } from './analysis.js';
import { getBest, offerBest, shareOrDownload } from './store.js';
import { trackMap, outlineIcon } from './charts.js';
import { LocalProjection } from './geo.js';

const KIND = { circuit: 'Circuit', stage: 'Road stage' };

// ------------------------------------------------------------------ list

export async function renderLibrary(app, root) {
  const defs = await allDefs();
  const bests = await Promise.all(defs.map((d) => getBest(d.id)));
  const draft = await db.getMeta('draftStage');
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: () => importLibrary(app, fileIn) });
  const item = (d, i) =>
    h(
      'a',
      { class: 'item', href: '#/def/' + encodeURIComponent(d.id) },
      outlineIcon(d.outline || null, 46),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, d.name), h('div', { class: 'meta' }, KIND[d.kind] + (d.builtIn ? ' · built in' : '') + (d.splits && d.splits.length ? ` · ${d.splits.length} split${d.splits.length > 1 ? 's' : ''}` : ''))),
      bests[i] ? h('div', { class: 'right' }, h('div', { class: 'big' }, fmtLap(bests[i].time)), h('div', { class: 'meta' }, 'best ever')) : null,
    );
  const circuits = defs.map((d, i) => [d, i]).filter(([d]) => d.kind === 'circuit');
  const stages = defs.map((d, i) => [d, i]).filter(([d]) => d.kind === 'stage');
  put(root, 
    h('div', { class: 'screen-head' }, h('h1', null, 'Tracks & stages')),
    h('div', { class: 'btn-row' }, h('a', { class: 'btn primary', href: '#/def-new/circuit' }, icon('plus'), 'New circuit'), h('a', { class: 'btn primary', href: '#/def-new/stage' }, icon('plus'), 'New road stage')),
    draft ? h('div', { class: 'banner info' }, icon('flag'), h('div', null, h('strong', null, `"${draft.name}" has a start line only.`), h('div', { class: 'small' }, 'Mark its finish on the Drive tab when you are there, or discard it.'), h('button', { class: 'btn small', onclick: async () => (await db.setMeta('draftStage', null), app.route()) }, 'Discard'))) : null,
    h('h2', { class: 'section' }, 'Circuits'),
    h('div', { class: 'list' }, circuits.map(([d, i]) => item(d, i))),
    h('h2', { class: 'section' }, 'Road stages'),
    stages.length ? h('div', { class: 'list' }, stages.map(([d, i]) => item(d, i))) : h('p', { class: 'muted small' }, 'None yet. Mark one on the spot from the Drive tab, pick one on a recording ("Define a stage here" in a session), or enter coordinates.'),
    h('h2', { class: 'section' }, 'Share your library'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: () => exportLibrary() }, icon('share'), 'Export my circuits and stages'), h('button', { class: 'btn small', onclick: () => fileIn.click() }, icon('import'), 'Import'), fileIn),
    h('p', { class: 'small muted' }, 'Stages can start near home. They stay on this phone unless you export them.'),
  );
}

async function exportLibrary() {
  const defs = (await allDefs()).filter((d) => !d.builtIn);
  if (!defs.length) return toast('Nothing to export yet: only the built-in circuit is here.');
  const file = new File([libraryJson(defs)], `drive-timer-library-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  const r = await shareOrDownload(file);
  if (r === 'downloaded') toast('Library file saved.');
}

async function importLibrary(app, input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  try {
    const defs = parseLibraryJson(await f.text());
    for (const d of defs) await db.putDef(d);
    toast(defs.length ? `Imported ${defs.length} circuit${defs.length > 1 ? 's' : ''} or stage${defs.length > 1 ? 's' : ''}.` : 'No new circuits or stages in that file.');
    app.route();
  } catch (e) {
    toast(e.message || String(e), 4000);
  }
}

// ------------------------------------------------------------------ one definition

function linesOf(def) {
  return [
    { line: def.start, kind: 'start', label: def.kind === 'stage' ? 'Start' : 'S/F' },
    ...(def.kind === 'stage' && def.finish ? [{ line: def.finish, kind: 'finish', label: 'Finish' }] : []),
    ...(def.splits || []).map((l, i) => ({ line: l, kind: 'split', label: String(i + 1) })),
  ];
}

export async function renderDef(app, root, id) {
  const def = await getDef(id);
  if (!def) {
    put(root, h('p', null, 'Not found.'), h('a', { class: 'btn', href: '#/tracks' }, 'Back'));
    return;
  }
  const best = await getBest(def.id);
  const word = def.kind === 'stage' ? 'run' : 'lap';
  const map = trackMap({ title: 'Lines', sub: 'Arrows show the direction of travel across each line', path: [], outline: def.outline, outlineOpen: def.kind === 'stage', lines: linesOf(def), turns: def.turns });
  const results = h('div', { class: 'list' }, h('p', { class: 'muted small' }, 'Searching your recordings...'));
  put(root, 
    h(
      'div',
      { class: 'screen-head' },
      h('a', { class: 'icon-btn', href: '#/tracks', 'aria-label': 'Back', icon: 'back' }),
      h('h1', null, def.name),
      def.builtIn ? null : h('a', { class: 'btn small', href: '#/def-edit/' + encodeURIComponent(def.id) }, icon('edit'), 'Edit'),
    ),
    h('div', { class: 'muted small' }, `${KIND[def.kind]}${def.variant ? ' · ' + def.variant : ''}${def.builtIn ? ' · built in' : ''}`),
    best
      ? h('div', { class: 'hero' }, h('div', { class: 'lbl' }, `Best ${word} ever`), h('div', { class: 'val' }, fmtLap(best.time)), h('div', { class: 'sub' }, fmtDateTime(best.startUtcMs, best.tzOffsetMin)))
      : null,
    map.el,
    def.notes ? h('div', { class: 'note' }, icon('info'), h('span', null, def.notes)) : null,
    h('h2', { class: 'section' }, `Every ${word} in your recordings`),
    results,
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: async () => shareOrDownload(new File([libraryJson([def])], `${def.name.replace(/[^\w-]+/g, '_').slice(0, 40)}.json`, { type: 'application/json' })) }, icon('share'), 'Export'),
      def.builtIn ? null : h('button', { class: 'btn small danger', onclick: () => removeDef(app, def) }, icon('trash'), 'Delete'),
    ),
  );
  // retroactive search across all recordings (runs after the page is shown)
  searchRecordings(app, def, word, results);
}

async function searchRecordings(app, def, word, results) {
  const sessions = await db.listSessions();
  const found = await findRuns(def, sessions, db.getFixes);
  found.sort((a, b) => a.lap.time - b.lap.time);
  const fastest = found.find((f) => f.lap.valid);
  if (fastest) await offerBest(def, fastest.lap, fastest.session); // keeps "best ever" in step with the search
  results.replaceChildren();
  if (!found.length) {
    results.append(h('p', { class: 'muted small' }, `No ${word}s yet. Recordings that cross ${def.kind === 'stage' ? 'the start and then the finish' : 'the line twice'} in the right direction appear here automatically.`));
    return;
  }
  results.append(h('p', { class: 'small muted' }, `${found.length} ${word}${found.length > 1 ? 's' : ''} in ${new Set(found.map((f) => f.sessionId)).size} recording${new Set(found.map((f) => f.sessionId)).size > 1 ? 's' : ''}, fastest first.`));
  for (const f of found.slice(0, 200)) {
    results.append(
      h(
        'a',
        {
          class: 'item',
          href: '#/session/' + encodeURIComponent(f.sessionId),
          onclick: () => {
            app.view = app.view || {};
            app.view[f.sessionId] = { defId: def.id, sel: f.lap.n };
          },
        },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, fmtDateTime(f.session.startUtcMs, f.session.tzOffsetMin)), h('div', { class: 'meta' }, `${word === 'run' ? 'Run' : 'Lap'} ${f.lap.n}${f.lap.valid ? '' : ' · GPS gap'}`)),
        h('div', { class: 'right' }, h('div', { class: 'big' }, fmtLap(f.lap.time)), h('div', { class: 'meta' }, f === fastest ? 'fastest' : fastest ? fmtDelta(f.lap.time - fastest.lap.time) : '')),
      ),
    );
  }
}

async function removeDef(app, def) {
  const ok = await confirmSheet({ title: `Delete "${def.name}"?`, message: 'Recordings are kept; only the lines are removed.', confirm: 'Delete', danger: true });
  if (!ok) return;
  await db.deleteDef(def.id);
  await db.setMeta('best:' + def.id, null);
  if (app.settings.lastDefId === def.id) await app.saveSetting('lastDefId', null);
  location.hash = '#/tracks';
}

// ------------------------------------------------------------------ editor

export async function renderDefEditor(app, root, arg, isNew) {
  let def;
  if (isNew) {
    const kind = arg === 'stage' ? 'stage' : 'circuit';
    def = app.editing && app.editing.isNew && app.editing.kind === kind ? app.editing : { id: newDefId(kind), kind, name: '', start: null, finish: null, splits: [], isNew: true, created: Date.now() };
    if (kind === 'circuit') def.minLapSec = def.minLapSec ?? 60;
    else def.minRunSec = def.minRunSec ?? 10;
  } else {
    const d = await getDef(arg);
    if (!d || d.builtIn) {
      put(root, h('p', null, 'This one cannot be edited.'));
      return;
    }
    def = app.editing && app.editing.id === d.id ? app.editing : JSON.parse(JSON.stringify(d));
  }
  app.editing = def;
  const rerender = () => renderDefEditor(app, root, arg, isNew);
  const name = h('input', { type: 'text', value: def.name || '', maxlength: '60', placeholder: def.kind === 'stage' ? 'For example Genting climb' : 'For example Car park test', oninput: () => (def.name = name.value) });
  const minT = h('input', {
    type: 'number',
    inputmode: 'numeric',
    min: '3',
    max: '3600',
    value: String(def.kind === 'stage' ? def.minRunSec : def.minLapSec),
    oninput: () => {
      const v = Number(minT.value);
      if (v > 0) def[def.kind === 'stage' ? 'minRunSec' : 'minLapSec'] = v;
    },
  });
  const lineRow = (label, key, idx) => {
    const l = idx == null ? def[key] : def.splits[idx];
    const set = (nl) => {
      if (idx == null) def[key] = nl;
      else def.splits[idx] = nl;
      rerender();
    };
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, label), idx != null ? h('button', { class: 'icon-btn', 'aria-label': 'Remove split', onclick: () => (def.splits.splice(idx, 1), rerender()), icon: 'trash' }) : null),
      h('div', { class: 'small muted' }, l ? `${l.lat.toFixed(6)}, ${l.lon.toFixed(6)} · direction ${Math.round(l.heading)}° · reaches ${l.halfWidth} m each side` : 'Not set'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => markInEditor(app, idx == null && key === 'finish' ? 'arrival' : idx != null ? 'arrival' : 'departure', set) }, icon('pin'), 'Mark here'),
        h('button', { class: 'btn small', onclick: () => pickFromRecordingList(app, set, def.kind) }, icon('track'), 'Pick on a recording'),
        h('button', { class: 'btn small', onclick: () => enterCoordinates(l, set, def.kind) }, icon('edit'), 'Coordinates'),
        l ? h('button', { class: 'btn small', onclick: () => set(flipLine(l)) }, icon('flip'), 'Flip') : null,
      ),
    );
  };
  const errs = validateDef({ ...def, name: def.name || 'x' });
  const preview = def.start ? trackMap({ title: 'Preview', path: [], outline: def.outline, outlineOpen: def.kind === 'stage', lines: linesOf({ ...def, start: def.start }) }).el : null;
  put(root, 
    h('div', { class: 'screen-head' }, h('a', { class: 'icon-btn', href: isNew ? '#/tracks' : '#/def/' + encodeURIComponent(def.id), 'aria-label': 'Cancel', onclick: () => (app.editing = null), icon: 'back' }), h('h1', null, isNew ? `New ${def.kind === 'stage' ? 'road stage' : 'circuit'}` : 'Edit')),
    h('label', { class: 'field' }, h('span', null, 'Name'), name),
    lineRow(def.kind === 'stage' ? 'Start line' : 'Start/finish line', 'start'),
    def.kind === 'stage' ? lineRow('Finish line', 'finish') : null,
    (def.splits || []).map((_, i) => lineRow(`Split ${i + 1}`, 'splits', i)),
    h('button', { class: 'btn small', onclick: () => (def.splits.push(null), rerender()), disabled: !def.start }, icon('plus'), 'Add split line'),
    h('label', { class: 'field' }, h('span', null, def.kind === 'stage' ? 'Shortest possible run (seconds)' : 'Shortest possible lap (seconds); stops double counting'), minT),
    preview,
    h('p', { class: 'small muted' }, '"Mark here" needs the car stopped at the spot with GPS on. Start lines take their direction from how you drive off; finish and split lines from how you arrived.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => saveDef(app, def, isNew) }, icon('check'), 'Save')),
    errs.length ? h('p', { class: 'small muted' }, 'Still needed: ' + errs.join(' ')) : null,
  );
}

async function saveDef(app, def, isNew) {
  def.name = (def.name || '').trim();
  def.splits = (def.splits || []).filter(Boolean);
  const errs = validateDef(def);
  if (errs.length) return toast(errs[0], 4000);
  const clean = { ...def };
  delete clean.isNew;
  await db.putDef(clean);
  await db.setMeta('best:' + clean.id, null); // lines may have moved: recompute bests
  app.editing = null;
  toast('Saved. Looking for it in your recordings...');
  location.hash = '#/def/' + encodeURIComponent(clean.id);
}

function enterCoordinates(l, set, kind) {
  const pos = h('input', { type: 'text', inputmode: 'decimal', value: l ? `${l.lat}, ${l.lon}` : '', placeholder: '2.760752, 101.738060' });
  const hd = h('input', { type: 'number', inputmode: 'decimal', min: '0', max: '359', value: l ? String(l.heading) : '' });
  const hw = h('input', { type: 'number', inputmode: 'decimal', min: '2', max: '200', value: String(l ? l.halfWidth : kind === 'stage' ? 15 : 25) });
  const msg = h('p', { class: 'small muted' }, 'Direction is the way you drive across the line, in degrees from north (90 = east).');
  const body = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const p = parseLatLon(pos.value);
        const heading = Number(hd.value);
        const half = Number(hw.value);
        if (!p) return (msg.textContent = 'Enter latitude and longitude, for example 2.760752, 101.738060.');
        if (!(heading >= 0 && heading < 360)) return (msg.textContent = 'Direction must be 0 to 359 degrees.');
        if (!(half >= 2 && half <= 200)) return (msg.textContent = 'Reach must be 2 to 200 metres.');
        sh.close();
        set(makeLine(p.lat, p.lon, heading, half));
      },
    },
    h('label', { class: 'field' }, h('span', null, 'Latitude, longitude'), pos),
    h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', null, 'Direction (°)'), hd), h('label', { class: 'field' }, h('span', null, 'Reach each side (m)'), hw)),
    msg,
    h('div', { class: 'btn-row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Use these')),
  );
  const sh = sheet('Enter coordinates', body);
}

function markInEditor(app, direction, set) {
  app.gps.start();
  const status = h('p', { class: 'mark-status' }, 'Starting GPS...');
  const marker = new LineMarker({ direction, halfWidth: 15, trail: app.trail });
  const off = app.gps.on((fix) => {
    if (!fix) return;
    marker.push(fix);
    status.textContent = marker.message;
    if (marker.state === 'done') {
      off();
      sh.close();
      set(marker.line());
    }
  });
  const sh = sheet('Mark the line here', h('div', null, status, h('p', { class: 'small muted' }, 'Keep the car stopped exactly where the line should be.')), { onClose: off });
}

async function pickFromRecordingList(app, set, kind) {
  const list = await db.listSessions();
  const body = h(
    'div',
    { class: 'list' },
    list.length
      ? list.map((s) =>
          h(
            'button',
            {
              class: 'item',
              onclick: async () => {
                sh.close();
                const fixes = await db.getFixes(s.id);
                pickOnRecording(app, s, fixes, { single: true, onLine: set, halfWidth: kind === 'stage' ? 15 : 25 });
              },
            },
            outlineIcon(s.thumb || null, 40),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, s.defName || 'Free drive'), h('div', { class: 'meta' }, fmtDateTime(s.startUtcMs, s.tzOffsetMin))),
          ),
        )
      : h('p', { class: 'muted' }, 'No recordings yet.'),
  );
  const sh = sheet('Pick on which recording?', body);
}

// ------------------------------------------------------------------ picking lines on a recording

/**
 * Tap the recording's map to place lines. Default: a new stage (start, finish, optional splits).
 * opts.single: place one line and hand it to opts.onLine.
 */
export function pickOnRecording(app, sess, fixes, opts = {}) {
  if (!fixes || fixes.length < 3) return toast('This recording has too little GPS data.');
  const proj = new LocalProjection(fixes[0].lat, fixes[0].lon);
  const xy = fixes.map((f) => proj.toXY(f.lat, f.lon));
  const half = opts.halfWidth || 15;
  const placed = []; // { line, idx }
  const help = h('p', { class: 'pick-help' });
  const mapBox = h('div');
  const actions = h('div', { class: 'btn-row pick-actions' });
  const trace = fixes.map((f) => ({ lat: f.lat, lon: f.lon, v: f.speed }));

  const nearestIdx = (lat, lon, from = 0, to = fixes.length - 1) => {
    const [x, y] = proj.toXY(lat, lon);
    let bi = -1;
    let bd = Infinity;
    for (let i = from; i <= to; i++) {
      const d = (xy[i][0] - x) ** 2 + (xy[i][1] - y) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return { i: bi, dist: Math.sqrt(bd) };
  };

  const label = (k) => (opts.single ? 'Line' : k === 0 ? 'Start' : k === 1 ? 'Finish' : `Split ${k - 1}`);
  const draw = () => {
    const lines = placed.map((p, k) => ({ line: p.line, kind: k === 0 ? 'start' : k === 1 ? 'finish' : 'split', label: label(k) }));
    const m = trackMap({ title: sessTitle(sess), sub: 'Tap the route to place a line', path: trace, lines, onPick, annotate: false, height: Math.min(Math.round(window.innerHeight * 0.48), 420) });
    mapBox.replaceChildren(m.el);
    const k = placed.length;
    help.textContent = opts.single ? 'Tap the route where the line should be.' : k === 0 ? 'Step 1: tap the route where the stage starts.' : k === 1 ? 'Step 2: tap where the stage finishes.' : 'Optional: tap split points in driving order, then save.';
    put(actions, 
      placed.length ? h('button', { class: 'btn small', onclick: () => (placed.pop(), draw()) }, 'Undo') : null,
      placed.length ? h('button', { class: 'btn small', onclick: () => ((placed[placed.length - 1].line = flipLine(placed[placed.length - 1].line)), draw()) }, icon('flip'), 'Flip last') : null,
      !opts.single && placed.length >= 2 ? h('button', { class: 'btn small primary', onclick: save }, icon('check'), 'Name and save') : null,
    );
  };
  const onPick = (lat, lon) => {
    const k = placed.length;
    let r = nearestIdx(lat, lon);
    // prefer the pass that comes after the start (finish) or between start and finish (splits)
    if (!opts.single && k >= 1) {
      const from = placed[0].idx + 1;
      const to = k >= 2 ? placed[1].idx - 1 : fixes.length - 1;
      if (to > from) {
        const r2 = nearestIdx(lat, lon, from, to);
        if (r2.i >= 0 && r2.dist < 60) r = r2;
      }
    }
    if (r.i < 0 || r.dist > 80) return toast('Tap on the route itself.');
    const line = lineFromTrace(fixes, r.i, half);
    if (opts.single) {
      sh.close();
      opts.onLine(line);
      return;
    }
    placed.push({ line, idx: r.i });
    draw();
  };
  const save = async () => {
    const nm = await promptSheet({ title: 'Name this stage', label: 'Name', placeholder: 'For example Genting climb' });
    if (!nm) return;
    const a = placed[0].idx;
    const b = placed[1].idx;
    const seg = fixes.slice(Math.min(a, b), Math.max(a, b) + 1);
    const step = Math.max(1, Math.floor(seg.length / 400));
    const def = {
      id: newDefId('stage'),
      kind: 'stage',
      name: nm,
      start: placed[0].line,
      finish: placed[1].line,
      splits: placed.slice(2).map((p) => p.line),
      minRunSec: 10,
      outline: seg.filter((_, i) => i % step === 0).map((f) => [Math.round(f.lat * 1e6) / 1e6, Math.round(f.lon * 1e6) / 1e6]),
      created: Date.now(),
    };
    const errs = validateDef(def);
    if (errs.length) return toast(errs[0], 4000);
    await db.putDef(def);
    sh.close();
    toast('Stage saved. Timing it in all your recordings...');
    location.hash = '#/def/' + encodeURIComponent(def.id);
  };
  const sh = sheet(opts.single ? 'Pick the line on the route' : 'Define a stage on this recording', h('div', null, help, mapBox, actions, h('p', { class: 'small muted' }, 'Lines point the way you drove. If a road was driven both ways, check the arrow and use "Flip last".')));
  draw();
}

function sessTitle(s) {
  return `${s.defName || 'Free drive'}, ${fmtDateTime(s.startUtcMs, s.tzOffsetMin, false)}`;
}
