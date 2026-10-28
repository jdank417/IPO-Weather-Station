// Term-structure helpers shared by the UI and tests: the Heston expected
// average variance (the calibration formula) and the surface grid.

/** E[avg variance over [0,T]] = theta + (v0 - theta)(1 - e^{-kT})/(kT). */
export function expectedAvgVariance(T, { v0, kappa, theta }) {
  const x = kappa * T;
  const w = x < 1e-6 ? 1 - x / 2 + (x * x) / 6 : -Math.expm1(-x) / x;
  return theta + (v0 - theta) * w;
}

/** Model VIX-style level (vol points) at horizon T years. */
export function modelVix(T, p) {
  return 100 * Math.sqrt(expectedAvgVariance(T, p));
}

export const SURFACE_TS = [1 / 52, 2 / 52, 1 / 12, 2 / 12, 3 / 12, 6 / 12, 9 / 12, 1, 1.5, 2];
// strikes in standard deviations of ln(S_T/F): from 2.5 below to 2 above
export const SURFACE_Z = Array.from({ length: 19 }, (_, i) => -2.5 + i * 0.25);

/**
 * Log-moneyness grid ln(K/F) per maturity, spanning SURFACE_Z standard
 * deviations at the reference vol for that maturity. Using a fixed reference
 * (today's fit) keeps the axes still while sliders move the surface.
 */
export function surfaceGrid(refParams, Ts = SURFACE_TS, zs = SURFACE_Z) {
  const ks = Ts.map((T) => {
    const sd = Math.max(Math.sqrt(expectedAvgVariance(T, refParams)), 0.08) * Math.sqrt(T);
    return zs.map((z) => z * sd);
  });
  return { Ts, zs, ks };
}

export const volToVar = (vol) => vol * vol;
export const varToVol = (v) => Math.sqrt(v);
export const halfLifeDays = (kappa) => (Math.LN2 / kappa) * 365;
