// Drive tab: choose what to time, check GPS, mark lines on the spot, and start recording.

import { h, put, icon, toast, sheet, fmtLap, fmtDateTime } from './ui.js';
import { allDefs, getDef, LineMarker, newDefId, validateDef } from './defs.js';
import * as db from './db.js';
import { Recorder } from './recorder.js';
import { LiveController, gpsBadge } from './live.js';
import { summarise, getBest } from './store.js';
import { outlineIcon } from './charts.js';

const KIND_WORD = { circuit: 'Circuit', stage: 'Road stage', free: 'Free drive' };
export const PLAIN_LINE = {
  circuit: 'Circuit: live lap times and gain or loss against your best lap.',
  stage: 'Road stage: times appear after you stop.',
  free: 'Free drive: recording only. Analysis after you stop.',
};

function stamp() {
  return fmtDateTime(Date.now(), -new Date().getTimezoneOffset(), false);
}

export async function renderDrive(app, root) {
  const def = await getDef(app.settings.lastDefId);
  app.currentDef = def;
  const kind = def ? def.kind : 'free';
  const best = def ? await getBest(def.id) : null;
  const draft = await db.getMeta('draftStage');

  const gpsBox = h('div', { class: 'gps-line' });
  const gpsBtn = h('button', { class: 'btn small', onclick: () => app.gps.start() }, icon('gps'), 'Turn on GPS');
  const markStatus = h('div', { class: 'plain-line mark-status hidden' });
  const markBtn = h('button', { class: 'btn', onclick: () => app.openMarkSheet(null, markStatus) }, icon('pin'), 'Mark a line here');

  const refSeg =
    kind === 'circuit'
      ? h(
          'div',
          { class: 'card' },
          h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Live gain or loss compared with'),
          seg(
            [
              ['session', 'Best lap this session'],
              ['best', best ? `Best ever ${fmtLap(best.time)}` : 'Best ever (none yet)'],
            ],
            app.settings.refMode,
            (v) => app.saveSetting('refMode', v),
          ),
        )
      : null;

  const view = h(
    'div',
    null,
    h('div', { class: 'screen-head' }, h('h1', null, 'Drive')),
    h(
      'button',
      { class: 'pick-def', onclick: () => pickDefinition(app), 'aria-label': 'Choose circuit, stage or free drive' },
      outlineIcon(def && def.outline ? def.outline : null, 56),
      h('div', { class: 'grow' }, h('div', { class: 'small muted' }, 'Timing with'), h('div', { class: 'name' }, def ? def.name : 'Free drive'), h('span', { class: 'chip' }, icon(kind === 'stage' ? 'road' : kind === 'circuit' ? 'circuit' : 'free'), KIND_WORD[kind])),
      icon('chevron'),
    ),
    h('p', { class: 'plain-line' }, PLAIN_LINE[kind]),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, gpsBox), gpsBtn)),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, 'Set a line on the spot'), h('div', { class: 'small muted' }, 'Stop the car where the line should be, for example in a car park.')), markBtn),
      draft ? h('div', { class: 'small', style: { marginTop: '8px' } }, `Stage started: "${draft.name}". Mark its finish when you get there.`) : null,
      markStatus,
    ),
    refSeg,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Keep the screen on with'),
      seg(
        [
          ['auto', 'Screen lock control'],
          ['video', 'Silent video'],
        ],
        app.settings.wakeMode,
        (v) => app.saveSetting('wakeMode', v),
      ),
    ),
    h('button', { class: 'start-btn', onclick: () => onStart(app) }, icon('play'), 'START'),
    h('div', { class: 'note' }, icon('info'), h('span', null, 'Phone GPS updates about once a second, so lap times are good to roughly 0.1 to 0.3 seconds. Keep the app open and the phone mounted with a view of the sky.')),
  );
  root.replaceChildren(view);

  const refresh = () => {
    const q = app.gps.quality();
    put(gpsBox, gpsBadge(q), q.speed >= 0 ? h('span', { class: 'muted small' }, ` ${Math.round(q.speed * 3.6)} km/h`) : null);
    gpsBtn.classList.toggle('hidden', app.gps.started);
    markBtn.disabled = !app.gps.started;
  };
  refresh();
  const timer = setInterval(refresh, 500);
  return () => clearInterval(timer);
}

function seg(options, value, onPick) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  for (const [v, label] of options) {
    const b = h(
      'button',
      {
        'aria-pressed': String(v === value),
        onclick: () => {
          for (const x of wrap.children) x.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
          onPick(v);
        },
      },
      label,
    );
    wrap.append(b);
  }
  return wrap;
}

async function pickDefinition(app) {
  const defs = await allDefs();
  const choose = async (id) => {
    await app.saveSetting('lastDefId', id);
    sh.close();
    app.route();
  };
  const item = (d) =>
    h(
      'button',
      { class: 'item', onclick: () => choose(d ? d.id : null) },
      outlineIcon(d && d.outline ? d.outline : null, 44),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, d ? d.name : 'Free drive'), h('div', { class: 'meta' }, d ? KIND_WORD[d.kind] + (d.builtIn ? ' · built in' : '') : 'No lines: record and analyse afterwards')),
    );
  const body = h(
    'div',
    { class: 'list' },
    item(null),
    defs.filter((d) => d.kind === 'circuit').map(item),
    defs.filter((d) => d.kind === 'stage').map(item),
    h('a', { class: 'btn', href: '#/tracks', onclick: () => sh.close() }, icon('plus'), 'New circuit or stage'),
  );
  const sh = sheet('Time with', body);
}

// ------------------------------------------------------------------ start and stop

function onStart(app) {
  if (app.live || app.starting) return; // a second tap while starting must not open a second recording
  app.starting = true;
  // These calls must happen inside the tap on iPhone, before anything asynchronous.
  const permission = app.motion.requestPermission();
  app.awake.enable(app.settings.wakeMode);
  app.gps.start();
  startRecording(app, permission)
    .catch((e) => {
      toast('Could not start: ' + (e && e.message ? e.message : e));
    })
    .finally(() => {
      app.starting = false;
    });
}

async function startRecording(app, permission) {
  const def = app.currentDef || null;
  const rec = new Recorder();
  await rec.begin({ def });
  db.requestPersistence();
  let reference = null;
  if (def && (def.kind === 'stage' || app.settings.refMode === 'best')) reference = await getBest(def.id);
  const live = new LiveController({
    app,
    def,
    recorder: rec,
    reference,
    onStop: async (ctl, sess) => {
      app.live = null;
      if (sess) {
        try {
          await summarise(sess);
        } catch (e) {
          /* the recording itself is saved */
        }
        location.hash = '#/session/' + encodeURIComponent(sess.id);
      }
      app.route();
    },
  });
  app.live = live;
  live.open();
  const st = await permission;
  if (st === 'granted') {
    app.motion.count = 0;
    app.motion.firstPerf = null;
    app.motion.onSample = (m) => rec.addMotion(m);
    app.motion.onOrientation = (e) => rec.addOrientation(e);
    app.motion.start();
    setTimeout(() => app.motion.stopOrientation(), 8000); // only needed for the 3-second calibration
  } else if (st === 'denied') {
    toast('Motion sensors not allowed: recording GPS only.');
  }
}

// ------------------------------------------------------------------ marking lines

/** Sheet with the kinds of line that can be marked here. live = LiveController or null. */
export async function openMarkSheet(app, live, statusEl) {
  const draft = await db.getMeta('draftStage');
  const cur = live ? live.def : app.currentDef;
  const own = cur && !cur.builtIn ? cur : null;
  const choose = (purpose) => {
    sh.close();
    startMarking(app, live, statusEl, purpose, draft, own);
  };
  const opt = (purpose, title, sub) => h('button', { class: 'item', onclick: () => choose(purpose) }, h('div', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'meta' }, sub)));
  const body = h(
    'div',
    { class: 'list' },
    opt('circuit', 'Start/finish of a new circuit', 'For a car park test or a new track. Laps start on your first pass after driving away.'),
    opt('stage-start', 'Start of a new road stage', 'The direction is set as you drive off.'),
    draft ? opt('stage-finish', `Finish of "${draft.name}"`, 'Mark it after stopping just past the finish. The direction is the way you arrived.') : null,
    own ? opt('split', `Split line for "${own.name}"`, 'Mark splits in driving order.') : null,
    h('p', { class: 'small muted' }, 'The car must be stopped. The app averages five GPS fixes.'),
  );
  const sh = sheet('Mark a line here', body);
}

function startMarking(app, live, statusEl, purpose, draft, own) {
  const direction = purpose === 'stage-finish' || purpose === 'split' ? 'arrival' : 'departure';
  const marker = new LineMarker({ direction, halfWidth: 15, trail: app.trail });
  const finish = (line) => onMarked(app, live, purpose, line, draft, own).catch((e) => toast(e.message || String(e)));
  if (live) {
    live.startMarker(marker, finish);
    return;
  }
  // idle: feed fixes from the GPS until the line is set
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = marker.message;
  }
  const off = app.gps.on((fix) => {
    if (!fix) return;
    marker.push(fix);
    if (statusEl) statusEl.textContent = marker.message;
    if (marker.state === 'done') {
      off();
      finish(marker.line());
    }
  });
  app.cleanups.push(off);
}

async function onMarked(app, live, purpose, line, draft, own) {
  if (purpose === 'circuit') {
    const def = { id: newDefId('circuit'), kind: 'circuit', name: `Circuit marked ${stamp()}`, start: line, splits: [], minLapSec: 10, created: Date.now() };
    await db.putDef(def);
    await app.saveSetting('lastDefId', def.id);
    app.currentDef = def;
    if (live) live.setDefinition(def);
    toast('Line set. Drive away and come back across it to start lap 1.', 5000);
  } else if (purpose === 'stage-start') {
    await db.setMeta('draftStage', { name: `Stage marked ${stamp()}`, start: line, splits: [], created: Date.now() });
    toast('Stage start set. Drive the stage, stop past the finish and mark it.', 5000);
  } else if (purpose === 'stage-finish' && draft) {
    const def = { id: newDefId('stage'), kind: 'stage', name: draft.name, start: draft.start, finish: line, splits: draft.splits || [], minRunSec: 10, created: Date.now() };
    const errs = validateDef(def);
    if (errs.length) throw new Error(errs[0]);
    await db.putDef(def);
    await db.setMeta('draftStage', null);
    await app.saveSetting('lastDefId', def.id);
    app.currentDef = def;
    if (live) live.setDefinition(def);
    toast('Stage saved. Runs already recorded are timed in Tracks.', 5000);
  } else if (purpose === 'split' && own) {
    const def = { ...own, splits: [...(own.splits || []), line] };
    await db.putDef(def);
    await db.setMeta('best:' + def.id, null);
    if (live) live.setDefinition(def);
    app.currentDef = def;
    toast(`Split ${def.splits.length} added.`);
  }
  if (!live) app.route();
}
