// SVG charts for the analysis screens, following the dataviz method:
//  - this lap = series 1 (blue), reference lap = series 2 (orange); validated for dark mode
//  - speed on the map = one-hue sequential ramp (dark: slow = deep blue, fast = pale blue)
//  - time gained / lost = status colours, always with an arrow and a word
//  - 2px lines, hairline solid grid, legend for 2+ series, crosshair + tooltip, table view
// No map tiles: maps are the GPS path only.

import { h, s, put, fmtDelta } from './ui.js';
import { LocalProjection, DEG } from './geo.js';

// sequential ramp, steps 600 -> 100 (documented palette); dark mode: low = dark, high = light
const SEQ = ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];
const GOOD = '#0ca30c';
const CRIT = '#d03b3b';
const NEUTRAL = '#5f5e5a';

function hexRgb(hx) {
  const n = parseInt(hx.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, f) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export function seqColor(f) {
  f = Math.min(Math.max(f, 0), 1) * (SEQ.length - 1);
  const i = Math.min(Math.floor(f), SEQ.length - 2);
  return mix(SEQ[i], SEQ[i + 1], f - i);
}
function deltaColor(f) {
  // f in [-1, 1]: negative = gaining (good), positive = losing (critical)
  const k = Math.min(Math.abs(f), 1);
  return f < 0 ? mix(NEUTRAL, GOOD, 0.25 + 0.75 * k) : mix(NEUTRAL, CRIT, 0.25 + 0.75 * k);
}

export function niceTicks(min, max, count = 4) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const e = step0 / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const fmtNum = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-GB') : String(+v.toFixed(2)));

function figure(title, sub) {
  return h('figure', { class: 'chart' }, h('figcaption', null, h('span', { class: 'chart-title' }, title), sub ? h('span', { class: 'chart-sub' }, sub) : null));
}

function lineKey(color, dot = false) {
  const k = s('svg', { width: 18, height: 10, viewBox: '0 0 18 10', 'aria-hidden': 'true' });
  k.append(dot ? s('circle', { cx: 9, cy: 5, r: 4, fill: color }) : s('line', { x1: 1, y1: 5, x2: 17, y2: 5, stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
  return k;
}

function legend(items, dot = false) {
  return h('div', { class: 'legend' }, items.map((it) => h('span', { class: 'key' }, lineKey(it.color, dot), it.name)));
}

/** Table twin of a chart (the accessible equivalent). */
function tableView(columns, rows, label = 'Show as table') {
  const t = h('table', { class: 'data' }, h('thead', null, h('tr', null, columns.map((c) => h('th', null, c)))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))));
  return h('details', { class: 'table-view' }, h('summary', null, label), h('div', { class: 'table-scroll' }, t));
}

function whenSized(el, fn) {
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(el.clientWidth);
    if (w > 0 && Math.abs(w - lastW) > 2) {
      lastW = w;
      fn(w);
    }
  });
  ro.observe(el);
  return ro;
}

function nearestIndex(pts, x) {
  let lo = 0;
  let hi = pts.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].x < x) lo = m;
    else hi = m;
  }
  return Math.abs(pts[lo].x - x) <= Math.abs(pts[hi].x - x) ? lo : hi;
}

// ------------------------------------------------------------------------------ line chart

/**
 * opts: { title, sub, series:[{name, color, points:[{x,y}]}], xFmt, yFmt, xLabel, yUnit,
 *         height, zero, washes (true: green below zero, red above), onCursor(x), table:{columns, rows} }
 */
export function lineChart(opts) {
  const fig = figure(opts.title, opts.sub);
  const series = opts.series.filter((se) => se.points.length > 1).map((se) => ({ ...se, points: se.points.slice().sort((a, b) => a.x - b.x) }));
  if (series.length >= 2) fig.append(legend(series));
  const wrap = h('div', { class: 'plot' });
  const tip = h('div', { class: 'tip', role: 'status', 'aria-live': 'off' });
  fig.append(wrap);
  if (opts.table) fig.append(tableView(opts.table.columns, opts.table.rows));
  if (!series.length) {
    wrap.append(h('p', { class: 'muted empty' }, 'Not enough data for this chart.'));
    return { el: fig, setCursor() {} };
  }
  let xs = Infinity;
  let xe = -Infinity;
  let ys = Infinity;
  let ye = -Infinity;
  for (const se of series)
    for (const p of se.points) {
      if (p.x < xs) xs = p.x;
      if (p.x > xe) xe = p.x;
      if (p.y < ys) ys = p.y;
      if (p.y > ye) ye = p.y;
    }
  if (opts.zero) {
    ys = Math.min(ys, 0);
    ye = Math.max(ye, 0);
  }
  const padY = (ye - ys) * 0.08 || 1;
  ys -= opts.zero && ys === 0 ? 0 : padY;
  ye += padY;
  const H = opts.height || 190;
  const M = { l: 42, r: 12, t: 10, b: 26 };
  let W = 0;
  let sx;
  let sy;
  let svg;
  let cursorG;
  let cursorX = null;

  function render(width) {
    W = width;
    const pw = W - M.l - M.r;
    const ph = H - M.t - M.b;
    sx = (x) => M.l + ((x - xs) / (xe - xs || 1)) * pw;
    sy = (y) => M.t + (1 - (y - ys) / (ye - ys || 1)) * ph;
    svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'plot-svg', role: 'img', 'aria-label': opts.title });
    const grid = s('g', { class: 'grid' });
    for (const v of niceTicks(ys, ye, 4)) {
      grid.append(s('line', { x1: M.l, x2: W - M.r, y1: sy(v), y2: sy(v) }));
      grid.append(s('text', { x: M.l - 6, y: sy(v) + 4, 'text-anchor': 'end', class: 'tick' }, (opts.yFmt || fmtNum)(v)));
    }
    for (const v of niceTicks(xs, xe, Math.max(2, Math.floor(pw / 80)))) {
      grid.append(s('text', { x: sx(v), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, (opts.xFmt || fmtNum)(v)));
    }
    grid.append(s('line', { class: 'axis', x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b }));
    svg.append(grid);
    if (opts.zero) svg.append(s('line', { class: 'zero', x1: M.l, x2: W - M.r, y1: sy(0), y2: sy(0) }));
    const pathOf = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    if (opts.washes) {
      const id = 'c' + Math.random().toString(36).slice(2, 8);
      const defs = s('defs');
      defs.append(s('clipPath', { id: id + 'a' }, s('rect', { x: M.l, y: M.t, width: pw, height: Math.max(sy(0) - M.t, 0) })));
      defs.append(s('clipPath', { id: id + 'b' }, s('rect', { x: M.l, y: sy(0), width: pw, height: Math.max(H - M.b - sy(0), 0) })));
      svg.append(defs);
      const se = series[0];
      const area = pathOf(se.points) + `L${sx(se.points[se.points.length - 1].x).toFixed(1)},${sy(0).toFixed(1)}L${sx(se.points[0].x).toFixed(1)},${sy(0).toFixed(1)}Z`;
      svg.append(s('path', { d: area, fill: CRIT, 'fill-opacity': 0.16, 'clip-path': `url(#${id}a)` }));
      svg.append(s('path', { d: area, fill: GOOD, 'fill-opacity': 0.16, 'clip-path': `url(#${id}b)` }));
      svg.append(s('text', { x: W - M.r - 2, y: M.t + 12, 'text-anchor': 'end', class: 'wash-label' }, '▲ losing time'));
      svg.append(s('text', { x: W - M.r - 2, y: H - M.b - 6, 'text-anchor': 'end', class: 'wash-label' }, '▼ gaining time'));
    }
    for (const se of series.slice().reverse()) svg.append(s('path', { d: pathOf(se.points), class: 'series', stroke: se.color }));
    cursorG = s('g', { class: 'cursor' });
    svg.append(cursorG);
    const hit = s('rect', { x: M.l, y: 0, width: pw, height: H, fill: 'transparent', class: 'hit' });
    svg.append(hit);
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const x = xs + ((e.clientX - r.left - M.l) / pw) * (xe - xs);
      setCursor(Math.min(Math.max(x, xs), xe), true);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => setCursor(null, true));
    wrap.replaceChildren(svg, tip);
    if (cursorX != null) setCursor(cursorX, false);
  }

  function setCursor(x, fromUser) {
    cursorX = x;
    if (!cursorG) return;
    cursorG.replaceChildren();
    if (x == null || x < xs || x > xe) {
      tip.classList.remove('show');
      if (fromUser && opts.onCursor) opts.onCursor(null);
      return;
    }
    const X = sx(x);
    cursorG.append(s('line', { x1: X, x2: X, y1: M.t, y2: H - M.b, class: 'crosshair' }));
    const rows = [];
    for (const se of series) {
      const i = nearestIndex(se.points, x);
      if (i < 0) continue;
      const p = se.points[i];
      if (Math.abs(p.x - x) > (xe - xs) * 0.05) continue;
      cursorG.append(s('circle', { cx: sx(p.x), cy: sy(p.y), r: 4.5, fill: se.color, class: 'dot' }));
      rows.push(h('div', { class: 'tip-row' }, lineKey(se.color), h('strong', null, (opts.tipFmt || opts.yFmt || fmtNum)(p.y)), h('span', null, se.name)));
    }
    tip.replaceChildren(h('div', { class: 'tip-head' }, (opts.xFmtLong || opts.xFmt || fmtNum)(x)), ...rows);
    tip.classList.add('show');
    const left = Math.min(Math.max(X + 10, 4), W - 150);
    tip.style.left = (X > W * 0.6 ? Math.max(X - 160, 4) : left) + 'px';
    if (fromUser && opts.onCursor) opts.onCursor(x);
  }

  whenSized(wrap, render);
  return { el: fig, setCursor: (x) => setCursor(x, false) };
}

// ------------------------------------------------------------------------------ track map

/**
 * opts: { title, sub, path:[{lat,lon,v,d}], colorBy:'speed'|'delta', deltas:[per point delta],
 *         lines:[{line, kind:'start'|'finish'|'split', label}], turns:[{n,lat,lon}],
 *         annotate:true, outline:[[lat,lon]], onPick(lat,lon), height }
 */
export function trackMap(opts) {
  const fig = figure(opts.title, opts.sub);
  const wrap = h('div', { class: 'plot map' });
  fig.append(wrap);
  const scale = h('div', { class: 'scale-legend' });
  fig.append(scale);
  const path = (opts.path || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const all = path.length ? path : (opts.outline || []).map((q) => ({ lat: q[0], lon: q[1] }));
  if (!all.length) {
    wrap.append(h('p', { class: 'muted empty' }, 'No GPS path.'));
    return { el: fig, setMarker() {} };
  }
  let la0 = Infinity;
  let la1 = -Infinity;
  let lo0 = Infinity;
  let lo1 = -Infinity;
  const ext = (lat, lon) => {
    la0 = Math.min(la0, lat);
    la1 = Math.max(la1, lat);
    lo0 = Math.min(lo0, lon);
    lo1 = Math.max(lo1, lon);
  };
  for (const p of all) ext(p.lat, p.lon);
  for (const l of opts.lines || []) if (l.line) ext(l.line.lat, l.line.lon);
  const proj = new LocalProjection((la0 + la1) / 2, (lo0 + lo1) / 2);
  const [xa, ya] = proj.toXY(la0, lo0);
  const [xb, yb] = proj.toXY(la1, lo1);
  const spanX = Math.max(xb - xa, 30);
  const spanY = Math.max(yb - ya, 30);
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const p of path)
    if (p.v >= 0) {
      vmin = Math.min(vmin, p.v);
      vmax = Math.max(vmax, p.v);
    }
  const colorBy = opts.colorBy || 'speed';
  let dmax = 0;
  const dd = [];
  if (colorBy === 'delta' && opts.deltas) {
    for (let i = 1; i < path.length; i++) {
      const a = opts.deltas[i - 1];
      const b = opts.deltas[i];
      dd[i] = a != null && b != null ? b - a : null;
      if (dd[i] != null) dmax = Math.max(dmax, Math.abs(dd[i]));
    }
  }
  let toScreen;
  let marker;
  let W;
  let H;
  function render(width) {
    W = width;
    H = opts.height || Math.round(Math.min(Math.max((width * spanY) / spanX, 220), 420));
    const pad = 22;
    const k = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = (W - spanX * k) / 2;
    const oy = (H - spanY * k) / 2;
    toScreen = (lat, lon) => {
      const [x, y] = proj.toXY(lat, lon);
      return [ox + (x - xa) * k, H - oy - (y - ya) * k];
    };
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'plot-svg', role: 'img', 'aria-label': opts.title });
    const pts = path.map((p) => toScreen(p.lat, p.lon));
    const poly = (arr) => arr.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
    if (opts.outline && opts.outline.length > 1) {
      svg.append(s('path', { d: poly(opts.outline.map((q) => toScreen(q[0], q[1]))) + (opts.outlineOpen ? '' : 'Z'), class: 'outline' }));
    }
    if (pts.length > 1) {
      svg.append(s('path', { d: poly(pts), class: 'ring' }));
      // merge consecutive segments of the same colour bin into one path
      const bins = 24;
      let runStart = 0;
      let runBin = null;
      const binOf = (i) => {
        if (colorBy === 'delta') {
          if (dd[i] == null || !dmax) return 'n';
          return Math.round((dd[i] / dmax) * 8);
        }
        const v = ((path[i - 1].v >= 0 ? path[i - 1].v : path[i].v) + (path[i].v >= 0 ? path[i].v : path[i - 1].v)) / 2;
        return Math.round(((v - vmin) / (vmax - vmin || 1)) * bins);
      };
      const colorOf = (b) => (b === 'n' ? NEUTRAL : colorBy === 'delta' ? deltaColor(b / 8) : seqColor(b / bins));
      const flush = (end) => {
        if (runBin == null) return;
        svg.append(s('path', { d: poly(pts.slice(runStart, end + 1)), class: 'route', stroke: colorOf(runBin) }));
      };
      for (let i = 1; i < pts.length; i++) {
        const b = binOf(i);
        if (b !== runBin) {
          flush(i - 1);
          runStart = i - 1;
          runBin = b;
        }
      }
      flush(pts.length - 1);
    }
    for (const l of opts.lines || []) {
      if (!l.line) continue;
      const c = toScreen(l.line.lat, l.line.lon);
      const hr = l.line.heading * DEG;
      const half = Math.max(l.line.halfWidth * k, 9);
      const tx = Math.cos(hr);
      const ty = Math.sin(hr); // screen y grows down; tangent (cos h, -sin h) in east/north
      const a = [c[0] - half * tx, c[1] - half * ty];
      const b = [c[0] + half * tx, c[1] + half * ty];
      const isMain = l.kind !== 'split';
      svg.append(s('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: isMain ? 'tline main' : 'tline' }));
      // direction arrow
      const nx = Math.sin(hr);
      const ny = -Math.cos(hr);
      const tip = [c[0] + nx * 12, c[1] + ny * 12];
      svg.append(s('path', { d: `M${c[0] + nx * 4 - tx * 4},${c[1] + ny * 4 - ty * 4}L${tip[0]},${tip[1]}L${c[0] + nx * 4 + tx * 4},${c[1] + ny * 4 + ty * 4}`, class: isMain ? 'tarrow main' : 'tarrow' }));
      if (l.label) {
        const lx = b[0] + tx * 6;
        const ly = b[1] + ty * 6 + 4;
        svg.append(s('text', { x: lx, y: ly, class: 'map-label strong', 'text-anchor': tx >= 0 ? 'start' : 'end' }, l.label));
      }
    }
    if (opts.turns) {
      let cx = 0;
      let cy = 0;
      for (const q of pts) {
        cx += q[0];
        cy += q[1];
      }
      cx /= pts.length || 1;
      cy /= pts.length || 1;
      for (const t of opts.turns) {
        const [x, y] = toScreen(t.lat, t.lon);
        const dx = x - cx;
        const dy = y - cy;
        const n = Math.hypot(dx, dy) || 1;
        svg.append(s('text', { x: x + (dx / n) * 13, y: y + (dy / n) * 13 + 4, class: 'turn', 'text-anchor': 'middle' }, String(t.n)));
      }
    }
    if (opts.annotate && path.length > 10 && colorBy === 'speed') {
      for (const a of speedExtremes(path)) {
        const [x, y] = toScreen(a.lat, a.lon);
        svg.append(s('circle', { cx: x, cy: y, r: 3, class: 'anno-dot' }));
        svg.append(s('text', { x: x + 6, y: y - 6, class: 'map-label' }, a.text));
      }
    }
    marker = s('circle', { r: 6.5, class: 'map-marker', cx: -99, cy: -99 });
    svg.append(marker);
    if (opts.onPick) {
      svg.classList.add('pickable');
      svg.addEventListener('click', (e) => {
        const r = svg.getBoundingClientRect();
        const X = e.clientX - r.left;
        const Y = e.clientY - r.top;
        const x = (X - ox) / k + xa;
        const y = (H - oy - Y) / k + ya;
        const [lat, lon] = proj.toLatLon(x, y);
        opts.onPick(lat, lon);
      });
    }
    wrap.replaceChildren(svg);
  }
  // scale legend
  if (path.length && colorBy === 'speed' && vmax > vmin) {
    const bar = h('span', { class: 'ramp' });
    bar.style.background = `linear-gradient(90deg, ${SEQ.join(',')})`;
    scale.append(h('span', null, `${Math.round(vmin * 3.6)}`), bar, h('span', null, `${Math.round(vmax * 3.6)} km/h`));
  } else if (colorBy === 'delta') {
    scale.append(h('span', { class: 'sw good' }), h('span', null, '▼ gaining'), h('span', { class: 'sw crit' }), h('span', null, '▲ losing time on that stretch'));
  }
  whenSized(wrap, render);
  return {
    el: fig,
    setMarker(lat, lon) {
      if (!marker || !toScreen) return;
      if (lat == null) {
        marker.setAttribute('cx', -99);
        marker.setAttribute('cy', -99);
        return;
      }
      const [x, y] = toScreen(lat, lon);
      marker.setAttribute('cx', x);
      marker.setAttribute('cy', y);
    },
  };
}

/** Slowest corners and top speed, for selective labels on the map. */
function speedExtremes(path) {
  const out = [];
  const n = path.length;
  const W = 4;
  const mins = [];
  for (let i = W; i < n - W; i++) {
    const v = path[i].v;
    if (!(v >= 0)) continue;
    let isMin = true;
    for (let j = i - W; j <= i + W; j++) if (path[j].v < v) isMin = false;
    if (isMin) mins.push(path[i]);
  }
  mins.sort((a, b) => a.v - b.v);
  const chosen = [];
  for (const m of mins) {
    if (chosen.every((c) => Math.abs((c.d ?? 0) - (m.d ?? 0)) > 250 || c.d == null)) chosen.push(m);
    if (chosen.length >= 4) break;
  }
  for (const c of chosen) out.push({ lat: c.lat, lon: c.lon, text: `${Math.round(c.v * 3.6)}` });
  let top = null;
  for (const p of path) if (p.v >= 0 && (!top || p.v > top.v)) top = p;
  if (top) out.push({ lat: top.lat, lon: top.lon, text: `${Math.round(top.v * 3.6)} top` });
  return out;
}

// ------------------------------------------------------------------------------ G-G diagram

/** opts: { title, sub, series:[{name, color, pts:[{lat, lon, v, d}]}], table } (values in g) */
export function ggChart(opts) {
  const fig = figure(opts.title, opts.sub);
  const series = opts.series.filter((se) => se.pts.length);
  if (series.length >= 2) fig.append(legend(series, true));
  const wrap = h('div', { class: 'plot gg' });
  const tip = h('div', { class: 'tip' });
  fig.append(wrap);
  if (opts.table) fig.append(tableView(opts.table.columns, opts.table.rows));
  let m = 0.5;
  for (const se of series) for (const p of se.pts) m = Math.max(m, Math.abs(p.lat), Math.abs(p.lon));
  const G = Math.min(Math.max(Math.ceil(m / 0.5) * 0.5, 1), 3);
  function render(width) {
    const W = Math.min(width, 420);
    const pad = 26;
    const c = W / 2;
    const r = c - pad;
    const sc = r / G;
    const svg = s('svg', { width: W, height: W, viewBox: `0 0 ${W} ${W}`, class: 'plot-svg', role: 'img', 'aria-label': opts.title });
    const g = s('g', { class: 'grid' });
    const ringLabels = s('g', { class: 'grid' });
    for (let q = 0.5; q <= G + 1e-9; q += 0.5) {
      g.append(s('circle', { cx: c, cy: c, r: q * sc, class: 'ring-grid' }));
      ringLabels.append(s('text', { x: c + q * sc * 0.7071 + 3, y: c - q * sc * 0.7071 - 3, class: 'tick ring-label' }, `${q} g`));
    }
    g.append(s('line', { x1: pad, x2: W - pad, y1: c, y2: c, class: 'axis' }));
    g.append(s('line', { y1: pad, y2: W - pad, x1: c, x2: c, class: 'axis' }));
    g.append(s('text', { x: c, y: 14, 'text-anchor': 'middle', class: 'axis-word' }, 'Accelerating'));
    g.append(s('text', { x: c, y: W - 5, 'text-anchor': 'middle', class: 'axis-word' }, 'Braking'));
    g.append(s('text', { x: 4, y: c - 6, class: 'axis-word' }, 'Left'));
    g.append(s('text', { x: W - 4, y: c - 6, 'text-anchor': 'end', class: 'axis-word' }, 'Right'));
    svg.append(g);
    const flat = [];
    for (const se of series.slice().reverse()) {
      const grp = s('g');
      for (const p of se.pts) {
        const x = c + p.lat * sc;
        const y = c - p.lon * sc;
        grp.append(s('circle', { cx: x, cy: y, r: 4, fill: se.color, class: 'dot' }));
        flat.push({ x, y, p, se });
      }
      svg.append(grp);
    }
    svg.append(ringLabels); // drawn last so the dots never hide them
    const hl = s('circle', { r: 7, class: 'hl', cx: -99, cy: -99 });
    svg.append(hl);
    const hit = s('rect', { x: 0, y: 0, width: W, height: W, fill: 'transparent' });
    svg.append(hit);
    const move = (e) => {
      const b = svg.getBoundingClientRect();
      const X = e.clientX - b.left;
      const Y = e.clientY - b.top;
      let best = null;
      let bd = 24 * 24;
      for (const f of flat) {
        const d2 = (f.x - X) ** 2 + (f.y - Y) ** 2;
        if (d2 < bd) {
          bd = d2;
          best = f;
        }
      }
      if (!best) {
        tip.classList.remove('show');
        hl.setAttribute('cx', -99);
        return;
      }
      hl.setAttribute('cx', best.x);
      hl.setAttribute('cy', best.y);
      const p = best.p;
      put(tip,
        h('div', { class: 'tip-head' }, best.se.name),
        h('div', { class: 'tip-row' }, h('strong', null, `${Math.abs(p.lat).toFixed(2)} g`), h('span', null, p.lat >= 0 ? 'right' : 'left')),
        h('div', { class: 'tip-row' }, h('strong', null, `${Math.abs(p.lon).toFixed(2)} g`), h('span', null, p.lon >= 0 ? 'accelerating' : 'braking')),
        p.v != null ? h('div', { class: 'tip-row' }, h('strong', null, `${Math.round(p.v * 3.6)} km/h`), h('span', null, p.d != null ? `at ${Math.round(p.d)} m` : '')) : null,
      );
      tip.style.left = Math.min(best.x + 12, W - 150) + 'px';
      tip.style.top = Math.max(best.y - 70, 0) + 'px';
      tip.classList.add('show');
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => {
      tip.classList.remove('show');
      hl.setAttribute('cx', -99);
    });
    wrap.replaceChildren(svg, tip);
  }
  whenSized(wrap, render);
  return { el: fig };
}

// ------------------------------------------------------------------------------ sector bars

/** Diverging bars: time gained (green, left) or lost (red, right) per sector against the reference. */
export function sectorBars(opts) {
  const fig = figure(opts.title, opts.sub);
  const rows = opts.rows.filter((r) => r.delta != null);
  const wrap = h('div', { class: 'plot' });
  fig.append(wrap);
  if (!rows.length) {
    wrap.append(h('p', { class: 'muted empty' }, 'No sector times for this lap.'));
    return { el: fig };
  }
  const maxAbs = Math.max(0.1, ...rows.map((r) => Math.abs(r.delta)));
  function render(width) {
    const W = width;
    const rowH = 34;
    const H = rows.length * rowH + 8;
    const labW = 96;
    const c = labW + (W - labW) / 2;
    const half = (W - labW) / 2 - 58;
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'plot-svg', role: 'img', 'aria-label': opts.title });
    svg.append(s('line', { x1: c, x2: c, y1: 2, y2: H - 2, class: 'zero' }));
    rows.forEach((r, i) => {
      const y = 4 + i * rowH + rowH / 2;
      svg.append(s('text', { x: 0, y: y + 4, class: 'bar-label' }, r.label));
      const len = Math.max((Math.abs(r.delta) / maxAbs) * half, 2);
      const t = 20;
      const rad = Math.min(4, len);
      const color = r.delta <= 0 ? GOOD : CRIT;
      // bar grows from the zero line; 4px rounded data end, square at the baseline
      const d =
        r.delta <= 0
          ? `M${c},${y - t / 2}H${c - len + rad}Q${c - len},${y - t / 2} ${c - len},${y - t / 2 + rad}V${y + t / 2 - rad}Q${c - len},${y + t / 2} ${c - len + rad},${y + t / 2}H${c}Z`
          : `M${c},${y - t / 2}H${c + len - rad}Q${c + len},${y - t / 2} ${c + len},${y - t / 2 + rad}V${y + t / 2 - rad}Q${c + len},${y + t / 2} ${c + len - rad},${y + t / 2}H${c}Z`;
      svg.append(s('path', { d, fill: color }));
      const txt = `${fmtDelta(r.delta)} ${r.delta <= 0 ? '▼' : '▲'}`;
      svg.append(s('text', { x: r.delta <= 0 ? c - len - 6 : c + len + 6, y: y + 4, 'text-anchor': r.delta <= 0 ? 'end' : 'start', class: 'bar-value' }, txt));
    });
    wrap.replaceChildren(svg);
  }
  whenSized(wrap, render);
  fig.append(h('div', { class: 'legend' }, h('span', { class: 'key' }, h('span', { class: 'sw good' }), '▼ gained'), h('span', { class: 'key' }, h('span', { class: 'sw crit' }), '▲ lost')));
  return { el: fig };
}

// ------------------------------------------------------------------------------ pictogram

/** Small outline drawing of a track or route (lists and cards). */
export function outlineIcon(latlon, size = 52) {
  const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'outline-icon', 'aria-hidden': 'true' });
  if (!latlon || latlon.length < 2) {
    svg.append(s('circle', { cx: size / 2, cy: size / 2, r: size / 4, class: 'oi-path' }));
    return svg;
  }
  let la0 = Infinity;
  let la1 = -Infinity;
  let lo0 = Infinity;
  let lo1 = -Infinity;
  for (const [la, lo] of latlon) {
    la0 = Math.min(la0, la);
    la1 = Math.max(la1, la);
    lo0 = Math.min(lo0, lo);
    lo1 = Math.max(lo1, lo);
  }
  const pr = new LocalProjection((la0 + la1) / 2, (lo0 + lo1) / 2);
  const [xa, ya] = pr.toXY(la0, lo0);
  const [xb, yb] = pr.toXY(la1, lo1);
  const span = Math.max(xb - xa, yb - ya, 1);
  const pad = 5;
  const k = (size - 2 * pad) / span;
  const ox = (size - (xb - xa) * k) / 2;
  const oy = (size - (yb - ya) * k) / 2;
  const step = Math.max(1, Math.floor(latlon.length / 160));
  let d = '';
  for (let i = 0; i < latlon.length; i += step) {
    const [x, y] = pr.toXY(latlon[i][0], latlon[i][1]);
    d += `${d ? 'L' : 'M'}${(ox + (x - xa) * k).toFixed(1)},${(size - oy - (y - ya) * k).toFixed(1)}`;
  }
  svg.append(s('path', { d, class: 'oi-path' }));
  const [x0, y0] = pr.toXY(latlon[0][0], latlon[0][1]);
  svg.append(s('circle', { cx: ox + (x0 - xa) * k, cy: size - oy - (y0 - ya) * k, r: 2.5, class: 'oi-start' }));
  return svg;
}
