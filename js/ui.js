// Small DOM and formatting helpers shared by every screen. Text always goes in as text nodes
// (never as HTML), so names typed by the driver or read from files cannot inject markup.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'icon') el.insertAdjacentHTML('afterbegin', ICONS[v] || ''); // static, trusted
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children, skipping null/false (replaceChildren would print "null"). */
export function put(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = 'ic') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || '';
  return span;
}

// ---------- formatting ----------

const MINUS = '−';

/** Lap time as m:ss.hh (or s.hh under a minute). */
export function fmtLap(sec, digits = 2) {
  if (sec == null || !Number.isFinite(sec)) return digits ? '-:--.' + '-'.repeat(digits) : '-:--';
  const neg = sec < 0;
  const p = 10 ** digits;
  const tot = Math.round(Math.abs(sec) * p) / p;
  const m = Math.floor(tot / 60);
  const r = tot - m * 60;
  const ss = digits ? r.toFixed(digits).padStart(digits + 3, '0') : String(Math.floor(r)).padStart(2, '0');
  return (neg ? MINUS : '') + (m ? `${m}:${ss}` : ss.replace(/^0(?=\d)/, ''));
}

/** Running time for the live screen: m:ss.t, always with minutes. */
export function fmtRunning(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '0:00.0';
  const t = Math.floor(sec * 10) / 10;
  const m = Math.floor(t / 60);
  const r = t - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

export function fmtDelta(d, digits = 2) {
  if (d == null || !Number.isFinite(d)) return '-';
  const v = Math.abs(d).toFixed(digits);
  if (Number(v) === 0) return '±' + v;
  return (d > 0 ? '+' : MINUS) + v;
}

export const kmh = (v) => (v == null || !(v >= 0) ? '-' : String(Math.round(v * 3.6)));

export function fmtDist(m) {
  if (m == null || !Number.isFinite(m)) return '-';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 100000 ? 2 : 0)} km`;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '-';
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m ${String(ss).padStart(2, '0')}s`;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date and time in the local time of the recording (its stored UTC offset). */
export function fmtDateTime(utcMs, tzOffsetMin, withDay = true) {
  if (!Number.isFinite(utcMs)) return '';
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : -new Date(utcMs).getTimezoneOffset();
  const d = new Date(utcMs + off * 60000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${withDay ? WD[d.getUTCDay()] + ' ' : ''}${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hm}`;
}

export function fmtDate(utcMs, tzOffsetMin) {
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : -new Date(utcMs).getTimezoneOffset();
  const d = new Date(utcMs + off * 60000);
  return `${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ---------- sheets, toasts, confirmations ----------

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Bottom sheet. Returns { el, close }. */
export function sheet(title, body, { onClose } = {}) {
  const back = h('div', { class: 'sheet-back' });
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const panel = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close, icon: 'close' })),
    h('div', { class: 'sheet-body' }, body),
  );
  back.append(panel);
  back.addEventListener('click', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return { el: panel, close };
}

export function confirmSheet({ title, message, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sh.close();
      resolve(v);
    };
    const body = h(
      'div',
      null,
      h('p', { class: 'muted' }, message),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'), h('button', { class: danger ? 'btn danger' : 'btn primary', onclick: () => finish(true) }, confirm)),
    );
    const sh = sheet(title, body, { onClose: () => finish(false) });
  });
}

export function promptSheet({ title, label, value = '', confirm = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value, placeholder, 'aria-label': label, maxlength: '60' });
    const finish = (v) => {
      if (done) return;
      done = true;
      sh.close();
      resolve(v);
    };
    const body = h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          finish(input.value.trim() || null);
        },
      },
      h('label', { class: 'field' }, h('span', null, label), input),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, confirm)),
    );
    const sh = sheet(title, body, { onClose: () => finish(null) });
    setTimeout(() => input.focus(), 50);
  });
}

// ---------- icons (24x24, stroke = currentColor) ----------

const S = (d, fill = 'none') => `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  drive: S('<circle cx="12" cy="13" r="8"/><path d="M12 13l4-3"/><path d="M9 2h6"/><path d="M12 2v3"/>'),
  list: S('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  track: S('<path d="M5 17c-2-3-1-8 3-9 3-1 4 2 7 1s3-4 5-3 1 6-1 8-6 1-8 3-4 3-6 0z"/>'),
  more: S('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  share: S('<path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  import: S('<path d="M12 15V3"/><path d="M7 10l5 5 5-5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
  trash: S('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
  edit: S('<path d="M4 20h4l11-11-4-4L4 16v4z"/>'),
  pin: S('<path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>'),
  flag: S('<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>'),
  gps: S('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>'),
  road: S('<path d="M8 3L4 21"/><path d="M16 3l4 18"/><path d="M12 4v3M12 11v3M12 18v2"/>'),
  circuit: S('<rect x="3" y="6" width="18" height="12" rx="6"/><path d="M12 6v3"/>'),
  free: S('<path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-6 6-6"/>'),
  star: S('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', 'currentColor'),
  up: S('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>'),
  down: S('<path d="M12 5v14"/><path d="M5 12l7 7 7-7"/>'),
  play: S('<path d="M7 4l13 8-13 8z"/>', 'currentColor'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="1.5"/>', 'currentColor'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: S('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  chevron: S('<path d="M9 6l6 6-6 6"/>'),
  back: S('<path d="M15 6l-6 6 6 6"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  flip: S('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  warn: S('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'),
  check: S('<path d="M5 12l5 5L20 7"/>'),
  gg: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v18M3 12h18"/>'),
};
