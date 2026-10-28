import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expectedAvgVariance, modelVix, surfaceGrid, SURFACE_TS, SURFACE_Z, halfLifeDays } from '../../site/js/termstructure.js';

test('expected average variance limits match the calibration formula', () => {
  const p = { v0: 0.02, kappa: 3, theta: 0.06 };
  assert.ok(Math.abs(expectedAvgVariance(1e-9, p) - 0.02) < 1e-10);
  assert.ok(Math.abs(expectedAvgVariance(1e4, p) - 0.06) < 1e-5);
  const T = 0.25, x = p.kappa * T;
  const direct = p.theta + (p.v0 - p.theta) * (1 - Math.exp(-x)) / x;
  assert.ok(Math.abs(expectedAvgVariance(T, p) - direct) < 1e-15);
  assert.ok(Math.abs(modelVix(T, p) - 100 * Math.sqrt(direct)) < 1e-12);
});

test('surface grid spans the requested standard deviations per maturity', () => {
  const p = { v0: 0.0262, kappa: 2.84, theta: 0.0686 };
  const { Ts, zs, ks } = surfaceGrid(p);
  assert.equal(Ts, SURFACE_TS);
  assert.equal(zs, SURFACE_Z);
  assert.equal(ks.length, Ts.length);
  Ts.forEach((T, i) => {
    const sd = Math.sqrt(expectedAvgVariance(T, p)) * Math.sqrt(T);
    assert.ok(Math.abs(ks[i][0] - zs[0] * sd) < 1e-12);
    assert.ok(ks[i].every((k, j) => j === 0 || k > ks[i][j - 1]));
  });
});

test('half-life', () => {
  assert.ok(Math.abs(halfLifeDays(Math.LN2) - 365) < 1e-9);
});
