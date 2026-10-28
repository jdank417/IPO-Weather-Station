// Implied-volatility surface on a (maturity x log-moneyness) grid.
// Pure function shared by the Web Worker and the tests.

import { cosSlice, cosPut, cosCall } from './heston.js';
import { impliedVolBlack } from './impliedvol.js';

// Out-of-the-money prices below this fraction of the forward are not resolved
// reliably by the COS sum (absolute error ~1e-13); their implied vols are NaN.
export const MIN_PRICE = 1e-9;

/**
 * @param {object} p        Heston params {v0, kappa, theta, xi, rho}
 * @param {number[]} Ts     maturities in years
 * @param {number[][]} ks   per maturity, log-moneyness ln(K/F) values
 * @returns {number[][]}    implied vols (NaN where the price is not resolvable)
 *
 * Works in forward terms (S0 = F = 1, r = q = 0): Heston implied vols depend
 * only on ln(K/F) and T when rates are deterministic. Uses the out-of-the-money
 * option at each strike, which is better conditioned for inversion.
 */
export function ivSurface(p, Ts, ks, opts = {}) {
  return Ts.map((T, i) => {
    const slice = cosSlice(T, p, opts);
    return ks[i].map((k) => {
      const K = Math.exp(k);
      const isCall = k >= 0;
      const price = isCall ? cosCall(slice, 1, K) : cosPut(slice, 1, K);
      if (!(price >= MIN_PRICE)) return NaN;
      return impliedVolBlack(isCall, price, 1, K, T, 1);
    });
  });
}
