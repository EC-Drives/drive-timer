// More tab: replay demo, storage, privacy and sensor notes, install help.

import { h, icon, sheet, toast, fmtDateTime, fmtDuration } from './ui.js';
import * as db from './db.js';
import { getDef } from './defs.js';
import { LiveController } from './live.js';
import { stadiumCourse, simulate } from './synth.js';
import { APP_VERSION } from './csv.js';
import { IS_IOS } from './sensors.js';

export async function renderMore(app, root) {
  const est = await db.storageEstimate();
  let persisted = null;
  try {
    persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  } catch (e) {
    persisted = null;
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  root.replaceChildren(
    h('div', { class: 'screen-head' }, h('h1', null, 'More')),
    h('h2', { class: 'section' }, 'Try the live screen'),
    h('div', { class: 'card' }, h('p', { style: { marginTop: 0 } }, 'Replay a recording through the live timer at speed, exactly as it would look in the car. Nothing is recorded.'), h('button', { class: 'btn primary', onclick: () => chooseReplay(app) }, icon('play'), 'Replay demo')),
    h('h2', { class: 'section' }, 'Install on iPhone'),
    h(
      'div',
      { class: 'card' },
      standalone ? h('p', { style: { marginTop: 0 } }, 'Installed: running from the Home Screen.') : null,
      h('ol', { class: 'steps' }, h('li', null, 'Open this page in Safari.'), h('li', null, 'Tap the Share button, then "Add to Home Screen".'), h('li', null, 'Open Drive Timer from the Home Screen once while online. After that it works with no signal.'), h('li', null, 'On first START, allow Location ("While Using the App") and Motion & Orientation.')),
    ),
    h('h2', { class: 'section' }, 'Storage on this phone'),
    h(
      'div',
      { class: 'card small' },
      est ? h('div', null, `Using ${(est.usage / 1e6).toFixed(1)} MB${est.quota ? ` of about ${(est.quota / 1e9).toFixed(1)} GB available to the app` : ''}.`) : h('div', null, 'Storage size unknown in this browser.'),
      h('div', null, persisted ? 'Protected: the phone will not clear this data to save space.' : 'Not yet protected from automatic clean-up; the app asks for protection when you first record. Export important sessions.'),
      h('div', { class: 'muted' }, 'Recordings are written every second, so a crash or reload keeps everything up to that moment.'),
    ),
    h('h2', { class: 'section' }, 'Privacy'),
    h('div', { class: 'card small' }, h('p', { style: { marginTop: 0 } }, 'No accounts, no analytics, no map tiles. After the app has loaded it makes no network requests at all; the page forbids them. Recordings, stages and best laps stay on this phone until you export a file.')),
    h('h2', { class: 'section' }, 'Sensors'),
    h(
      'div',
      { class: 'card small' },
      h('p', { style: { marginTop: 0 } }, 'GPS: about one fix a second on iPhone. Timing uses the time each fix was taken, not when it arrived.'),
      h('p', null, `Motion: ${IS_IOS ? 'iPhone Safari is known to report acceleration with the opposite sign to Android. ' : ''}At the start of each recording the app checks the sign against the phone's orientation and writes what it found into the file header. Raw values are kept, so exports can be corrected later.`),
      h('p', { class: 'muted', style: { marginBottom: 0 } }, 'G-forces in the analysis come from GPS, so they do not depend on how the phone is mounted.'),
    ),
    h('h2', { class: 'section' }, 'About'),
    h('div', { class: 'card small' }, h('div', null, `Drive Timer ${APP_VERSION}. Session files use the TrackLogger 1.2 row format, so they can be exchanged with the Android logger.`), h('a', { href: 'test/index.html' }, 'Run the test suite')),
  );
}

async function chooseReplay(app) {
  const sessions = (await db.listSessions()).filter((s) => s.status !== 'recording').slice(0, 30);
  const speeds = [5, 10, 30];
  let speed = 10;
  const segEl = h('div', { class: 'seg' });
  for (const v of speeds) {
    const b = h(
      'button',
      {
        'aria-pressed': String(v === speed),
        onclick: () => {
          speed = v;
          for (const x of segEl.children) x.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
        },
      },
      `×${v}`,
    );
    segEl.append(b);
  }
  const start = async (sess) => {
    sh.close();
    let fixes;
    let def;
    if (!sess) {
      const course = stadiumCourse();
      fixes = simulate(course, { laps: 6, rate: 1, seed: 3, noise: 1.5, speedNoise: 0.2 }).fixes;
      def = { id: 'synthetic', kind: 'circuit', name: 'Synthetic test course', start: course.lineAt(200, 25), splits: [course.lineAt(course.straight + course.arc / 2, 25), course.lineAt(course.straight + course.arc + 300, 25)], minLapSec: 20 };
    } else {
      fixes = await db.getFixes(sess.id);
      def = await getDef(sess.defId);
    }
    if (!fixes.length) return toast('No GPS data to replay.');
    const live = new LiveController({ app, def, recorder: null, replay: { fixes, speed }, onStop: () => ((app.live = null), app.route()) });
    app.live = live;
    live.open();
  };
  const body = h(
    'div',
    null,
    h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Speed'),
    segEl,
    h('h2', { class: 'section' }, 'Replay which recording?'),
    h(
      'div',
      { class: 'list' },
      h('button', { class: 'item', onclick: () => start(null) }, h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Synthetic test course'), h('div', { class: 'meta' }, '6 laps of a 1.8 km course with GPS noise'))),
      sessions.map((s) => h('button', { class: 'item', onclick: () => start(s) }, h('div', { class: 'grow' }, h('div', { class: 'title' }, s.defName || 'Free drive'), h('div', { class: 'meta' }, `${fmtDateTime(s.startUtcMs, s.tzOffsetMin)} · ${fmtDuration(s.summary ? s.summary.durationS : null)}`)))),
    ),
  );
  const sh = sheet('Replay demo', body);
}
