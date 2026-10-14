// The in-car screen. Circuit: running lap time, live gain/loss against the reference lap, last
// and best lap, lap count. Road stage and free drive: only "recording", GPS quality and distance
// while moving; a road-stage result appears once the run is finished and the car has stopped.
// The same controller drives the accelerated replay (demo), fed from a recording instead of GPS.

import { h, put, icon, fmtRunning, fmtLap, fmtDelta, fmtDist, toast } from './ui.js';
import { TimingEngine } from './engine.js';
import { distanceM } from './geo.js';

const FLASH_MS = 6000;
const SPLIT_MS = 5000;

export function gpsBadge(q) {
  const cls = q.level === 'good' ? 'good' : q.level === 'fair' ? 'fair' : q.level === 'off' ? '' : 'bad';
  const word = q.level === 'good' ? 'GPS good' : q.level === 'fair' ? 'GPS fair' : q.level === 'off' ? 'GPS off' : q.level === 'wait' ? 'GPS searching' : 'GPS poor';
  const parts = [];
  if (q.rate != null) parts.push(`${q.rate.toFixed(1)} Hz`);
  if (q.hAcc > 0) parts.push(`±${Math.round(q.hAcc)} m`);
  if (q.age != null && q.age > 1.6) parts.push(`${q.age.toFixed(0)} s old`);
  return h('span', { class: `gpsq ${cls}`, title: q.label || '' }, h('span', { class: 'bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'q-word' }, word), parts.length ? h('span', { class: 'muted' }, parts.join(' · ')) : null);
}

export class LiveController {
  /**
   * @param {object} o { app, def, recorder (null in replay), replay: { fixes, speed } | null,
   *                     reference (stored best for "best ever"), onStop(controller) }
   */
  constructor(o) {
    Object.assign(this, o);
    this.engine = new TimingEngine(this.def, { reference: this.reference || null });
    this.flash = null;
    this.splitMsg = null;
    this.pendingResult = null;
    this.lastFix = null;
    this.distance = 0;
    this.stillCount = 0;
    this.lastLapEvent = null;
    this.stopped = false;
  }

  get kind() {
    return this.def ? this.def.kind : 'free';
  }

  now() {
    if (this.replay) return this.rp ? this.rp.t : 0;
    return this.recorder.now();
  }

  open() {
    document.body.classList.add('live-on');
    this.root = h('div', { id: 'live', role: 'main', 'aria-label': 'Live timing' });
    document.body.append(this.root);
    if (this.replay) this._startReplay();
    this._build();
    if (!this.replay) {
      this.off = this.app.gps.on((fix) => fix && this.onFix(fix));
      // GPS stops while the app is hidden or the phone locked: a lap spanning that is not trusted
      this._onVis = () => {
        if (document.visibilityState === 'hidden') this.engine.interrupt();
      };
      document.addEventListener('visibilitychange', this._onVis);
    }
    this._tick();
    this.app.awake.onChange = () => this._renderTop();
  }

  setDefinition(def) {
    this.def = def;
    this.engine = new TimingEngine(def, { reference: null });
    if (this.recorder) this.recorder.setDefinition(def);
    this._build();
  }

  onFix(fix) {
    let t;
    if (this.replay) t = fix.t;
    else {
      t = this.recorder.addFix(fix);
      if (t == null) return;
    }
    const f = { t, lat: fix.lat, lon: fix.lon, speed: fix.speed, hAcc: fix.hAcc, utc: fix.utc };
    if (this.lastFix) {
      const d = distanceM(this.lastFix.lat, this.lastFix.lon, f.lat, f.lon);
      const dt = f.t - this.lastFix.t;
      const v = this.lastFix.speed >= 0 && f.speed >= 0 ? (this.lastFix.speed + f.speed) / 2 : d / Math.max(dt, 1e-3);
      if (v >= 1) this.distance += d;
    }
    this.stillCount = f.speed >= 0 && f.speed < 1 ? this.stillCount + 1 : 0;
    this.lastFix = f;
    if (this.marker) this._markerFix(fix);
    for (const e of this.engine.push(f)) this._event(e);
  }

  _event(e) {
    if (e.type === 'lap') {
      if (this.recorder) this.recorder.lap(e.lap.n, e.lap.time, e.t);
      this.lastLapEvent = e;
      if (this.kind === 'circuit') {
        this.flash = { until: performance.now() + this._scaled(FLASH_MS), e };
      } else {
        this.pendingResult = e; // shown once the car has stopped
      }
    } else if (e.type === 'split' && this.kind === 'circuit' && e.delta != null) {
      this.splitMsg = { until: performance.now() + this._scaled(SPLIT_MS), k: e.k, delta: e.delta };
    }
  }

  /** Message durations follow the replay speed (in the car: speed 1, unchanged). */
  _scaled(ms) {
    return this.replay ? Math.max(ms / this.replay.speed, 1500) : ms;
  }

  // ------------------------------------------------------------------ rendering

  _build() {
    const r = this.root;
    r.replaceChildren();
    this.top = h('div', { class: 'live-top' });
    const main = h('div', { class: 'live-main ' + this.kind });
    if (this.kind === 'circuit') {
      this.el = {
        lapno: h('div', { class: 'lapno' }),
        running: h('div', { class: 'running', 'aria-live': 'off' }),
        split: h('div', { class: 'splitflash' }),
        delta: h('div', { class: 'delta none' }),
        bar: h('div', { class: 'dbar', 'aria-hidden': 'true' }, h('i')),
        lastVal: h('div', { class: 'val' }),
        lastSub: h('div', { class: 'sub' }),
        bestLbl: h('div', { class: 'lbl' }, 'BEST'),
        bestVal: h('div', { class: 'val' }),
        flash: h('div', { class: 'flash hidden' }),
      };
      const E = this.el;
      main.append(
        E.lapno,
        E.running,
        h('div', { class: 'deltawrap' }, E.split, E.delta, E.bar),
        h('div', { class: 'lastbest' }, h('div', null, h('div', { class: 'lbl' }, 'LAST'), E.lastVal, E.lastSub), h('div', null, E.bestLbl, E.bestVal)),
        E.flash,
      );
    } else {
      this.el = {
        dist: h('div', { class: 'r-dist' }),
        result: h('div', { class: 'result hidden' }),
        gps: h('div'),
      };
      main.classList.add('road');
      main.append(
        h('div', { class: 'big-rec' }, this.replay ? 'REPLAY' : 'RECORDING'),
        h('div', { class: 'r-name' }, this.def ? this.def.name : 'Free drive'),
        this.el.dist,
        this.el.gps,
        h('div', { class: 'r-line' }, this.kind === 'stage' ? 'Road stage: times appear after you stop.' : 'Free drive: recording only. Analysis after you stop.'),
        this.el.result,
      );
    }
    this.markBtn = h('button', { class: 'btn mark-live hidden', onclick: () => this.app.openMarkSheet(this) }, icon('pin'), 'Mark a line here');
    this.markStatus = h('div', { class: 'plain-line mark-status hidden' });
    this.saveWarn = h('div', { class: 'save-warn hidden', role: 'alert' }, icon('warn'), 'Storage problem: the last seconds are not saved yet. Stop soon to save them.');
    this.stopLabel = h('span', null, this.replay ? 'HOLD TO END REPLAY' : 'HOLD TO STOP');
    const stop = h('button', { class: 'hold-stop', 'aria-label': 'Hold to stop recording' }, h('div', { class: 'fill' }), this.stopLabel);
    this._holdToStop(stop);
    // the top bar is built once and only its contents change, so a tap on "Keep screen on" is never lost
    this.topEls = {
      left: this.replay ? h('span', { class: 'demo' }, `REPLAY ×${this.replay.speed}`) : h('span', { class: 'rec' }),
      name: h('span', { class: 'name' }, this.def ? this.def.name : 'Free drive'),
      gps: h('span'),
      awakeIcon: h('span', { class: 'awake', title: 'Screen stays on' }, icon('sun')),
      awakeBtn: h('button', { class: 'btn small hidden', onclick: () => this.app.awake.enable('video') }, icon('warn'), 'Keep screen on'),
    };
    this.top.append(this.topEls.left, this.topEls.name, this.topEls.gps, this.topEls.awakeIcon, this.topEls.awakeBtn);
    r.append(this.top, main, h('div', { class: 'live-bottom' }, this.saveWarn, this.markStatus, this.markBtn, stop));
    this._renderTop();
  }

  _holdToStop(btn) {
    let timer = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      btn.classList.remove('holding');
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.classList.add('holding');
      timer = setTimeout(() => {
        cancel();
        this.stop();
      }, 1200);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, cancel);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') this.stop();
    });
  }

  _renderTop() {
    const E = this.topEls;
    if (!E) return;
    if (!this.replay) {
      const t = this.now();
      E.left.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    }
    put(E.gps, this.replay ? h('span', { class: 'gpsq good' }, 'replaying') : gpsBadge(this.app.gps.quality()));
    const awake = this.app.awake.mode;
    const ok = !!this.replay || awake === 'wakelock' || awake === 'video';
    E.awakeIcon.classList.toggle('hidden', !ok);
    E.awakeBtn.classList.toggle('hidden', ok);
    if (this.recorder) {
      const rec = this.recorder;
      this.saveWarn.classList.toggle('hidden', !(rec.writeError || rec.pending.length > 2));
    }
  }

  /** Redraw about ten times a second (enough for tenths, and cooler than 60 frames a second). */
  _tick() {
    if (this.stopped) return;
    try {
      if (this.replay) this._replayStep();
      const now = performance.now();
      if (!this._lastTop || now - this._lastTop > 500) {
        this._lastTop = now;
        this._renderTop();
        this._renderMarkUi();
      }
      if (this.kind === 'circuit') this._renderCircuit(now);
      else this._renderRoad();
    } catch (e) {
      console.error(e); // a display error must never stop the screen updating
    }
    this.timer = setTimeout(() => this._tick(), 100);
  }

  _renderCircuit(now) {
    const E = this.el;
    const st = this.engine.status(this.now());
    // lap number and running time
    if (st.running) {
      E.lapno.textContent = `LAP ${st.n}`;
      E.running.textContent = fmtRunning(st.elapsed);
      E.running.style.color = '';
    } else {
      E.lapno.textContent = st.lapsDone ? `LAP ${st.n}` : this.engine.armed ? 'OUT LAP' : 'DRIVE AWAY FROM THE LINE';
      E.running.textContent = '-:--.-';
      E.running.style.color = '#555';
    }
    // live delta
    const d = st.delta != null && st.deltaAge != null && st.deltaAge < 3 ? st.delta : null;
    if (d == null) {
      E.delta.dataset.key = '';
      E.delta.className = 'delta none';
      E.delta.textContent = st.refTime == null ? 'No reference lap yet' : st.running ? '-' : '';
      E.bar.firstChild.className = '';
      E.bar.firstChild.style.width = '0';
    } else {
      const level = Math.abs(d) < 0.005;
      const faster = d < 0;
      const cls = level ? 'level' : faster ? 'faster' : 'slower';
      const key = `${cls}|${fmtDelta(d)}`;
      if (E.delta.dataset.key !== key) {
        E.delta.dataset.key = key;
        E.delta.className = 'delta ' + cls;
        E.delta.replaceChildren(
          h('span', { class: 'arrow' }, level ? '=' : faster ? '▼' : '▲'),
          h('span', null, fmtDelta(d)),
          h('span', { class: 'word' }, level ? 'LEVEL' : faster ? 'FASTER' : 'SLOWER'),
        );
      }
      E.bar.firstChild.className = level ? '' : cls;
      E.bar.firstChild.style.width = level ? '0' : `${Math.min(Math.abs(d) / 2, 1) * 50}%`;
    }
    // sector split flash
    if (this.splitMsg && now < this.splitMsg.until) {
      const m = this.splitMsg;
      E.split.className = 'splitflash ' + (m.delta < 0 ? 'faster' : 'slower');
      E.split.textContent = `S${m.k + 1} ${fmtDelta(m.delta)} ${m.delta < 0 ? '▼' : '▲'}`;
    } else E.split.textContent = '';
    // last and best
    const last = st.last;
    E.lastVal.textContent = last ? fmtLap(last.time) : '-:--.--';
    const le = this.lastLapEvent;
    if (le && le.prevRefTime != null) {
      const dd = le.lap.time - le.prevRefTime;
      E.lastSub.className = 'sub ' + (dd < 0 ? 'faster' : 'slower');
      E.lastSub.textContent = `${fmtDelta(dd)} ${dd < 0 ? '▼' : '▲'}`;
    } else {
      E.lastSub.className = 'sub';
      E.lastSub.textContent = '';
    }
    E.bestLbl.textContent = st.refExternal ? 'BEST EVER' : 'BEST';
    E.bestVal.textContent = st.refTime != null ? fmtLap(st.refTime) : '-:--.--';
    // lap-complete flash
    if (this.flash && now < this.flash.until) {
      const e = this.flash.e;
      if (E.flash.dataset.n !== String(e.lap.n)) {
        E.flash.dataset.n = String(e.lap.n);
        const dd = e.prevRefTime != null ? e.lap.time - e.prevRefTime : null;
        put(E.flash, 
          h('div', { class: 'f-lap' }, `LAP ${e.lap.n}`),
          h('div', { class: 'f-time' }, fmtLap(e.lap.time)),
          dd != null ? h('div', { class: 'f-delta ' + (dd < 0 ? 'faster' : 'slower') }, `${dd < 0 ? '▼' : '▲'} ${fmtDelta(dd)}`) : null,
          e.isBest && e.prevBestTime != null ? h('div', { class: 'f-best' }, icon('star'), 'NEW BEST') : null,
          !e.lap.valid ? h('div', { class: 'muted' }, 'GPS gap during this lap') : null,
        );
      }
      E.flash.classList.remove('hidden');
    } else E.flash.classList.add('hidden');
  }

  _renderRoad() {
    const E = this.el;
    E.dist.textContent = fmtDist(this.distance);
    if (!this.replay) {
      const now = performance.now();
      if (!this._lastGps || now - this._lastGps > 500) {
        this._lastGps = now;
        E.gps.replaceChildren(gpsBadge(this.app.gps.quality()));
      }
    }
    const stopped = this.stillCount >= 2;
    if (this.pendingResult && stopped) {
      const e = this.pendingResult;
      const dd = e.prevRefTime != null ? e.lap.time - e.prevRefTime : null;
      if (E.result.dataset.n !== String(e.lap.n) + '|' + e.t) {
        E.result.dataset.n = String(e.lap.n) + '|' + e.t;
        put(E.result, 
          h('div', { class: 'muted' }, `Run ${e.lap.n} finished`),
          h('div', { class: 'r-time' }, fmtLap(e.lap.time, 1)),
          dd != null ? h('div', { class: dd < 0 ? 'f-delta faster' : 'f-delta slower', style: { fontSize: '24px', fontWeight: 800, color: dd < 0 ? 'var(--good)' : '#ff5a5a' } }, `${dd < 0 ? '▼' : '▲'} ${fmtDelta(dd, 1)} against best`) : h('div', { class: 'muted' }, 'First run of this stage'),
        );
      }
      E.result.classList.remove('hidden');
    } else if (!stopped && this.lastFix && this.lastFix.speed > 3) {
      E.result.classList.add('hidden'); // moving again: hide results
    }
  }

  // ------------------------------------------------------------------ marking lines while recording

  _renderMarkUi() {
    if (this.replay) return;
    const still = this.app.gps.stationary(3);
    if (this.marker) {
      this.markStatus.textContent = this.marker.message;
      this.markStatus.classList.remove('hidden');
      this.markBtn.classList.add('hidden');
      return;
    }
    this.markStatus.classList.add('hidden');
    this.markBtn.classList.toggle('hidden', !still);
  }

  startMarker(marker, onDone) {
    this.marker = marker;
    this.markerDone = onDone;
    this._renderMarkUi();
  }

  _markerFix(fix) {
    const m = this.marker;
    m.push(fix);
    this.markStatus.textContent = m.message;
    if (m.state === 'done') {
      const cb = this.markerDone;
      this.marker = null;
      this.markerDone = null;
      cb(m.line());
    }
  }

  // ------------------------------------------------------------------ replay

  _startReplay() {
    const fx = this.replay.fixes;
    this.rp = { i: 0, t: fx.length ? fx[0].t : 0, wall: performance.now(), t0: fx.length ? fx[0].t : 0 };
  }

  _replayStep() {
    const rp = this.rp;
    const fx = this.replay.fixes;
    rp.t = rp.t0 + ((performance.now() - rp.wall) / 1000) * this.replay.speed;
    while (rp.i < fx.length && fx[rp.i].t <= rp.t) this.onFix(fx[rp.i++]);
    if (rp.i >= fx.length && !this._replayDone) {
      this._replayDone = true;
      toast('Replay finished. Hold the button to close.');
    }
  }

  // ------------------------------------------------------------------ stop

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.off) this.off();
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    this.app.awake.onChange = null;
    if (this.stopLabel && this.recorder) this.stopLabel.textContent = 'SAVING...';
    let sess = null;
    let err = null;
    try {
      if (this.recorder) {
        const hz = this.app.motion.rate();
        sess = await this.recorder.end({ motion: { aHz: hz, gHz: hz }, motionPermission: this.app.motion.permission });
      }
    } catch (e) {
      err = e; // the session stays marked as recording and is recovered on the next start
    } finally {
      if (this.recorder) {
        this.app.motion.stop();
        this.app.awake.disable();
      }
      this.root.remove();
      document.body.classList.remove('live-on');
    }
    if (err) toast('Saved up to the last second; finishing the file failed (' + (err.message || err) + '). It is recovered next time the app opens.', 7000);
    if (this.onStop) this.onStop(this, sess);
  }
}
