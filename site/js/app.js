// Stage 1 UI: today's fit, parameter sliders, IV surface (Web Worker) and
// the VIX term-structure panel.

import { fellerOK } from './heston.js';
import { ivSurface } from './surface.js';
import {
  SURFACE_TS, modelVix, surfaceGrid, halfLifeDays,
} from './termstructure.js';

const DEFAULT_XI = 0.6;
const DEFAULT_RHO = -0.7;
// used only if today's data cannot be loaded
const FALLBACK = { v0: 0.04, kappa: 2.0, theta: 0.05 };

const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const minus = (s) => String(s).replace('-', '−');

const MATURITY_LABELS = ['1w', '2w', '1m', '2m', '3m', '6m', '9m', '1y', '18m', '2y'];

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
  kappa: { el: 's-kappa', out: 'o-kappa', toInput: (x) => x, fromInput: (x) => x, fmt: (k) => `${k.toFixed(2)} · half-life ${Math.round(halfLifeDays(k))} d` },
  xi: { el: 's-xi', out: 'o-xi', toInput: (x) => x, fromInput: (x) => x, fmt: (x) => x.toFixed(2) },
  rho: { el: 's-rho', out: 'o-rho', toInput: (x) => x, fromInput: (x) => x, fmt: (x) => minus(x.toFixed(2)) },
};

function setSliders(p) {
  for (const [key, s] of Object.entries(SLIDERS)) {
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
  if (!entry) return;
  const [key, s] = entry;
  state.params = { ...state.params, [key]: s.fromInput(parseFloat(target.value)) };
  $(s.out).textContent = s.fmt(state.params[key]);
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

function requestSurface(p) {
  if (inFlight) { pending = p; return; }      // coalesce slider drags
  const { Ts, ks } = state.grid;
  if (worker) {
    inFlight = true;
    worker.postMessage({ id: ++reqId, params: p, Ts, ks });
  } else {
    const t0 = performance.now();
    onSurface(ivSurface(p, Ts, ks), performance.now() - t0);
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

// The 3D surface is by far the most expensive redraw. It is redrawn only when
// its data or appearance changed, and at most every SURFACE_MIN_MS while a
// slider is held so the main thread stays free to track the finger; the exact
// final surface is drawn on release.
const SURFACE_MIN_MS = 120;
const dirty = { surface: false, ts: false };
let drawQueued = false;
let lastSurfaceDraw = 0;
let surfaceTimer = null;

function scheduleDraw({ surface = true, ts = true } = {}) {
  dirty.surface ||= surface;
  dirty.ts ||= ts;
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(flushDraw);
}

function flushDraw() {
  drawQueued = false;
  if (dirty.ts) {
    dirty.ts = false;
    drawTermStructure();
    if ($('ts-table').closest('details').open) renderTsTable();
  }
  if (dirty.surface) {
    const wait = dragRange ? SURFACE_MIN_MS - (performance.now() - lastSurfaceDraw) : 0;
    if (wait > 0) {
      clearTimeout(surfaceTimer);
      surfaceTimer = setTimeout(() => scheduleDraw({ surface: true, ts: false }), wait);
      return;
    }
    dirty.surface = false;
    lastSurfaceDraw = performance.now();
    if (state.calcMs != null) $('calc-time').textContent = `Computed in ${state.calcMs.toFixed(0)} ms in your browser.`;
    drawSurface();
    if ($('surface-table').closest('details').open) renderSurfaceTable();
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
  const r = ivRange();
  dragRange = r ? [r[0] - 0.05 * (r[1] - r[0]), r[1] + 0.05 * (r[1] - r[0])] : null;
}
function endDrag() {
  if (!dragRange) return;
  dragRange = null;
  scheduleDraw({ surface: true, ts: false });
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
      title: { text: 'IV %', font: { color: t.text2, size: 12 } },
      tickfont: { color: t.muted, size: 11 }, thickness: 12, len: 0.6, outlinewidth: 0,
    },
    hovertemplate: 'Maturity %{customdata[0]}<br>Strike %{x:.2f} sd · ln(K/F) %{customdata[1]:.3f}<br>Implied vol %{z:.1f}%<extra></extra>',
  }], {
    uirevision: 'keep',
    paper_bgcolor: t.surface,
    font: { family: t.font, color: t.text },
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      xaxis: axis(narrow ? 'strike sd' : 'strike (sd of ln K/F)'),
      yaxis: axis(narrow ? 'T (yr)' : 'maturity (years)'),
      zaxis: { ...axis(narrow ? '' : 'implied vol (%)'), ...locked },
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
      type: 'scatter', mode: 'lines', name: "Today's fit", uid: 'ts-today', legendrank: 1,
      x: state.latest.curve.days, y: state.latest.curve.level,
      line: { color: t.s1, width: 2 },
      hovertemplate: "Today's fit %{y:.2f}<extra></extra>",
    });
  }
  // always present (drawn beneath today's fit) so the legend never reflows
  const yours = differsFromToday(state.params);
  traces.unshift({
    type: 'scatter', mode: 'lines', name: 'Your parameters', uid: 'ts-yours', legendrank: 2,
    x: days, y: days.map((d) => modelVix(d / 365, state.params)),
    line: { color: t.s3, width: 2 },
    hoverinfo: yours ? undefined : 'skip',
    hovertemplate: 'Your parameters %{y:.2f}<extra></extra>',
  });
  if (state.latest) {
    const pts = state.latest.points;
    traces.push({
      type: 'scatter', mode: 'markers+text', name: 'Cboe index close', uid: 'ts-cboe', legendrank: 3,
      x: pts.map((p) => p.days), y: pts.map((p) => p.level),
      text: pts.map((p) => p.symbol), textposition: pts.map((p, i) => (i < 2 ? 'bottom right' : 'top left')),
      textfont: { color: t.text2, size: 11 },
      marker: { color: t.s2, size: 10, line: { color: t.surface, width: 2 } },
      hovertemplate: '%{text} %{y:.2f}<extra></extra>',
    });
  }
  Plotly.react('termstructure', traces, {
    paper_bgcolor: t.surface, plot_bgcolor: t.surface,
    font: { family: t.font, color: t.text, size: 12 },
    margin: { l: 48, r: 12, t: 36, b: 40 },
    hovermode: 'x unified',
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.0, x: 0, font: { color: t.text2 } },
    xaxis: {
      title: { text: 'horizon (calendar days)', font: { color: t.text2 } },
      range: [0, 370], gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false,
    },
    yaxis: {
      title: { text: 'vol points', font: { color: t.text2 } },
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
  $('ts-table').innerHTML = '<thead><tr><th scope="col">Index</th><th scope="col">Days</th><th scope="col">Close</th><th scope="col">Today\'s fit</th><th scope="col">Your parameters</th></tr></thead>'
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
    ? `${ICON_OK}<span>Feller condition holds (2κθ = ${lhs} > ξ² = ${rhs})</span>`
    : `${ICON_WARN}<span>Feller condition fails (2κθ = ${lhs} ≤ ξ² = ${rhs}): variance can touch zero</span>`;
}

function renderTiles() {
  const L = state.latest;
  if (!L) {
    $('fit-note').textContent = "Today's data could not be loaded; showing illustrative parameters.";
    for (const id of ['t-v0', 't-theta', 't-kappa', 't-skew']) $(id).textContent = '–';
    return;
  }
  const p = L.params;
  $('fit-date').textContent = `· ${L.date}`;
  $('t-v0').textContent = pct(Math.sqrt(p.v0));
  $('t-theta').textContent = pct(Math.sqrt(p.theta));
  $('t-kappa').innerHTML = `${Math.round(halfLifeDays(p.kappa))} days<span class="tile-sub">κ = ${p.kappa.toFixed(2)} per year</span>`;
  $('t-skew').innerHTML = L.skew ? `${L.skew.level.toFixed(1)}<span class="tile-sub">as of ${L.skew.date}</span>` : '–';
  const flags = L.fit.flags.length ? ` Flags: ${L.fit.flags.join(', ')}.` : '';
  const stale = L.latest_data_date !== L.date ? ` The newest day (${L.latest_data_date}) could not be fitted.` : '';
  $('fit-note').textContent = `Fit to ${L.fit.n_points} Cboe indices; root-mean-square error ${L.fit.rmse_volpts.toFixed(2)} vol points.${flags}${stale}`;
}

/* ---------- wiring ---------- */

function update() {
  renderFeller(state.params);
  requestSurface(state.params);          // the surface redraws when the worker answers
  scheduleDraw({ surface: false, ts: true });
}

function reset() {
  state.params = { ...state.today, xi: DEFAULT_XI, rho: DEFAULT_RHO };
  setSliders(state.params);
  update();
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
      for (const id of ['surface', 'termstructure']) if ($(id).data) Plotly.Plots.resize($(id));
      scheduleDraw();
    }, 150);
  });
  ro.observe($('surface'));
  ro.observe($('termstructure'));
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
  renderTiles();
  state.grid = surfaceGrid(state.today, SURFACE_TS);
  startWorker();

  $('controls').addEventListener('input', (e) => { readSlider(e.target); update(); });
  $('controls').addEventListener('pointerdown', (e) => { if (e.target.type === 'range') startDrag(); });
  for (const ev of ['pointerup', 'pointercancel', 'change']) window.addEventListener(ev, endDrag);
  for (const d of document.querySelectorAll('details')) d.addEventListener('toggle', () => scheduleDraw());
  watchWidths();
  $('reset').addEventListener('click', reset);
  reset();

  // Plotly is a deferred classic script; it is normally ready before this module runs.
  if (!plotlyReady()) {
    window.addEventListener('load', () => {
      if (plotlyReady()) scheduleDraw();
      else {
        for (const id of ['surface', 'termstructure']) {
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
