import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { cosSlice, cosCdf, cosPut } from '../../site/js/heston.js';
import { horizon, fan, FAN_PROBS, oneIn } from '../../site/js/odds.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/cdf_reference.json', import.meta.url)));
const { r, q } = fx;

test('COS CDF matches the Gil-Pelaez reference, including stressed sets', () => {
  for (const c of fx.cases) {
    const slice = cosSlice(c.T, fx.params[c.set], { r, q });
    const got = cosCdf(slice, c.x);
    assert.ok(Math.abs(got - c.cdf) < 1e-9, `${c.set} T=${c.T} x=${c.x}: ${got} vs ${c.cdf}`);
  }
});

test('CDF agrees with the derivative of put prices (digital = dP/dK)', () => {
  const p = fx.params.today_like;
  const T = 0.25;
  const slice = cosSlice(T, p, { r, q });
  for (const K of [0.85, 0.95, 1.0, 1.1]) {
    const h = 1e-4;
    const digital = (cosPut(slice, 1, K + h) - cosPut(slice, 1, K - h)) / (2 * h);
    // dP/dK = e^{-rT} P(S_T <= K)
    const cdf = cosCdf(slice, Math.log(K));
    assert.ok(Math.abs(digital * Math.exp(r * T) - cdf) < 1e-6, `K=${K}`);
  }
});

test('below/above are complementary and monotone', () => {
  const h = horizon(fx.params.today_like, 1, { r, q });
  let prev = -1;
  for (const k of [0.5, 0.7, 0.8, 0.9, 1, 1.1, 1.3]) {
    const b = h.below(k);
    assert.ok(b >= prev);
    assert.ok(Math.abs(b + h.above(k) - 1) < 1e-15);
    prev = b;
  }
});

test('quantile inverts the CDF', () => {
  for (const name of Object.keys(fx.params)) {
    const h = horizon(fx.params[name], 0.5, { r, q });
    for (const p of [0.01, 0.05, 0.5, 0.95]) {
      const x = h.quantile(p);
      assert.ok(Math.abs(h.below(x) - p) < 1e-5, `${name} p=${p}`);
    }
  }
});

test('fan is ordered and widens with horizon', () => {
  const f = fan(fx.params.today_like, [1 / 12, 0.5, 1], { r, q });
  assert.equal(f[0].q.length, FAN_PROBS.length);
  for (const row of f) for (let i = 1; i < row.q.length; i++) assert.ok(row.q[i] > row.q[i - 1]);
  const width = (row) => row.q[4] / row.q[0];
  assert.ok(width(f[0]) < width(f[1]) && width(f[1]) < width(f[2]));
});

test('the CDF integrates to the forward: E[S_T/S_0] = integral of P(S_T/S_0 > k) dk = e^{(r-q)T}', () => {
  for (const name of ['today_like', 'crisis']) {
    const T = 1;
    const h = horizon(fx.params[name], T, { r, q, N: 1024 });
    const dk = 0.002;
    let mean = 0;
    for (let k = dk / 2; k < 6; k += dk) mean += h.above(k) * dk;   // midpoint rule
    const F = Math.exp((r - q) * T);
    assert.ok(Math.abs(mean - F) < 2e-4, `${name}: ${mean} vs ${F}`);
  }
});

test('oneIn phrasing', () => {
  assert.equal(oneIn(0.1), 'about 1 in 10');
  assert.equal(oneIn(0.032), 'about 1 in 30');
  assert.equal(oneIn(0.004), 'about 1 in 250');
  assert.equal(oneIn(1e-6), 'less than 1 in 10,000');
  assert.equal(oneIn(0.6), '60 in 100');
});
