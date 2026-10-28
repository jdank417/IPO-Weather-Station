import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  hestonCF, hestonCumulants, cosSlice, cosPut, cosCall, cosCallDirect, fellerOK,
} from '../../site/js/heston.js';
import {
  normCdf, blackPrice, bsPrice, impliedVolBlack, impliedVol,
} from '../../site/js/impliedvol.js';
import { ivSurface, MIN_PRICE } from '../../site/js/surface.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/heston_reference.json', import.meta.url)));
const { S0, r, q } = fx;

function close(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: got ${actual}, want ${expected} (|diff| ${Math.abs(actual - expected)} > ${tol})`);
}

test('normCdf matches scipy ndtr', () => {
  for (const { x, cdf } of fx.normcdf) {
    // absolute accuracy everywhere, relative accuracy in the lower tail
    close(normCdf(x), cdf, 2e-15, `normCdf(${x})`);
    if (cdf > 1e-300) assert.ok(Math.abs(normCdf(x) / cdf - 1) < 2e-13, `relative normCdf(${x})`);
  }
});

test('Black prices match scipy reference', () => {
  for (const c of fx.black) {
    close(blackPrice(true, c.F, c.K, c.T, c.sigma), c.call, 1e-12 * c.F, `black ${JSON.stringify(c)}`);
  }
});

test('characteristic function basics', () => {
  for (const p of Object.values(fx.params)) {
    for (const T of [1 / 52, 1, 2]) {
      const z = hestonCF(0, T, p, r, q);
      close(z[0], 1, 1e-15, 'phi(0) re');
      close(z[1], 0, 1e-15, 'phi(0) im');
      for (const u of [0.5, 3, 20, 200]) {
        const w = hestonCF(u, T, p, r, q);
        assert.ok(Math.hypot(w[0], w[1]) <= 1 + 1e-12, '|phi(u)| <= 1');
      }
    }
  }
});

test('cumulants agree with high-precision CGF derivatives', () => {
  for (const c of fx.cumulants) {
    const got = hestonCumulants(c.T, fx.params[c.set]);
    close(got.c1, c.c1, 1e-14, `c1 ${c.set} T=${c.T}`);
    assert.ok(Math.abs(got.c2 / c.c2 - 1) < 1e-6, `c2 ${c.set} T=${c.T}: ${got.c2} vs ${c.c2}`);
    assert.ok(Math.abs(got.c4 / c.c4 - 1) < 1e-2, `c4 ${c.set} T=${c.T}: ${got.c4} vs ${c.c4}`);
  }
});

test('COS prices match the Lewis-integral reference, including stressed cases', () => {
  const worst = {};
  for (const c of fx.cases) {
    const slice = cosSlice(c.T, fx.params[c.set], { r, q });
    const put = cosPut(slice, S0, c.K);
    const call = cosCall(slice, S0, c.K);
    // 1e-10 of spot; the reference itself is good to ~1e-13 of spot
    close(put, c.put, 1e-10 * S0, `put ${c.set} T=${c.T} K=${c.K}`);
    close(call, c.call, 1e-10 * S0, `call ${c.set} T=${c.T} K=${c.K}`);
    worst[c.set] = Math.max(worst[c.set] ?? 0, Math.abs(put - c.put));
  }
  assert.ok(Object.keys(worst).length >= 7);
});

test('COS implied vols match reference implied vols', () => {
  for (const c of fx.cases) {
    const F = S0 * Math.exp((r - q) * c.T);
    const isCall = c.K >= F;
    const ref = isCall ? c.call : c.put;
    if (ref < 1e-6 * S0) continue; // IV of near-zero prices is not meaningful
    const slice = cosSlice(c.T, fx.params[c.set], { r, q });
    const price = isCall ? cosCall(slice, S0, c.K) : cosPut(slice, S0, c.K);
    const ivRef = impliedVol(isCall, ref, S0, c.K, c.T, r, q);
    const iv = impliedVol(isCall, price, S0, c.K, c.T, r, q);
    close(iv, ivRef, 1e-6, `iv ${c.set} T=${c.T} K=${c.K}`);
  }
});

test('surface IVs near the resolvability floor stay accurate', () => {
  // ivSurface works in forward terms; rebuild each case as (k = ln(K/F), T)
  let n = 0;
  for (const c of fx.cases) {
    const F = S0 * Math.exp((r - q) * c.T);
    const k = Math.log(c.K / F);
    const isCall = k >= 0;
    const refFwd = (isCall ? c.call : c.put) * Math.exp(r * c.T) / F; // undiscounted, per unit forward
    const [[iv]] = ivSurface(fx.params[c.set], [c.T], [[k]]);
    if (refFwd < MIN_PRICE) {
      assert.ok(Number.isNaN(iv) || refFwd > 0.5 * MIN_PRICE, `expected NaN below floor: ${c.set} T=${c.T} k=${k}`);
      continue;
    }
    const ivRef = impliedVolBlack(isCall, refFwd, 1, Math.exp(k), c.T, 1);
    close(iv, ivRef, 2e-4, `surface iv ${c.set} T=${c.T} k=${k} price=${refFwd}`);
    n++;
  }
  assert.ok(n > 200, `checked ${n}`);
});

test('put-call parity holds between independent COS call and put expansions', () => {
  for (const c of fx.cases) {
    const slice = cosSlice(c.T, fx.params[c.set], { r, q });
    const lhs = cosCallDirect(slice, S0, c.K) - cosPut(slice, S0, c.K);
    const rhs = S0 * Math.exp(-q * c.T) - c.K * Math.exp(-r * c.T);
    close(lhs, rhs, 1e-8 * S0, `parity ${c.set} T=${c.T} K=${c.K}`);
  }
});

test('IV solver round-trips Black-Scholes prices', () => {
  let n = 0;
  for (const T of [1 / 365, 1 / 52, 0.25, 1, 5]) {
    for (const sigma of [0.01, 0.05, 0.2, 0.6, 1.5, 3]) {
      for (const z of [-3, -1.5, -0.5, 0, 0.5, 1.5, 3]) {
        const K = 100 * Math.exp(z * sigma * Math.sqrt(T));
        for (const isCall of [true, false]) {
          const price = bsPrice(isCall, 100, K, T, sigma, 0.03, 0.01);
          // skip cases whose time value is too small to carry the vol in double precision
          const otm = bsPrice(!isCall, 100, K, T, sigma, 0.03, 0.01);
          if (Math.min(price, otm) < 1e-8 * 100) continue;
          const iv = impliedVol(isCall, price, 100, K, T, 0.03, 0.01);
          close(iv, sigma, 1e-7 * Math.max(sigma, 1), `round-trip T=${T} sigma=${sigma} z=${z} call=${isCall}`);
          n++;
        }
      }
    }
  }
  assert.ok(n > 300);
});

test('IV solver rejects arbitrage-violating prices', () => {
  assert.ok(Number.isNaN(impliedVolBlack(true, 0.5, 100, 99, 1)));   // below intrinsic
  assert.ok(Number.isNaN(impliedVolBlack(true, 100, 100, 99, 1)));   // at the upper bound
  assert.ok(Number.isNaN(impliedVolBlack(false, -1, 100, 99, 1)));
});

test('near-zero vol-of-vol: ATM implied variance approaches the expected average variance', () => {
  const p = { v0: 0.02, kappa: 3, theta: 0.06, xi: 0.005, rho: -0.5 };
  for (const T of [1 / 12, 0.5, 2]) {
    const [[iv]] = ivSurface(p, [T], [[0]]);
    const avgVar = p.theta + (p.v0 - p.theta) * (1 - Math.exp(-p.kappa * T)) / (p.kappa * T);
    close(iv, Math.sqrt(avgVar), 1e-4, `T=${T}`);
  }
});

test('surface: negative rho gives a downward skew; NaN only where prices underflow', () => {
  const p = fx.params.fitted_today;
  const Ts = [1 / 12, 1];
  const ks = Ts.map((T) => [-0.2, -0.1, 0, 0.1, 0.2].map((x) => x * Math.sqrt(T)));
  const iv = ivSurface(p, Ts, ks);
  for (const row of iv) {
    assert.ok(row.every(Number.isFinite));
    for (let i = 1; i < row.length; i++) assert.ok(row[i] < row[i - 1], 'skew should slope down');
  }
});

test('Feller condition', () => {
  assert.equal(fellerOK({ kappa: 2, theta: 0.04, xi: 0.3 }), true);
  assert.equal(fellerOK({ kappa: 1.5, theta: 0.04, xi: 1.5 }), false);
});
