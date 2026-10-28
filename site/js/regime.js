// Hamilton filter for the two-regime IPO model with logistic time-varying
// transition probabilities, mirroring pipeline/fit_ipo_regimes.py.
//
// Model: y_t ~ N(mu_{S_t}, sigma^2); P(S_t = hot | S_{t-1} = s) = logistic(gamma_s . x_t)
// where x_t = [1, z_{t-1}] holds last month's standardized covariates.
// Probability vectors are [P(cold), P(hot)].

export const logistic = (v) => 1 / (1 + Math.exp(-v));

const dot = (a, b) => a.reduce((s, ai, i) => s + ai * b[i], 0);

/** One transition step: P(S_t) from P(S_{t-1}) given the design row x = [1, z...]. */
export function step(p, model, x) {
  const a = logistic(dot(model.gammaCold, x));   // P(hot | cold)
  const b = logistic(dot(model.gammaHot, x));    // P(hot | hot)
  const hot = p[0] * a + p[1] * b;
  return [1 - hot, hot];
}

/** Steady state of the transition matrix at design row x (statsmodels' initialization). */
export function steadyState(model, x) {
  const a = logistic(dot(model.gammaCold, x));
  const b = logistic(dot(model.gammaHot, x));
  const toHot = a, toCold = 1 - b;
  return [toCold / (toHot + toCold), toHot / (toHot + toCold)];
}

/**
 * Filter observations y[t] with design rows X[t] (each [1, z...]).
 * Returns filtered P(hot) per month, the log-likelihood and the final state.
 */
export function filter(model, y, X) {
  const { mu, sigma } = model;
  const norm = 1 / (sigma * Math.sqrt(2 * Math.PI));
  let p = steadyState(model, X[0]);
  const pHot = [];
  let loglik = 0;
  for (let t = 0; t < y.length; t++) {
    if (t > 0) p = step(p, model, X[t]);
    const f0 = p[0] * norm * Math.exp(-0.5 * ((y[t] - mu[0]) / sigma) ** 2);
    const f1 = p[1] * norm * Math.exp(-0.5 * ((y[t] - mu[1]) / sigma) ** 2);
    const s = f0 + f1;
    loglik += Math.log(s);
    p = [f0 / s, f1 / s];
    pHot.push(p[1]);
  }
  return { pHot, loglik, last: p };
}

/** Predict forward through design rows with no observations. */
export function predict(p, model, rows) {
  for (const x of rows) p = step(p, model, x);
  return p;
}

/** Standardize raw covariates with the exported means and sds, prefixed by the constant. */
export function designRow(raw, covariates) {
  return [1, ...covariates.map((c, i) => (raw[i] - c.mean) / c.sd)];
}

export function modelFromParams(params) {
  return {
    mu: [params.mu.cold, params.mu.hot],
    sigma: params.sigma,
    gammaCold: params.gamma.cold,
    gammaHot: params.gamma.hot,
  };
}

export function modelFromDraw(d) {
  return { mu: d.mu, sigma: d.sigma, gammaCold: d.gamma_cold, gammaHot: d.gamma_hot };
}

/**
 * Build a gauge from regime.json. Everything up to the current month is
 * filtered once (per parameter draw); only the final transition depends on
 * the what-if covariates, so `probability(raw)` is cheap enough per slider move.
 *
 * Timeline: history ends at the last Ritter month T. forward.months[0] = T and
 * forward.x[i] are monthly covariates; the transition into month i+1 uses
 * forward.x[i]. The last forward month is the current (partial) month, whose
 * covariates are replaced by the what-if values to predict next month.
 */
export function buildGauge(data) {
  const { covariates, history, forward } = data;
  const Xhist = history.z.map((z) => [1, ...z]);
  const rowsBeforeCurrent = forward.x.slice(0, -1).map((raw) => designRow(raw, covariates));

  const prepare = (model) => {
    const { last } = filter(model, history.y, Xhist);
    return { model, pCurrent: predict(last, model, rowsBeforeCurrent) };
  };
  const point = prepare(modelFromParams(data.params));
  const draws = (data.draws || []).map((d) => prepare(modelFromDraw(d)));

  return {
    currentMonth: forward.months[forward.months.length - 1],
    pHotCurrent: point.pCurrent[1],
    /** P(next month is hot) for raw covariate values, with a 90% band over parameter draws. */
    probability(raw) {
      const x = designRow(raw, covariates);
      const p = step(point.pCurrent, point.model, x)[1];
      if (!draws.length) return { p, lo: NaN, hi: NaN };
      const ps = draws.map((d) => step(d.pCurrent, d.model, x)[1]).sort((a, b) => a - b);
      const q = (f) => ps[Math.min(ps.length - 1, Math.max(0, Math.round(f * (ps.length - 1))))];
      return { p, lo: q(0.05), hi: q(0.95), median: q(0.5) };
    },
  };
}
