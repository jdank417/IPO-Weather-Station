// Market Weather Station: market-implied S&P 500 odds (Odds tab) and a
// day-by-day replay of past stress episodes (Crisis replay tab).

import { horizon, fan, oneIn } from './odds.js';
import { surfaceGrid } from './termstructure.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const pct0 = (p) => (p < 0.01 && p > 0 ? `${(100 * p).toFixed(1)}%` : `${Math.round(100 * p)}%`);
const fmtLevel = (x) => Math.round(x).toLocaleString('en-US');
const parseDate = (d) => new Date(`${d}T12:00:00Z`);
const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => parseDate(d).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
const isoDate = (t) => new Date(t).toISOString().slice(0, 10);
const yearsBetween = (a, b) => (parseDate(b) - parseDate(a)) / (365 * DAY);

const state = { latest: null, history: null, events: [], params: null };

/* ---------- theme ---------- */

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const seq = v('--seq').split(',').map((s) => s.trim());
  return {
    surface: v('--surface'), text: v('--text'), text2: v('--text-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'), font: v('--font'), accent: v('--accent'),
    s1: v('--series-1'), s2: v('--series-2'), down: v('--down'),
    colorscale: seq.map((c, i) => [i / (seq.length - 1), c]),
  };
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const plotlyReady = () => typeof window.Plotly !== 'undefined';
const baseLayout = (t) => ({
  paper_bgcolor: t.surface, plot_bgcolor: t.surface,
  font: { family: t.font, color: t.text, size: 12 },
  hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.text, family: t.font } },
});
const axisStyle = (t) => ({ gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted }, zeroline: false });

/* ---------- Odds tab ---------- */

function paramsOf(src) {
  return { v0: src.v0, kappa: src.kappa, theta: src.theta, xi: src.xi, rho: src.rho };
}

function yearEndTarget(asof) {
  // Dec 31 of this year, or next year's if fewer than 30 days remain
  const y = +asof.slice(0, 4);
  const end = `${y}-12-31`;
  return yearsBetween(asof, end) * 365 >= 30 ? end : `${y + 1}-12-31`;
}

function renderHeadlines() {
  const L = state.latest;
  const p = state.params;
  const opts = { r: L.r, q: L.q };
  const target = yearEndTarget(L.date);
  const Tye = yearsBetween(L.date, target);
  const ye = horizon(p, Tye, opts);
  const yr = horizon(p, 1, opts);
  const cards = [
    { label: `S&P 500 down 10% or more on ${fmtDate(target)}`, p: ye.below(0.9), dir: 'down', level: 0.9 },
    { label: `S&P 500 up 10% or more on ${fmtDate(target)}`, p: ye.above(1.1), dir: 'up', level: 1.1 },
    { label: 'S&P 500 20% or more lower, a year from now', p: yr.below(0.8), dir: 'down', level: 0.8 },
  ];
  cards.forEach((c, i) => {
    $(`h${i + 1}-label`).textContent = c.label;
    $(`h${i + 1}-value`).innerHTML = `<span class="arrow ${c.dir}" aria-hidden="true">${c.dir === 'down' ? '▼' : '▲'}</span>${pct0(c.p)}`;
    $(`h${i + 1}-sub`).textContent = `${oneIn(c.p)} · S&P ${c.dir === 'down' ? 'at or below' : 'at or above'} ${fmtLevel(L.spx.level * c.level)}`;
  });
}

function renderAsk() {
  const L = state.latest;
  const dir = $('ask-dir').value;
  const size = +$('ask-size').value;
  const days = +$('ask-when').value;
  const h = horizon(state.params, days / 365, { r: L.r, q: L.q });
  const ratio = dir === 'down' ? 1 - size : 1 + size;
  const p = dir === 'down' ? h.below(ratio) : h.above(ratio);
  const date = isoDate(parseDate(L.date).getTime() + days * DAY);
  $('ask-value').textContent = pct0(p);
  $('ask-sub').textContent = `${oneIn(p)}: the S&P ${dir === 'down' ? 'at or below' : 'at or above'} ${fmtLevel(L.spx.level * ratio)} around ${fmtDate(date)}.`;
}

function drawFan() {
  if (!plotlyReady()) return;
  const t = tokens();
  const L = state.latest;
  // weekly for the first month (the fan opens fastest there), then monthly
  const Ts = [1 / 52, 2 / 52, 3 / 52, ...Array.from({ length: 12 }, (_, i) => (i + 1) / 12)];
  const rows = fan(state.params, Ts, { r: L.r, q: L.q });
  const t0 = parseDate(L.date).getTime();
  const x = [L.date, ...Ts.map((T) => isoDate(t0 + T * 365 * DAY))];
  const S = L.spx.level;
  const col = (i) => [S, ...rows.map((r) => S * r.q[i])];
  const pctText = (ys) => ys.map((y) => `${y >= S ? '+' : '−'}${Math.abs(100 * (y / S - 1)).toFixed(1)}%`);
  const band = (lo, hi, alpha, name) => [
    { x, y: col(lo), type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    { x, y: col(hi), type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: hexA(t.s1, alpha), name, hoverinfo: 'skip' },
  ];
  const mid = col(2);
  Plotly.react('fan', [
    ...band(0, 4, 0.14, '9 in 10 outcomes'),
    ...band(1, 3, 0.28, 'Even chance'),
    { x, y: mid, type: 'scatter', mode: 'lines', name: 'Middle outcome', line: { color: t.s1, width: 2 },
      text: pctText(mid), hovertemplate: 'Middle: %{y:,.0f} (%{text})<extra></extra>' },
    { x, y: col(0), type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, text: pctText(col(0)),
      hovertemplate: '1-in-20 low: %{y:,.0f} (%{text})<extra></extra>' },
    { x, y: col(4), type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, text: pctText(col(4)),
      hovertemplate: '1-in-20 high: %{y:,.0f} (%{text})<extra></extra>' },
    { x: [L.date], y: [S], type: 'scatter', mode: 'markers', name: 'Today', marker: { size: 9, color: t.s1, line: { color: t.surface, width: 2 } },
      hovertemplate: 'Today: %{y:,.0f}<extra></extra>' },
  ], {
    ...baseLayout(t),
    margin: { l: 56, r: 12, t: 8, b: 32 },
    hovermode: 'x unified',
    showlegend: true,
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { color: t.text2 } },
    xaxis: { ...axisStyle(t), type: 'date' },
    yaxis: { ...axisStyle(t), tickformat: ',.0f', title: { text: 'S&P 500', font: { color: t.text2 } } },
  }, { responsive: false, displayModeBar: false });
}

/* ---------- Replay tab ---------- */

const replay = { idx: 0, lo: 0, hi: 0, event: null, playing: false, timer: null, grid: null, zRange: null };

function setWindow(lo, hi, event) {
  replay.lo = lo; replay.hi = hi; replay.event = event;
  const H = state.history;
  // fixed vertical scale for the whole episode so the landscape visibly rises and falls
  let maxVol = 0;
  for (let i = lo; i <= hi; i++) maxVol = Math.max(maxVol, Math.sqrt(H.v0[i]), Math.sqrt(H.theta[i]));
  replay.zRange = [0, Math.max(30, Math.ceil(110 * maxVol / 10) * 10)];
  const scrub = $('scrub');
  scrub.min = String(lo); scrub.max = String(hi);
  for (const b of document.querySelectorAll('#events button')) b.setAttribute('aria-pressed', String(b.dataset.id === (event?.id ?? '')));
  $('r-blurb').textContent = event ? `${event.title}: ${event.blurb}` : '';
  $('r-facts').textContent = event ? eventFacts(event) : '';
  showDay(lo);
}

function eventFacts(e) {
  const parts = [];
  if (e.spx_drawdown < 0) parts.push(`The S&P 500 fell ${Math.abs(100 * e.spx_drawdown).toFixed(1)}% from ${fmtDate(e.drawdown_from)} to ${fmtDate(e.drawdown_to)}.`);
  if (e.peak_vix) parts.push(`The VIX peaked at ${e.peak_vix.toFixed(1)} on ${fmtDate(e.peak_vix_date)}.`);
  parts.push(`Peak odds of a 10%+ monthly drop: ${pct0(e.peak_down10_1m)} on ${fmtDate(e.peak_down10_1m_date)}.`);
  return parts.join(' ');
}

function paramsAt(i) {
  const H = state.history;
  return { v0: H.v0[i], kappa: H.kappa[i], theta: H.theta[i], xi: H.xi[i], rho: H.rho[i] };
}

function showDay(i) {
  const H = state.history;
  replay.idx = i;
  $('scrub').value = String(i);
  $('r-date').textContent = fmtDate(H.dates[i], { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  $('r-odds').textContent = pct0(H.p_down10_1m[i]);
  $('r-approx').hidden = !H.approx[i];
  // strikes span the same number of standard deviations at each day's own vol,
  // so the smile stays visible in calm and panicked markets alike
  replay.grid = surfaceGrid(paramsAt(i));
  requestSurface(paramsAt(i));
  scheduleTimelineMarker();
}

/* surface worker, with coalescing and an adaptive redraw budget */
let worker = null, inFlight = false, pending = null;
const PLAY_N = 512;

function startWorker() {
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      inFlight = false;
      if (!e.data.error) onSurface(e.data.iv);
      if (pending) { const p = pending; pending = null; requestSurface(p); }
    };
    worker.onerror = () => { worker = null; inFlight = false; };
  } catch { worker = null; }
}

async function requestSurface(p) {
  if (!worker) {
    const { ivSurface } = await import('./surface.js');
    onSurface(ivSurface(p, replay.grid.Ts, replay.grid.ks, { N: PLAY_N }));
    return;
  }
  if (inFlight) { pending = p; return; }
  inFlight = true;
  worker.postMessage({ params: p, Ts: replay.grid.Ts, ks: replay.grid.ks, opts: { N: PLAY_N } });
}

const budget = { last: 0, cost: 40 };
let surfaceTimer = null, latestIv = null;

function onSurface(iv) {
  latestIv = iv;
  const wait = Math.max(80, 3 * budget.cost) - (performance.now() - budget.last);
  clearTimeout(surfaceTimer);
  if (replay.playing && wait > 0) surfaceTimer = setTimeout(drawSurface, wait);
  else requestAnimationFrame(drawSurface);
}

function drawSurface() {
  if (!plotlyReady() || !latestIv || $('panel-replay').hidden) return;
  const t0 = performance.now();
  const t = tokens();
  const { Ts, zs, ks } = replay.grid;
  const narrow = $('surface').clientWidth < 560;
  const z = latestIv.map((row) => row.map((v) => (Number.isFinite(v) ? 100 * v : null)));
  const custom = Ts.map((T, i) => ks[i].map((k) => [T < 1 / 12 ? `${Math.round(T * 52)} wk` : `${Math.round(T * 12)} mo`, (100 * (Math.exp(k) - 1)).toFixed(0)]));
  const axis = (title) => ({
    title: { text: title, font: { size: 12, color: t.text2 } }, tickfont: { size: 11, color: t.muted },
    gridcolor: t.grid, zerolinecolor: t.axis, linecolor: t.axis, backgroundcolor: t.surface, showbackground: true,
  });
  Plotly.react('surface', [{
    type: 'surface', uid: 'iv', x: zs, y: Ts, z, customdata: custom,
    colorscale: t.colorscale, cauto: false, cmin: replay.zRange[0], cmax: replay.zRange[1], showscale: false,
    hovertemplate: '%{customdata[0]} ahead, price %{customdata[1]}% from today<br>Turbulence priced in: %{z:.0f}%<extra></extra>',
  }], {
    uirevision: 'keep', paper_bgcolor: t.surface, font: { family: t.font, color: t.text }, margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      xaxis: { ...axis(narrow ? 'price' : 'price: drops ← → rises'), showticklabels: false },
      yaxis: axis(narrow ? 'years' : 'years ahead'),
      zaxis: { ...axis(narrow ? '' : 'turbulence %'), range: replay.zRange, autorange: false },
      camera: { eye: narrow ? { x: -1.6, y: -1.6, z: 0.9 } : { x: -1.45, y: -1.6, z: 0.8 } },
      aspectmode: 'manual', aspectratio: narrow ? { x: 0.85, y: 0.85, z: 0.6 } : { x: 1.2, y: 1.2, z: 0.8 },
    },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.text, family: t.font } },
  }, { responsive: false, displaylogo: false, modeBarButtonsToRemove: ['toImage', 'resetCameraLastSave3d'] });
  budget.last = performance.now();
  budget.cost = 0.7 * budget.cost + 0.3 * (budget.last - t0);
  watchGlContext();
}

function watchGlContext() {
  const canvas = document.querySelector('#surface canvas');
  if (!canvas || canvas.__watched) return;
  canvas.__watched = true;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    setTimeout(() => { Plotly.purge('surface'); drawSurface(); }, 250);
  });
}

function drawTimeline() {
  if (!plotlyReady()) return;
  const t = tokens();
  const H = state.history;
  const shapes = state.events.map((e) => ({
    type: 'rect', xref: 'x', yref: 'paper', x0: e.start, x1: e.end, y0: 0, y1: 1, layer: 'below',
    fillcolor: hexA(t.s2, 0.12), line: { width: 0 },
  }));
  Plotly.react('timeline', [{
    x: H.dates, y: H.p_down10_1m.map((p) => 100 * p), type: 'scatter', mode: 'lines', name: 'Crash odds',
    line: { color: t.s1, width: 1.5 }, hovertemplate: '%{x|%b %d, %Y}: %{y:.1f}%<extra></extra>',
  }], {
    ...baseLayout(t), shapes: [...shapes, marker(t)],
    margin: { l: 40, r: 8, t: 8, b: 28 }, hovermode: 'x', showlegend: false,
    xaxis: { ...axisStyle(t), type: 'date' },
    yaxis: { ...axisStyle(t), ticksuffix: '%', rangemode: 'tozero' },
  }, { responsive: false, displayModeBar: false });
  if ($('timeline').__clickBound) return;
  $('timeline').__clickBound = true;
  $('timeline').on('plotly_click', (ev) => {
    const d = ev.points?.[0]?.x;
    if (!d) return;
    const i = state.history.dates.indexOf(String(d).slice(0, 10));
    if (i >= 0) { stop(); setWindow(Math.max(0, i - 40), Math.min(H.dates.length - 1, i + 40), null); showDay(i); }
  });
}

const marker = (t) => ({
  type: 'line', xref: 'x', yref: 'paper', x0: state.history.dates[replay.idx], x1: state.history.dates[replay.idx],
  y0: 0, y1: 1, line: { color: t.text, width: 1.5 },
});

let markerQueued = false;
function scheduleTimelineMarker() {
  if (markerQueued || !plotlyReady() || !$('timeline').layout) return;
  markerQueued = true;
  requestAnimationFrame(() => {
    markerQueued = false;
    const t = tokens();
    const shapes = $('timeline').layout.shapes.slice(0, -1);
    Plotly.relayout('timeline', { shapes: [...shapes, marker(t)] });
  });
}

function play() {
  if (replay.idx >= replay.hi) showDay(replay.lo);
  replay.playing = true;
  $('play').textContent = '❚❚ Pause';
  $('play').setAttribute('aria-label', 'Pause');
  const tick = () => {
    if (!replay.playing) return;
    if (replay.idx >= replay.hi) { stop(); return; }
    showDay(replay.idx + 1);
    // pace by how long the device takes to draw the landscape
    replay.timer = setTimeout(tick, Math.max(140, 3 * budget.cost));
  };
  replay.timer = setTimeout(tick, 100);
}

function stop() {
  replay.playing = false;
  clearTimeout(replay.timer);
  $('play').textContent = '▶ Play';
  $('play').setAttribute('aria-label', 'Play');
  if (latestIv) requestAnimationFrame(drawSurface);
}

function buildEventChips() {
  const box = $('events');
  box.innerHTML = state.events.map((e) => `<button type="button" data-id="${e.id}" aria-pressed="false">${e.title} <span class="muted">${e.peak_down10_1m_date.slice(0, 4)}</span></button>`).join('');
  for (const b of box.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      stop();
      const e = state.events.find((x) => x.id === b.dataset.id);
      setWindow(e.first_index, e.last_index, e);
      play();
    });
  }
}

/* ---------- tabs ---------- */

function selectTab(name) {
  for (const [tab, panel] of [['tab-odds', 'panel-odds'], ['tab-replay', 'panel-replay']]) {
    const on = tab === `tab-${name}`;
    $(tab).setAttribute('aria-selected', String(on));
    $(tab).tabIndex = on ? 0 : -1;
    $(panel).hidden = !on;
  }
  if (name === 'replay') {
    if (!replay.grid) {
      const covid = state.events.find((e) => e.id === 'covid-2020') || state.events[state.events.length - 1];
      setWindow(covid.first_index, covid.last_index, covid);
    }
    drawTimeline();
    requestAnimationFrame(drawSurface);
  } else {
    stop();
    drawFan();
  }
  history.replaceState(null, '', `#${name}`);
}

/* ---------- boot ---------- */

async function main() {
  try {
    const [latest, hist, ev] = await Promise.all(['latest', 'history', 'events'].map(
      (f) => fetch(`data/${f}.json`, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); })));
    state.latest = latest; state.history = hist; state.events = ev.events;
  } catch (err) {
    console.error(err);
    document.querySelector('main').innerHTML = '<p class="error">Today\'s data could not be loaded. Please try again later.</p>';
    return;
  }
  const L = state.latest;
  state.params = paramsOf(L.params);
  $('asof').textContent = `As of the ${fmtDate(L.date)} close, S&P 500 at ${fmtLevel(L.spx.level)}.`;
  $('model-note').textContent = `Today's model: spot volatility ${(100 * Math.sqrt(L.params.v0)).toFixed(1)}%, long-run ${(100 * Math.sqrt(L.params.theta)).toFixed(1)}%, fear half-life ${Math.round(365 * Math.LN2 / L.params.kappa)} days, vol of vol ${L.params.xi.toFixed(2)} (from VVIX ${L.vvix}), spot-vol correlation ${L.params.rho.toFixed(2)} (${L.rho_source === 'realized' ? 'past year' : 'default'}). VIX ${L.vix}: higher than ${Math.round(100 * L.vix_percentile)}% of days since ${L.vix_since.slice(0, 4)}.`;

  renderHeadlines();
  renderAsk();
  $('ask').addEventListener('change', renderAsk);

  startWorker();
  buildEventChips();
  $('play').addEventListener('click', () => (replay.playing ? stop() : play()));
  $('scrub').addEventListener('input', () => { stop(); showDay(+$('scrub').value); });

  for (const name of ['odds', 'replay']) $(`tab-${name}`).addEventListener('click', () => selectTab(name));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = $('tab-odds').getAttribute('aria-selected') === 'true' ? 'replay' : 'odds';
    selectTab(next); $(`tab-${next}`).focus();
  });

  const start = () => selectTab(location.hash === '#replay' ? 'replay' : 'odds');
  if (plotlyReady()) start();
  else window.addEventListener('load', () => {
    if (plotlyReady()) start();
    else for (const id of ['fan', 'surface', 'timeline']) $(id).innerHTML = '<p class="error">The chart library could not be loaded.</p>';
  });

  // redraw charts on width changes and theme changes
  if ('ResizeObserver' in window) {
    const widths = new Map(); let timer = null;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) { const w = Math.round(e.contentRect.width); if (widths.get(e.target) !== w) { widths.set(e.target, w); changed = true; } }
      if (!changed || !plotlyReady()) return;
      clearTimeout(timer);
      timer = setTimeout(() => { for (const id of ['fan', 'surface', 'timeline']) if ($(id).data) Plotly.Plots.resize($(id)); }, 150);
    });
    for (const id of ['fan', 'surface', 'timeline']) ro.observe($(id));
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ($('panel-odds').hidden) { drawTimeline(); drawSurface(); } else drawFan();
  });
}

main();
