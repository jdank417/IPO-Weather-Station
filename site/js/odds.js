// Market-implied S&P 500 odds under the daily-calibrated Heston model.
// All probabilities are risk-neutral: what option prices imply, not a forecast.

import { cosSlice, cosCdf } from './heston.js';

/** Build a reusable odds object for one horizon T (years). */
export function horizon(params, T, { r = 0, q = 0, N } = {}) {
  const slice = cosSlice(T, params, { r, q, ...(N ? { N } : {}) });
  return {
    T,
    /** P(S_T <= ratio * S_0). */
    below: (ratio) => cosCdf(slice, Math.log(ratio)),
    /** P(S_T >= ratio * S_0). */
    above: (ratio) => 1 - cosCdf(slice, Math.log(ratio)),
    /** ratio S_T/S_0 with P(S_T/S_0 <= ratio) = p, by bisection on the CDF. */
    quantile(p, tol = 1e-7) {
      let lo = slice.a, hi = slice.b;
      for (let i = 0; i < 80 && hi - lo > tol; i++) {
        const mid = 0.5 * (lo + hi);
        if (cosCdf(slice, mid) < p) lo = mid; else hi = mid;
      }
      return Math.exp(0.5 * (lo + hi));
    },
  };
}

export const FAN_PROBS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Quantile fan: for each horizon, S_T/S_0 at FAN_PROBS. */
export function fan(params, Ts, opts = {}) {
  return Ts.map((T) => {
    const h = horizon(params, T, { N: 1024, ...opts });
    return { T, q: FAN_PROBS.map((p) => h.quantile(p)) };
  });
}

/** "1 in N" phrasing for a probability. */
export function oneIn(p) {
  if (!(p > 0)) return 'less than 1 in 10,000';
  if (p >= 0.5) return `${Math.round(100 * p)} in 100`;
  const n = 1 / p;
  if (n > 10000) return 'less than 1 in 10,000';
  const nice = n < 20 ? Math.round(n) : n < 100 ? Math.round(n / 5) * 5 : n < 1000 ? Math.round(n / 50) * 50 : Math.round(n / 500) * 500;
  return `about 1 in ${nice.toLocaleString('en-US')}`;
}
