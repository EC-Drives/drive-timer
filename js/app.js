// Drive Timer: start-up, shared state and the screen router (hash routes work on any static host,
// including a GitHub Pages project address such as /drive-timer/).

import { h, icon, toast } from './ui.js';
import * as db from './db.js';
import { GpsSource, MotionSource, KeepAwake } from './sensors.js';
import { recoverInterrupted } from './store.js';
import { renderDrive, openMarkSheet } from './drive.js';
import { renderSessions, renderSession } from './sessions.js';
import { renderLibrary, renderDef, renderDefEditor } from './library.js';
import { renderMore } from './more.js';

const DEFAULTS = { refMode: 'session', wakeMode: 'auto', lastDefId: 'builtin-sepang-gp' };

const app = {
  gps: new GpsSource(),
  motion: new MotionSource(),
  awake: new KeepAwake('assets/keepawake.mp4'),
  settings: { ...DEFAULTS },
  trail: [],
  cleanups: [],
  live: null,
  view: {},
  renderSeq: 0,
  lastHash: null,
};

app.saveSetting = async (key, value) => {
  app.settings[key] = value;
  await db.setMeta('settings', app.settings);
};
app.openMarkSheet = (live, statusEl) => openMarkSheet(app, live, statusEl);

app.route = async () => {
  for (const c of app.cleanups.splice(0)) {
    try {
      c();
    } catch (e) {
      /* ignore */
    }
  }
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = hash.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
  const sameView = hash === app.lastHash;
  const scrollY = window.scrollY;
  app.lastHash = hash;
  const tab = { '': 'drive', drive: 'drive', sessions: 'sessions', session: 'sessions', tracks: 'tracks', def: 'tracks', 'def-new': 'tracks', 'def-edit': 'tracks', more: 'more' }[name] || 'drive';
  for (const a of document.querySelectorAll('#tabs a')) a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
  const seq = ++app.renderSeq;
  const view = h('div', { class: 'view' });
  let cleanup = null;
  try {
    switch (name) {
      case '':
      case 'drive':
        cleanup = await renderDrive(app, view);
        break;
      case 'sessions':
        await renderSessions(app, view);
        break;
      case 'session':
        await renderSession(app, view, arg);
        break;
      case 'tracks':
        await renderLibrary(app, view);
        break;
      case 'def':
        await renderDef(app, view, arg);
        break;
      case 'def-new':
        await renderDefEditor(app, view, arg, true);
        break;
      case 'def-edit':
        await renderDefEditor(app, view, arg, false);
        break;
      case 'more':
        await renderMore(app, view);
        break;
      default:
        location.replace('#/drive');
        return;
    }
  } catch (e) {
    console.error(e);
    view.replaceChildren(h('div', { class: 'banner' }, icon('warn'), h('div', null, h('strong', null, 'Something went wrong on this screen.'), h('div', { class: 'small' }, String(e && e.message ? e.message : e)))));
  }
  if (seq !== app.renderSeq) {
    if (typeof cleanup === 'function') cleanup();
    return; // a newer navigation has already started
  }
  if (typeof cleanup === 'function') app.cleanups.push(cleanup);
  document.getElementById('app').replaceChildren(view);
  window.scrollTo(0, sameView ? scrollY : 0);
};

async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  }
  try {
    app.settings = { ...DEFAULTS, ...((await db.getMeta('settings')) || {}) };
  } catch (e) {
    toast('On-phone storage is unavailable: ' + (e.message || e), 6000);
  }
  // recent fixes, used to give a marked finish line the direction the car arrived from
  app.gps.on((fix) => {
    if (!fix) return;
    app.trail.push(fix);
    if (app.trail.length > 240) app.trail.shift();
  });
  // warm GPS up straight away if location was allowed before
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    if (p.state === 'granted') app.gps.start();
  } catch (e) {
    /* Permissions API missing: GPS starts on the first tap */
  }
  try {
    const rec = await recoverInterrupted(null);
    if (rec.length) toast(`Saved ${rec.length} recording${rec.length > 1 ? 's' : ''} that had been interrupted.`, 5000);
  } catch (e) {
    /* nothing to recover */
  }
  window.addEventListener('hashchange', () => app.route());
  window.addEventListener('beforeunload', (e) => {
    if (app.live && app.live.recorder) {
      app.live.recorder.flush();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && app.live && app.live.recorder) app.live.recorder.flush();
  });
  if (!location.hash) location.replace('#/drive');
  await app.route();
}

window.__driveTimer = app; // handy for debugging in a desktop browser
boot();
