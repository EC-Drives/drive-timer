// Phone sensors: GPS (geolocation), motion (accelerometer and gyroscope) and keeping the screen on.

export const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const STANDALONE = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

/** iOS version as a number (18.4 -> 18.04), from the OS or Safari version token; null if unknown. */
export function iosVersion(ua = navigator.userAgent) {
  let best = null;
  for (const re of [/OS (\d+)_(\d+)/, /Version\/(\d+)\.(\d+)/]) {
    const m = re.exec(ua);
    if (m) {
      const v = Number(m[1]) + Number(m[2]) / 100;
      if (best == null || v > best) best = v;
    }
  }
  return best;
}

/** Home Screen web apps before iOS 18.4 accept a wake lock but still let the screen sleep (WebKit bug 254545). */
export function wakeLockUnreliable() {
  return IS_IOS && STANDALONE && (iosVersion() ?? 0) < 18.04;
}

// ---------------------------------------------------------------- GPS

/**
 * Wraps navigator.geolocation.watchPosition (high accuracy, no cached fixes). Each fix carries
 * `perf`: the moment the fix was taken on the page's monotonic clock (received time minus the
 * delivery lag computed from Position.timestamp), so lap timing uses the GPS fix time.
 */
export class GpsSource {
  constructor() {
    this.watchId = null;
    this.listeners = new Set();
    this.last = null;
    this.recent = [];
    this.error = null;
    this.started = false;
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  start() {
    if (this.started) return;
    if (!('geolocation' in navigator)) {
      this.error = 'This browser cannot use GPS.';
      return;
    }
    this.started = true;
    this.error = null;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this._onPosition(p),
      (e) => this._onError(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }
  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.started = false;
  }
  _onError(e) {
    // TIMEOUT keeps the watch running; PERMISSION_DENIED and others are reported
    this.error = e.code === 1 ? 'Location permission is off for this app.' : e.code === 3 ? 'Waiting for GPS...' : 'GPS unavailable: ' + (e.message || e.code);
    if (e.code === 1) this.stop();
    for (const fn of this.listeners) fn(null, this.error);
  }
  _onPosition(p) {
    const recv = performance.now();
    const now = Date.now();
    const c = p.coords;
    let utc = p.timestamp;
    let lag = now - utc;
    if (!(utc > 1e12) || Math.abs(lag) > 3600e3) {
      utc = now; // implausible timestamp: fall back to the receive time
      lag = -1;
    } else if (lag < 0) lag = 0; // tiny clock disagreement
    const fix = {
      perf: lag >= 0 && lag <= 30000 ? recv - lag : recv,
      recv,
      utc: Math.round(utc),
      lag: lag >= 0 ? Math.round(lag) : -1,
      lat: c.latitude,
      lon: c.longitude,
      alt: c.altitude != null && Number.isFinite(c.altitude) ? c.altitude : -9999,
      hAcc: Number.isFinite(c.accuracy) ? c.accuracy : -1,
      speed: c.speed != null && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : -1,
      heading: c.heading != null && Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : -1,
    };
    const l = this.last;
    if (l && l.utc === fix.utc && l.lat === fix.lat && l.lon === fix.lon) return; // duplicate delivery
    if (l && fix.perf <= l.perf) return; // older than what we already have
    this.error = null;
    this.last = fix;
    this.recent.push(fix);
    if (this.recent.length > 12) this.recent.shift();
    for (const fn of this.listeners) fn(fix, null);
  }
  /** Quality summary for the indicator: fix age, accuracy and update rate. */
  quality(nowPerf = performance.now()) {
    if (!this.started) return { level: 'off', label: 'GPS off' };
    const l = this.last;
    if (!l) return { level: this.error && !/Waiting/.test(this.error) ? 'bad' : 'wait', label: this.error || 'Searching...' };
    const age = (nowPerf - l.recv) / 1000;
    const r = this.recent;
    let rate = null;
    if (r.length >= 3) {
      const span = (r[r.length - 1].perf - r[0].perf) / 1000;
      if (span > 0) rate = (r.length - 1) / span;
    }
    let level = 'good';
    if (age > 3 || l.hAcc > 20) level = 'bad';
    else if (age > 1.6 || l.hAcc > 8 || (rate != null && rate < 0.8)) level = 'fair';
    return { level, age, hAcc: l.hAcc, rate, speed: l.speed };
  }
  /** True if the car has been still for the last few fixes. */
  stationary(n = 3) {
    const r = this.recent.slice(-n);
    if (r.length < n) return false;
    return r.every((f) => f.speed >= 0 && f.speed < 0.8);
  }
}

// ---------------------------------------------------------------- motion

/**
 * DeviceMotionEvent listener. Values are passed on exactly as the browser delivers them
 * (accelerationIncludingGravity in m/s2, rotationRate in deg/s); the conversion to the file
 * format happens at export, once the sign convention has been checked.
 */
export class MotionSource {
  constructor() {
    this.onSample = null;
    this.onOrientation = null;
    this.permission = 'unknown';
    this.count = 0;
    this.firstPerf = null;
    this.lastPerf = null;
    this._m = (e) => this._motion(e);
    this._o = (e) => this.onOrientation && this.onOrientation(e);
  }
  /** Must be called directly inside a tap handler on iPhone. Returns a promise of the state. */
  requestPermission() {
    const DM = window.DeviceMotionEvent;
    if (!DM) {
      this.permission = 'unsupported';
      return Promise.resolve('unsupported');
    }
    if (typeof DM.requestPermission !== 'function') {
      this.permission = 'granted';
      return Promise.resolve('granted');
    }
    return DM.requestPermission()
      .then((r) => (this.permission = r))
      .catch(() => (this.permission = 'denied'));
  }
  start() {
    window.addEventListener('devicemotion', this._m);
    window.addEventListener('deviceorientation', this._o);
  }
  stop() {
    window.removeEventListener('devicemotion', this._m);
    window.removeEventListener('deviceorientation', this._o);
  }
  /** Orientation is only needed for the calibration check at the start of a recording. */
  stopOrientation() {
    window.removeEventListener('deviceorientation', this._o);
  }
  _motion(e) {
    const now = performance.now();
    // event timestamps share performance.now()'s clock in current browsers; guard against old ones
    const ts = e.timeStamp;
    const perf = ts > 0 && Math.abs(ts - now) < 2000 ? ts : now;
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    const sample = {
      perf,
      ax: a && a.x != null ? a.x : null,
      ay: a && a.y != null ? a.y : null,
      az: a && a.z != null ? a.z : null,
      alpha: r && r.alpha != null ? r.alpha : null,
      beta: r && r.beta != null ? r.beta : null,
      gamma: r && r.gamma != null ? r.gamma : null,
    };
    if (sample.ax == null && sample.alpha == null) return;
    this.count++;
    if (this.firstPerf == null) this.firstPerf = perf;
    this.lastPerf = perf;
    if (this.onSample) this.onSample(sample);
  }
  rate() {
    if (this.count < 10 || this.lastPerf == null) return null;
    return (this.count - 1) / ((this.lastPerf - this.firstPerf) / 1000);
  }
}

// ---------------------------------------------------------------- screen awake

/**
 * Keeps the screen on while recording. Uses the Screen Wake Lock API; if that is missing or
 * refused, plays a tiny silent video (Safari keeps the screen on while a video with a sound
 * track plays; the track is silence). The video is started from the same tap that starts
 * recording, because Safari only allows that from a tap.
 */
export class KeepAwake {
  constructor(videoSrc) {
    this.src = videoSrc;
    this.mode = 'off'; // off | wakelock | video | none
    this.lock = null;
    this.video = null;
    this.want = false;
    this.prefer = 'auto';
    this.onChange = null;
    document.addEventListener('visibilitychange', () => {
      if (this.want && document.visibilityState === 'visible') this._resume();
    });
  }
  _set(mode) {
    this.mode = mode;
    if (this.onChange) this.onChange(mode);
  }
  /** Call inside a tap handler. */
  enable(prefer = 'auto') {
    this.want = true;
    this.prefer = prefer;
    if (prefer !== 'video' && !wakeLockUnreliable() && navigator.wakeLock && navigator.wakeLock.request) {
      // if the lock is refused, try the video; outside the tap Safari may refuse that too, and
      // the screen then shows a "tap to keep the screen on" banner that retries with a tap
      return navigator.wakeLock
        .request('screen')
        .then((lock) => this._gotLock(lock))
        .catch(() => this._playVideo());
    }
    return this._playVideo();
  }
  _gotLock(lock) {
    this.lock = lock;
    lock.addEventListener('release', () => {
      if (this.lock === lock) this.lock = null;
      if (this.want && document.visibilityState === 'visible') this._resume();
      else if (!this.want) this._set('off');
    });
    this._set('wakelock');
    return 'wakelock';
  }
  _prepareVideo() {
    if (this.video) return this.video;
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.preload = 'auto';
    v.muted = false; // Safari only keeps the screen on for unmuted video with a sound track
    v.loop = false; // ... that is not set to loop, so it is looped by hand below
    v.src = this.src;
    v.className = 'keepawake';
    v.addEventListener('timeupdate', () => {
      if (v.duration && v.currentTime > v.duration - 0.6) v.currentTime = 0.05;
    });
    v.addEventListener('ended', () => {
      v.currentTime = 0;
      v.play().catch(() => {});
    });
    // a phone call, Siri or another app's audio can pause it: try again, else say so on screen
    v.addEventListener('pause', () => {
      if (!this.want || this.mode !== 'video') return;
      v.play().catch(() => this._set('none'));
    });
    document.body.append(v);
    this.video = v;
    return v;
  }
  _playVideo() {
    const v = this._prepareVideo();
    let p;
    try {
      p = v.play();
    } catch (e) {
      this._set('none');
      return Promise.resolve('none');
    }
    return Promise.resolve(p).then(
      () => {
        this._set('video');
        return 'video';
      },
      () => {
        this._set('none');
        return 'none';
      },
    );
  }
  _resume() {
    if (this.mode === 'video' || !navigator.wakeLock) {
      if (this.video) this.video.play().catch(() => this._set('none'));
      return;
    }
    navigator.wakeLock
      .request('screen')
      .then((lock) => this._gotLock(lock))
      .catch(() => this._set('none'));
  }
  disable() {
    this.want = false;
    if (this.lock) this.lock.release().catch(() => {});
    this.lock = null;
    if (this.video) this.video.pause();
    this._set('off');
  }
}
