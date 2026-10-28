import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { filter, step, steadyState, predict, buildGauge, modelFromParams, designRow, logistic } from '../../site/js/regime.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/regime_reference.json', import.meta.url)));
const site = JSON.parse(fs.readFileSync(new URL('../../site/data/regime.json', import.meta.url)));

test('Hamilton filter reproduces statsmodels filtered probabilities and log-likelihood', () => {
  const model = modelFromParams(fx.params);
  const X = fx.z.map((z) => [1, ...z]);
  const { pHot, loglik } = filter(model, fx.y, X);
  assert.equal(pHot.length, fx.statsmodels_filtered_p_hot.length);
  pHot.forEach((p, t) => assert.ok(Math.abs(p - fx.statsmodels_filtered_p_hot[t]) < 1e-8, `t=${t}: ${p} vs ${fx.statsmodels_filtered_p_hot[t]}`));
  assert.ok(Math.abs(loglik - fx.statsmodels_llf) < 1e-6, `loglik ${loglik} vs ${fx.statsmodels_llf}`);
});

test('steady state is invariant under one step', () => {
  const model = modelFromParams(fx.params);
  for (const x of [[1, 0, 0, 0], [1, 1.5, -0.5, 2]]) {
    const p = steadyState(model, x);
    const q = step(p, model, x);
    assert.ok(Math.abs(p[1] - q[1]) < 1e-14);
    assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-14);
  }
});

test('prediction without observations converges to the steady state', () => {
  const model = modelFromParams(fx.params);
  const x = [1, 0.3, -0.2, 0.1];
  const p = predict([1, 0], model, Array(500).fill(x));
  assert.ok(Math.abs(p[1] - steadyState(model, x)[1]) < 1e-9);
});

test('site gauge: point estimate, band and monotone response to a covariate', () => {
  const g = buildGauge(site);
  const base = site.forward.x[site.forward.x.length - 1];
  const r = g.probability(base);
  assert.ok(r.p > 0 && r.p < 1);
  assert.ok(r.lo <= r.median && r.median <= r.hi);
  // the response to one covariate follows the sign of its coefficient, averaged over the current state
  const k = 1; // vol1y
  const up = [...base]; up[k - 1] += site.covariates[k - 1].sd;
  const pCur = g.pHotCurrent;
  const gc = site.params.gamma.cold[k], gh = site.params.gamma.hot[k];
  const expectedSign = Math.sign((1 - pCur) * gc * 0.25 + pCur * gh * 0.25);
  const moved = g.probability(up).p - r.p;
  assert.equal(Math.sign(moved), expectedSign);
});

test('design row standardization', () => {
  const cov = [{ mean: 10, sd: 2 }, { mean: 0, sd: 1 }];
  assert.deepEqual(designRow([12, -1], cov), [1, 1, -1]);
  assert.equal(logistic(0), 0.5);
});
