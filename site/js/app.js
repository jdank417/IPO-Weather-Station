// Page controller: IPO forecast, today's readings, scenario buttons and
// sliders, the implied-vol "fear landscape" (Web Worker), the VIX fear curve
// and the IPO history.

import { fellerOK } from './heston.js';
import { ivSurface } from './surface.js';
import {
  SURFACE_TS, modelVix, surfaceGrid, halfLifeDays, expectedAvgVariance,
} from './termstructure.js';
import { buildGauge } from './regime.js';

const DEFAULT_XI = 0.6;
const DEFAULT_RHO = -0.7;
// used only if today's data cannot be loaded
const FALLBACK = { v0: 0.04, kappa: 2.0, theta: 0.05 };

const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const minus = (s) => String(s).replace('-', '−');

const MATURITY_LABELS = ['1w', '2w', '1m', '2m', '3m', '6m', '9m', '1y', '18m', '2y'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const fmtDays = (d) => (d >= 730 ? `${(d / 365).toFixed(1)} years` : `${Math.round(d)} days`);
const nextMonth = (m) => { const y = +m.slice(0, 4), mm = +m.slice(5, 7); return `${y + (mm === 12)}-${String(mm % 12 + 1).padStart(2, '0')}`; };
// gauge-only inputs: they never touch the surface
const GAUGE_ONLY = new Set(['skew', 'be5']);

const state = {
  today: null,     // {v0, kappa, theta} from latest.json
  latest: null,
  params: null,    // current slider values {v0, kappa, theta, xi, rho}
  grid: null,      // fixed strike grid from today's fit
  iv: null,
};

/* ---------- theme tokens ---------- */

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  const seq = v('--seq').split(',').map((s) => s.trim());
  return {
    surface: v('--surface'), text: v('--text'), text2: v('--text-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'), font: v('--font'),
    s1: v('--series-1'), s2: v('--series-2'), s3: v('--series-3'),
    colorscale: seq.map((c, i) => [i / (seq.length - 1), c]),
  };
}

/* ---------- sliders ---------- */

const SLIDERS = {
  v0: { el: 's-v0', out: 'o-v0', toInput: Math.sqrt, fromInput: (x) => x * x, fmt: (v) => pct(Math.sqrt(v)) },
  theta: { el: 's-theta', out: 'o-theta', toInput: Math.sqrt, fromInput: (x) => x * x, fmt: (v) => pct(Math.sqrt(v)) },
  kappa: { el: 's-kappa', out: 'o-kappa', toInput: (x) => x, fromInput: (x) => x, fmt: (k) => `half-life ${fmtDays(halfLifeDays(k))}` },
  xi: { el: 's-xi', out: 'o-xi', toInput: (x) => x, fromInput: (x) => x, fmt: (x) => x.toFixed(2) },
  rho: { el: 's-rho', out: 'o-rho', toInput: (x) => x, fromInput: (x) => x, fmt: (x) => minus(x.toFixed(2)) },
  skew: { el: 's-skew', out: 'o-skew', toInput: (x) => x, fromInput: (x) => x, fmt: (x) => x.toFixed(1) },
  be5: { el: 's-be5', out: 'o-be5', toInput: (x) => x, fromInput: (x) => x, fmt: (x) => `${x.toFixed(2)}%` },
};

function setSliders(p) {
  for (const [key, s] of Object.entries(SLIDERS)) {
    if (p[key] == null) continue;
    const input = $(s.el);
    const x = s.toInput(p[key]);
    // clamp to the slider's range so out-of-range fits still display
    input.value = String(Math.min(Math.max(x, +input.min), +input.max));
    $(s.out).textContent = s.fmt(p[key]);
  }
}

// Read only the slider that moved, so untouched parameters keep their exact
// fitted values instead of snapping to the slider step.
function readSlider(target) {
  const entry = Object.entries(SLIDERS).find(([, s]) => s.el === target.id);
  if (!entry) return null;
  const [key, s] = entry;
  state.params = { ...state.params, [key]: s.fromInput(parseFloat(target.value)) };
  $(s.out).textContent = s.fmt(state.params[key]);
  return key;
}

/* ---------- surface computation (worker with main-thread fallback) ---------- */

let worker = null;
let inFlight = false;
let pending = null;
let reqId = 0;

function startWorker() {
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      inFlight = false;
      if (e.data.error) console.error('surface worker:', e.data.error);
      else onSurface(e.data.iv, e.data.ms);
      if (pending) { const p = pending; pending = null; requestSurface(p); }
    };
    worker.onerror = (err) => {
      console.warn('worker failed, computing on the main thread', err);
      worker = null;
      inFlight = false;
      if (state.params) requestSurface(state.params);
    };
  } catch (err) {
    console.warn('module workers unavailable, computing on the main thread', err);
    worker = null;
  }
}

// While a finger or mouse is down, price with fewer cosine terms (accurate to
// about 1e-4 of spot even in stressed cases; see docs/pricing.rst) so slow
// devices keep up; the exact surface (COS_N terms) follows on release.
const PREVIEW_N = 512;

function requestSurface(p) {
  if (inFlight) { pending = p; return; }      // coalesce slider drags
  const { Ts, ks } = state.grid;
  const opts = dragging ? { N: PREVIEW_N } : {};
  if (worker) {
    inFlight = true;
    worker.postMessage({ id: ++reqId, params: p, Ts, ks, opts });
  } else {
    const t0 = performance.now();
    onSurface(ivSurface(p, Ts, ks, opts), performance.now() - t0);
  }
}

function onSurface(iv, ms) {
  state.iv = iv;
  // build the plotted z array once per result so redraws reuse it
  state.z = iv.map((row) => row.map((v) => (Number.isFinite(v) ? 100 * v : null)));
  state.calcMs = ms;
  scheduleDraw({ surface: true, ts: false });
}

/* ---------- drawing: at most once per animation frame ---------- */

// Charts are redrawn only when their data or appearance changed. While a slider
// is held, each chart is also rate-limited by its own measured draw cost
// (an exponential average), so a slow phone spends at most about a quarter of
// its main-thread time on the 3D surface and a third on the fear curve, and the
// slider stays responsive. The exact final state is drawn on release.
const dirty = { surface: false, ts: false, history: false };
const budget = {
  surface: { last: 0, cost: 40, minGap: 100, share: 4 },
  ts: { last: 0, cost: 8, minGap: 33, share: 3 },
};
let drawQueued = false;
let dragging = false;
const timers = {};

function waitFor(kind) {
  if (!dragging) return 0;
  const b = budget[kind];
  return Math.max(b.minGap, b.share * b.cost) - (performance.now() - b.last);
}

function timed(kind, fn) {
  const t0 = performance.now();
  fn();
  const b = budget[kind];
  b.last = performance.now();
  b.cost = 0.7 * b.cost + 0.3 * (b.last - t0);
}

function deferDraw(kind, wait) {
  clearTimeout(timers[kind]);
  timers[kind] = setTimeout(() => scheduleDraw({ surface: kind === 'surface', ts: kind === 'ts', history: false }), wait);
}

function scheduleDraw({ surface = true, ts = true, history = surface && ts } = {}) {
  dirty.surface ||= surface;
  dirty.ts ||= ts;
  dirty.history ||= history;
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(flushDraw);
}

function flushDraw() {
  drawQueued = false;
  if (dirty.history) {
    dirty.history = false;
    drawHistory();
  }
  if (dirty.ts) {
    const wait = waitFor('ts');
    if (wait > 0) deferDraw('ts', wait);
    else {
      dirty.ts = false;
      timed('ts', drawTermStructure);
      if ($('ts-table').closest('details').open) renderTsTable();
    }
  }
  if (dirty.surface) {
    const wait = waitFor('surface');
    if (wait > 0) deferDraw('surface', wait);
    else {
      dirty.surface = false;
      if (state.calcMs != null) $('calc-time').textContent = `Computed in ${state.calcMs.toFixed(0)} ms in your browser.`;
      timed('surface', drawSurface);
      if ($('surface-table').closest('details').open) renderSurfaceTable();
    }
  }
}

// While a slider is held, the z-axis and color ranges only grow, never jump
// around, so the surface reshapes in place instead of rescaling every frame.
let dragRange = null;
function ivRange() {
  let lo = Infinity, hi = -Infinity;
  for (const row of state.iv || []) for (const v of row) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return Number.isFinite(lo) ? [100 * lo, 100 * hi] : null;
}
function startDrag() {
  dragging = true;
  const r = ivRange();
  dragRange = r ? [r[0] - 0.05 * (r[1] - r[0]), r[1] + 0.05 * (r[1] - r[0])] : null;
}
function endDrag() {
  if (!dragging) return;
  dragging = false;
  dragRange = null;
  // exact pricing (full COS_N) and an immediate final draw of everything
  if (state.params) requestSurface(state.params);
  scheduleDraw({ surface: true, ts: true, history: false });
}

/* ---------- charts ---------- */

function plotlyReady() {
  return typeof window.Plotly !== 'undefined';
}

function drawSurface() {
  if (!plotlyReady() || !state.iv) return;
  const t = tokens();
  const { Ts, zs, ks } = state.grid;
  const narrow = document.getElementById('surface').clientWidth < 560;
  if (dragRange) {
    const r = ivRange();
    if (r) dragRange = [Math.min(dragRange[0], r[0]), Math.max(dragRange[1], r[1])];
  }
  const locked = dragRange ? { range: dragRange.slice(), autorange: false } : { autorange: true };
  // plot on a rectangular (sd, T) grid; the hover reports the actual ln(K/F)
  const { z } = state;
  const custom = state.grid.custom ||= Ts.map((T, i) => ks[i].map((k) => [MATURITY_LABELS[i], k]));

  const axis = (title) => ({
    title: { text: title, font: { size: 12, color: t.text2 } },
    tickfont: { size: 11, color: t.muted },
    gridcolor: t.grid, zerolinecolor: t.axis, linecolor: t.axis,
    backgroundcolor: t.surface, showbackground: true,
  });

  Plotly.react('surface', [{
    type: 'surface', uid: 'iv-surface', x: zs, y: Ts, z, customdata: custom,
    colorscale: t.colorscale,
    ...(dragRange ? { cauto: false, cmin: dragRange[0], cmax: dragRange[1] } : { cauto: true }),
    // narrow screens: no colorbar (hover and the table carry the values)
    showscale: !narrow,
    colorbar: {
      title: { text: 'turbulence %', font: { color: t.text2, size: 12 } },
      tickfont: { color: t.muted, size: 11 }, thickness: 12, len: 0.6, outlinewidth: 0,
    },
    hovertemplate: '%{customdata[0]} ahead, price level %{x:.2f} sd<br>Implied volatility %{z:.1f}%<br><span style="font-size:11px">ln(K/F) %{customdata[1]:.3f}</span><extra></extra>',
  }], {
    uirevision: 'keep',
    paper_bgcolor: t.surface,
    font: { family: t.font, color: t.text },
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      xaxis: axis(narrow ? 'price level' : 'price level (drops ← → rises)'),
      yaxis: axis(narrow ? 'years' : 'time ahead (years)'),
      zaxis: { ...axis(narrow ? '' : 'turbulence (%)'), ...locked },
      camera: { eye: narrow ? { x: -1.6, y: -1.6, z: 0.9 } : { x: -1.45, y: -1.6, z: 0.75 } },
      aspectmode: 'manual',
      aspectratio: narrow ? { x: 0.85, y: 0.85, z: 0.55 } : { x: 1.2, y: 1.2, z: 0.75 },
    },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.text, family: t.font } },
  }, { responsive: false, displaylogo: false, modeBarButtonsToRemove: ['toImage', 'resetCameraLastSave3d'] });
  watchGlContext();
}

// If the browser drops the WebGL context (GPU memory pressure, backgrounded tab,
// mobile GPU reset), Plotly cannot recover by itself and the surface vanishes.
// Rebuild the plot from scratch once the context is gone.
function watchGlContext() {
  const canvas = document.querySelector('#surface canvas');
  if (!canvas || canvas.__watched) return;
  canvas.__watched = true;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('WebGL context lost; rebuilding the surface');
    setTimeout(() => {
      Plotly.purge('surface');
      scheduleDraw({ surface: true, ts: false });
    }, 250);
  });
}

function differsFromToday(p) {
  const a = state.today;
  return Math.abs(p.v0 - a.v0) > 1e-9 || Math.abs(p.kappa - a.kappa) > 1e-9 || Math.abs(p.theta - a.theta) > 1e-9;
}

function drawTermStructure() {
  if (!plotlyReady() || !state.today) return;
  const t = tokens();
  const days = Array.from({ length: 74 }, (_, i) => 1 + i * 5);
  const traces = [];
  if (state.latest) {
    traces.push({
      type: 'scatter', mode: 'lines', name: 'Model fit', uid: 'ts-today', legendrank: 1,
      x: state.latest.curve.days, y: state.latest.curve.level,
      line: { color: t.s1, width: 2 },
      hovertemplate: 'Model fit %{y:.1f}<extra></extra>',
    });
  }
  // always present (drawn beneath today's fit) so the legend never reflows
  const yours = differsFromToday(state.params);
  traces.unshift({
    type: 'scatter', mode: 'lines', name: 'Your settings', uid: 'ts-yours', legendrank: 2,
    x: days, y: days.map((d) => modelVix(d / 365, state.params)),
    line: { color: t.s3, width: 2 },
    hoverinfo: yours ? undefined : 'skip',
    hovertemplate: 'Your settings %{y:.1f}<extra></extra>',
  });
  if (state.latest) {
    const pts = state.latest.points;
    traces.push({
      type: 'scatter', mode: 'markers+text', name: "Today's VIX readings", uid: 'ts-cboe', legendrank: 3,
      x: pts.map((p) => p.days), y: pts.map((p) => p.level),
      text: pts.map((p) => p.symbol), textposition: pts.map((p, i) => (i < 2 ? 'bottom right' : 'top left')),
      textfont: { color: t.text2, size: 11 },
      marker: { color: t.s2, size: 10, line: { color: t.surface, width: 2 } },
      hovertemplate: '%{text} %{y:.1f}<extra></extra>',
    });
  }
  Plotly.react('termstructure', traces, {
    paper_bgcolor: t.surface, plot_bgcolor: t.surface,
    font: { family: t.font, color: t.text, size: 12 },
    margin: { l: 48, r: 12, t: 36, b: 40 },
    hovermode: 'x unified',
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.0, x: 0, font: { color: t.text2 } },
    xaxis: {
      title: { text: 'days ahead', font: { color: t.text2 } },
      range: [0, 370], gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false,
    },
    yaxis: {
      title: { text: 'expected turbulence (%)', font: { color: t.text2 } },
      gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false,
    },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.text } },
  }, { responsive: false, displaylogo: false, displayModeBar: false });
}

/* ---------- tables, tiles, badge ---------- */

function renderSurfaceTable() {
  const { zs } = state.grid;
  const head = `<thead><tr><th scope="col">Maturity</th>${zs.map((z) => `<th scope="col">${minus(z.toFixed(2))} sd</th>`).join('')}</tr></thead>`;
  const body = state.iv.map((row, i) => `<tr><th scope="row">${MATURITY_LABELS[i]}</th>${
    row.map((v) => `<td>${Number.isFinite(v) ? (100 * v).toFixed(1) : '–'}</td>`).join('')}</tr>`).join('');
  $('surface-table').innerHTML = `<caption class="note">Implied vol (%) by maturity and strike (standard deviations of ln(K/F))</caption>${head}<tbody>${body}</tbody>`;
}

function renderTsTable() {
  if (!state.latest) return;
  const rows = state.latest.points.map((p) => `<tr><th scope="row">${p.symbol}</th><td>${p.days}</td><td>${p.level.toFixed(2)}</td><td>${p.fitted.toFixed(2)}</td><td>${modelVix(p.days / 365, state.params).toFixed(2)}</td></tr>`).join('');
  $('ts-table').innerHTML = '<thead><tr><th scope="col">Index</th><th scope="col">Days ahead</th><th scope="col">Today\'s reading</th><th scope="col">Model fit</th><th scope="col">Your settings</th></tr></thead>'
    + `<tbody>${rows}</tbody>`;
}

const ICON_OK = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.5 8.2l2.2 2.2 4.8-4.8" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARN = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l7 12.5H1z" fill="currentColor"/><path d="M8 6v4" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="12" r=".9" fill="#0b0b0b"/></svg>';

function renderFeller(p) {
  const el = $('feller');
  const ok = fellerOK(p);
  el.hidden = false;
  el.className = `badge ${ok ? 'ok' : 'warn'}`;
  const lhs = (2 * p.kappa * p.theta).toFixed(3);
  const rhs = (p.xi * p.xi).toFixed(3);
  el.innerHTML = ok
    ? `${ICON_OK}<span>Model check passed <span class="muted">(Feller: 2κθ = ${lhs} > ξ² = ${rhs})</span></span>`
    : `${ICON_WARN}<span>Model warning: with these settings volatility can hit zero <span class="muted">(Feller: 2κθ = ${lhs} ≤ ξ² = ${rhs})</span></span>`;
}

function renderTiles() {
  const L = state.latest;
  if (!L) {
    $('fit-note').textContent = "Today's data could not be loaded; showing illustrative parameters.";
    for (const id of ['t-v0', 't-theta', 't-kappa', 't-skew']) $(id).textContent = '–';
    return;
  }
  const p = L.params;
  $('fit-date').textContent = `· market close ${L.date}`;
  $('t-v0').textContent = pct(Math.sqrt(p.v0));
  $('t-theta').textContent = pct(Math.sqrt(p.theta));
  $('t-kappa').innerHTML = `${fmtDays(halfLifeDays(p.kappa))}<span class="tile-sub">for a fear spike to halve</span>`;
  $('t-skew').innerHTML = L.skew ? `${L.skew.level.toFixed(0)}<span class="tile-sub">typical range 115 to 160</span>` : '–';
  const flags = L.fit.flags.length ? ` Flags: ${L.fit.flags.join(', ')}.` : '';
  const stale = L.latest_data_date !== L.date ? ` The newest day (${L.latest_data_date}) could not be fitted.` : '';
  $('fit-note').textContent = `Read from ${L.fit.n_points} Cboe VIX indices; the model matches them to within ${L.fit.rmse_volpts.toFixed(2)} points on average.${flags}${stale}`;
}

/* ---------- IPO forecast ---------- */

function gaugeInputs(p) {
  const vol1y = 100 * Math.sqrt(expectedAvgVariance(1, p));
  return { vol1y, skew: p.skew, be5: p.be5 };
}

// Weather icons (inline SVG, currentColor): snowflake, cloud, sun.
const ICONS = {
  cold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2v20M4.2 6.5l15.6 11M4.2 17.5l15.6-11"/><path d="M9.5 3.5L12 6l2.5-2.5M9.5 20.5L12 18l2.5 2.5"/></svg>',
  mixed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 9.5 4.25 4.25 0 0 0 7 18z"/></svg>',
  hot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
};

function condition(p) {
  if (p < 0.25) return { key: 'cold', word: 'Cold', text: 'a quiet month for listings is most likely' };
  if (p < 0.6) return { key: 'mixed', word: 'Changeable', text: 'it could go either way' };
  return { key: 'hot', word: 'Hot', text: 'a busy month for listings is most likely' };
}

function confidence(lo, hi) {
  const w = hi - lo;
  if (w > 0.5) return 'Low confidence';
  if (w > 0.25) return 'Medium confidence';
  return 'High confidence';
}

let todayForecast = null;

function renderGauge() {
  const g = state.gauge;
  if (!g) {
    $('g-value').textContent = '–';
    $('g-condition').textContent = 'Unavailable';
    $('g-label').textContent = 'The IPO model could not be loaded.';
    $('mini-gauge').textContent = 'IPO forecast unavailable.';
    return;
  }
  const inp = gaugeInputs(state.params);
  const r = g.probability([inp.vol1y, inp.skew, inp.be5]);
  const next = monthName(nextMonth(g.currentMonth));
  const p0 = (x) => `${Math.round(100 * x)}%`;
  const c = condition(r.p);
  $('g-icon').innerHTML = ICONS[c.key];
  $('g-condition').textContent = c.word;
  $('g-value').textContent = p0(r.p);
  $('g-label').textContent = `chance that ${next} is a hot IPO month: ${c.text}`;
  $('g-fill').style.width = `${(100 * r.p).toFixed(1)}%`;
  $('g-band').style.left = `${(100 * r.lo).toFixed(1)}%`;
  $('g-band').style.width = `${(100 * (r.hi - r.lo)).toFixed(1)}%`;
  $('g-meter').setAttribute('aria-label', `${p0(r.p)}; plausible range ${p0(r.lo)} to ${p0(r.hi)}`);
  $('g-confidence').textContent = confidence(r.lo, r.hi);
  $('g-band-text').textContent = `The shaded band is the plausible range, ${p0(r.lo)} to ${p0(r.hi)}: the model's own uncertainty about how the market behaves.`;

  let delta = '';
  if (todayForecast != null) {
    // one decimal for small moves so a real change never reads as "same"
    const d = 100 * (r.p - todayForecast);
    const ad = Math.abs(d) < 1 ? Math.round(Math.abs(d) * 10) / 10 : Math.round(Math.abs(d));
    delta = ad === 0
      ? ' <span class="delta">same as today</span>'
      : ` <span class="delta">${d > 0 ? '+' : '−'}${ad} ${ad === 1 ? 'pt' : 'pts'} vs today</span>`;
  }
  $('mini-gauge').innerHTML = `${ICONS[c.key].replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px"')} Hot-IPO chance for ${next}: <strong>${p0(r.p)}</strong>${delta}`;
  $('vol1y-note').textContent = `The three fear settings reach the forecast through one number, the average turbulence expected over the next year: now ${inp.vol1y.toFixed(1)}%.`;
}

function renderRegimeStatic() {
  const R = state.regime;
  if (!R) {
    for (const id of ['s-skew', 's-be5']) $(id).disabled = true;
    $('history-note').textContent = 'The IPO model data could not be loaded.';
    return;
  }
  const means = R.regime_means_ipos_per_month;
  const last = R.last_filtered;
  const fwd = R.forward.months;
  $('g-hot-def').textContent = `In hot months about ${Math.round(means.hot)} companies go public; in cold months about ${Math.round(means.cold)}. Since 2009 the market has spent roughly ${Math.round(100 * mean(R.history.p_hot_smoothed))}% of months hot.`;
  const facts = [
    `The latest IPO counts (${monthName(last.month)}) point to a ${last.p_hot >= 0.5 ? 'hot' : 'cold'} market.`,
    fwd.length > 1 ? `IPO counts for ${monthName(fwd[1])} onward aren't published yet, so the model fills that gap using each month's fear and inflation readings.` : null,
    driversSentence(R, last.p_hot >= 0.5 ? 'hot' : 'cold'),
  ].filter(Boolean);
  $('g-facts').innerHTML = facts.map((f) => `<li>${f}</li>`).join('');
  renderHistoryTables();
}

// Which way each input pushes the odds, read from the exported coefficients
// for the current regime (so the wording follows the data, not a script).
function driversSentence(R, regime) {
  const names = { vol1y: 'fear', skew: 'crash worries', be5: 'inflation expectations' };
  const lower = [], higher = [];
  for (const c of R.coefficients) {
    if (c.from !== regime || !names[c.covariate]) continue;
    (c.gamma < 0 ? lower : higher).push(names[c.covariate]);
  }
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const goal = regime === 'cold' ? 'the chance a cold market turns hot' : 'the chance a hot market stays hot';
  const parts = [];
  if (lower.length) parts.push(`lower ${list(lower)}`);
  if (higher.length) parts.push(`higher ${list(higher)}`);
  return `In the model, ${parts.join(' and ')} raise ${goal}.`;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// contiguous runs where the smoothed hot probability is at least 50%
function hotPeriods(months, p) {
  const runs = [];
  let start = null;
  months.forEach((m, i) => {
    if (p[i] >= 0.5 && start == null) start = m;
    if ((p[i] < 0.5 || i === months.length - 1) && start != null) {
      const end = p[i] >= 0.5 ? m : months[i - 1];
      runs.push([`${start}-01`, `${nextMonth(end)}-01`]);
      start = null;
    }
  });
  return runs;
}

function drawHistory() {
  const R = state.regime;
  if (!plotlyReady() || !R) return;
  const t = tokens();
  const H = R.history;
  const dates = H.months.map((m) => `${m}-15`);
  const shapes = hotPeriods(H.months, H.p_hot_smoothed).map(([x0, x1]) => ({
    type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, layer: 'below',
    fillcolor: hexA(t.s2, 0.1), line: { width: 0 },
  }));
  const base = {
    shapes,
    paper_bgcolor: t.surface, plot_bgcolor: t.surface,
    font: { family: t.font, color: t.text, size: 12 },
    margin: { l: 44, r: 12, t: 8, b: 28 },
    hovermode: 'x unified',
    // both charts share one date range so they line up vertically
    xaxis: {
      type: 'date', gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false,
      range: [`${H.months[0]}-01`, `${nextMonth(state.forward?.length ? state.forward[state.forward.length - 1].month : H.months[H.months.length - 1])}-15`],
    },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.text } },
    showlegend: false,
  };
  Plotly.react('ipo-chart', [{
    type: 'scatter', mode: 'lines', name: 'IPOs', uid: 'ipo',
    x: dates, y: H.net_ipos, line: { color: t.s1, width: 2, shape: 'hvh' },
    fill: 'tozeroy', fillcolor: hexA(t.s1, 0.12),
    hovertemplate: '%{y} companies went public<extra></extra>',
  }], { ...base, yaxis: { gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false, rangemode: 'tozero' } },
  { responsive: false, displayModeBar: false });

  const fp = state.forward || [];
  Plotly.react('phot-chart', [{
    type: 'scatter', mode: 'lines', name: 'Model estimate', uid: 'ph',
    x: dates, y: H.p_hot_smoothed.map((v) => 100 * v), line: { color: t.s1, width: 2 },
    hovertemplate: '%{y:.0f}% chance hot<extra></extra>',
  }, {
    type: 'scatter', mode: 'lines+markers', name: 'Forecast (no IPO data yet)', uid: 'pf',
    x: fp.map((d) => `${d.month}-15`), y: fp.map((d) => 100 * d.p),
    line: { color: t.s2, width: 2 }, marker: { size: 8, color: t.s2, line: { color: t.surface, width: 2 } },
    hovertemplate: '%{y:.0f}% chance hot (forecast)<extra></extra>',
  }], {
    ...base,
    showlegend: true,
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.0, x: 0, font: { color: t.text2 } },
    margin: { ...base.margin, t: 28 },
    yaxis: { range: [0, 100], ticksuffix: '%', gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false },
  }, { responsive: false, displayModeBar: false });
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function renderHistoryTables() {
  const R = state.regime;
  const H = R.history;
  const rows = H.months.map((m, i) => `<tr><th scope="row">${m}</th><td>${H.net_ipos[i]}</td><td>${Math.round(100 * H.p_hot_smoothed[i])}%</td><td>${Math.round(100 * H.p_hot_filtered[i])}%</td></tr>`).reverse().join('');
  const fwd = (state.forward || []).map((d) => `<tr><th scope="row">${d.month}</th><td>–</td><td colspan="2">forecast ${Math.round(100 * d.p)}%</td></tr>`).reverse().join('');
  $('history-table').innerHTML = '<caption class="note">Newest first. Smoothed uses all months; filtered uses data up to that month.</caption>'
    + '<thead><tr><th scope="col">Month</th><th scope="col">Net IPOs</th><th scope="col">P(hot), smoothed</th><th scope="col">P(hot), filtered</th></tr></thead>'
    + `<tbody>${fwd}${rows}</tbody>`;

  const labels = Object.fromEntries([['const', 'constant'], ...R.covariates.map((c) => [c.key, c.label])]);
  $('coef-table').innerHTML = '<caption class="note">Transition coefficients: P(next month hot | this month\'s regime) = logistic(γ · [1, z])</caption>'
    + '<thead><tr><th scope="col">From regime</th><th scope="col">Covariate</th><th scope="col">γ</th><th scope="col">Std. error</th></tr></thead><tbody>'
    + R.coefficients.map((c) => `<tr><th scope="row">${c.from}</th><td style="text-align:left">${labels[c.covariate]}</td><td>${minus(c.gamma.toFixed(2))}</td><td>${c.se.toFixed(2)}</td></tr>`).join('')
    + '</tbody>';
  if (R.comparison) {
    $('comparison-table').innerHTML = '<caption class="note">Alternative covariate sets, same sample (lower AIC/BIC is better)</caption>'
      + '<thead><tr><th scope="col">Specification</th><th scope="col">Params</th><th scope="col">Log-lik.</th><th scope="col">AIC</th><th scope="col">BIC</th></tr></thead><tbody>'
      + R.comparison.map((c) => `<tr><th scope="row">${c.spec}</th><td>${c.k ?? '–'}</td><td>${c.llf != null ? minus(c.llf.toFixed(1)) : '–'}</td><td>${c.aic?.toFixed(1) ?? '–'}</td><td>${c.bic?.toFixed(1) ?? '–'}</td></tr>`).join('')
      + '</tbody>';
  }
}

/* ---------- wiring ---------- */

function update(key = null) {
  renderGauge();
  if (key && GAUGE_ONLY.has(key)) return;   // SKEW / breakeven: forecast only
  renderFeller(state.params);
  requestSurface(state.params);          // the surface redraws when the worker answers
  scheduleDraw({ surface: false, ts: true });
}

// One-tap scenarios for non-specialists. Values are relative to today where
// that reads naturally (e.g. "inflation scare" keeps today's fear).
const SCENARIOS = {
  calm: () => ({ v0: 0.11 ** 2, theta: 0.17 ** 2, kappa: 3, skew: 125, be5: 2.0 }),
  panic: () => ({ v0: 0.55 ** 2, theta: 0.3 ** 2, kappa: 6 }),
  crash: () => ({ skew: 170 }),
  inflation: () => ({ be5: 3.5 }),
};

function applyScenario(name) {
  reset({ redraw: false });
  if (name !== 'today') state.params = { ...state.params, ...SCENARIOS[name]() };
  setSliders(state.params);
  for (const b of document.querySelectorAll('[data-scenario]')) b.setAttribute('aria-pressed', String(b.dataset.scenario === name));
  update();
}

function reset({ redraw = true } = {}) {
  const li = state.regime?.latest_inputs;
  state.params = {
    ...state.today, xi: DEFAULT_XI, rho: DEFAULT_RHO,
    skew: li?.skew.value ?? state.latest?.skew?.level ?? 140, be5: li?.be5.value ?? 2.3,
  };
  setSliders(state.params);
  for (const b of document.querySelectorAll('[data-scenario]')) b.setAttribute('aria-pressed', String(b.dataset.scenario === 'today'));
  if (redraw) update();
}

// Resize charts only when their width changes (debounced). Plotly's own
// "responsive" mode also reacts to height-only window resizes, which mobile
// browsers fire whenever the address bar shows or hides.
function watchWidths() {
  if (!('ResizeObserver' in window)) return;
  const widths = new Map();
  let timer = null;
  const ro = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const w = Math.round(e.contentRect.width);
      if (widths.get(e.target) !== w) { widths.set(e.target, w); changed = true; }
    }
    if (!changed || !plotlyReady()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const id of ['surface', 'termstructure', 'ipo-chart', 'phot-chart']) if ($(id).data) Plotly.Plots.resize($(id));
      scheduleDraw();
    }, 150);
  });
  for (const id of ['surface', 'termstructure', 'ipo-chart', 'phot-chart']) ro.observe($(id));
}

async function main() {
  try {
    const res = await fetch('data/latest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.latest = await res.json();
    const p = state.latest.params;
    state.today = { v0: p.v0, kappa: p.kappa, theta: p.theta };
  } catch (err) {
    console.error('could not load data/latest.json', err);
    state.today = { ...FALLBACK };
  }
  try {
    const res = await fetch('data/regime.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.regime = await res.json();
    state.gauge = buildGauge(state.regime);
    state.forward = state.gauge.forwardPath;
  } catch (err) {
    console.error('could not load data/regime.json', err);
    state.regime = null;
    state.gauge = null;
  }
  renderTiles();
  renderRegimeStatic();
  state.grid = surfaceGrid(state.today, SURFACE_TS);
  startWorker();

  $('controls').addEventListener('input', (e) => {
    for (const b of document.querySelectorAll('[data-scenario]')) b.setAttribute('aria-pressed', 'false');
    update(readSlider(e.target));
  });
  for (const b of document.querySelectorAll('[data-scenario]')) b.addEventListener('click', () => applyScenario(b.dataset.scenario));
  $('controls').addEventListener('pointerdown', (e) => { if (e.target.type === 'range') startDrag(); });
  for (const ev of ['pointerup', 'pointercancel', 'change']) window.addEventListener(ev, endDrag);
  for (const d of document.querySelectorAll('details')) d.addEventListener('toggle', () => scheduleDraw());
  watchWidths();
  $('reset').addEventListener('click', () => reset());
  reset();
  // remember today's forecast so the panel can show the change
  if (state.gauge) {
    const inp = gaugeInputs(state.params);
    todayForecast = state.gauge.probability([inp.vol1y, inp.skew, inp.be5]).p;
    renderGauge();
  }

  // Plotly is a deferred classic script; it is normally ready before this module runs.
  if (!plotlyReady()) {
    window.addEventListener('load', () => {
      if (plotlyReady()) scheduleDraw();
      else {
        for (const id of ['surface', 'termstructure', 'ipo-chart', 'phot-chart']) {
          $(id).innerHTML = '<p class="error">The chart library could not be loaded. The tables below still show the values.</p>';
          $(id).style.height = 'auto';
        }
      }
    });
  }

  // redraw with the other palette when the color scheme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => scheduleDraw());
}

main();
