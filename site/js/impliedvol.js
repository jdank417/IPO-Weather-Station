// Black-Scholes (forward form) and an implied-volatility solver:
// Newton-Raphson on sigma, falling back to bisection when vega is tiny or
// Newton leaves the bracket.

const SQRT_2PI = 2.5066282746310002;

/**
 * Standard normal CDF, double precision. |x| <= 4: Hart (1968) rational
 * approximation as given by West (2005). |x| > 4: Laplace continued fraction
 * Q(x) = pdf(x) / (x + 1/(x + 2/(x + 3/(x + ...)))), evaluated backward, which
 * keeps full relative accuracy in the tails.
 */
export function normCdf(x) {
  const ax = Math.abs(x);
  let c;
  if (ax > 38) {
    c = 0;
  } else if (ax > 4) {
    let f = ax;
    for (let n = 120; n >= 1; n--) f = ax + n / f;
    c = Math.exp(-0.5 * ax * ax) / SQRT_2PI / f;
  } else {
    const ex = Math.exp(-0.5 * ax * ax);
    let n = 3.52624965998911e-2 * ax + 0.700383064443688;
    n = n * ax + 6.37396220353165;
    n = n * ax + 33.912866078383;
    n = n * ax + 112.079291497871;
    n = n * ax + 221.213596169931;
    n = n * ax + 220.206867912376;
    let d = 8.83883476483184e-2 * ax + 1.75566716318264;
    d = d * ax + 16.064177579207;
    d = d * ax + 86.7807322029461;
    d = d * ax + 296.564248779674;
    d = d * ax + 637.333633378831;
    d = d * ax + 793.826512519948;
    d = d * ax + 440.413735824752;
    c = ex * n / d;
  }
  return x > 0 ? 1 - c : c;
}

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Black (forward) price; df = discount factor exp(-rT). */
export function blackPrice(isCall, F, K, T, sigma, df = 1) {
  if (sigma <= 0 || T <= 0) {
    return df * Math.max(isCall ? F - K : K - F, 0);
  }
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sT * sT) / sT;
  const d2 = d1 - sT;
  return isCall
    ? df * (F * normCdf(d1) - K * normCdf(d2))
    : df * (K * normCdf(-d2) - F * normCdf(-d1));
}

export function blackVega(F, K, T, sigma, df = 1) {
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sT * sT) / sT;
  return df * F * normPdf(d1) * Math.sqrt(T);
}

/** Black-Scholes with spot, rate and dividend yield. */
export function bsPrice(isCall, S0, K, T, sigma, r = 0, q = 0) {
  return blackPrice(isCall, S0 * Math.exp((r - q) * T), K, T, sigma, Math.exp(-r * T));
}

export const IV_LO = 1e-4;
export const IV_HI = 5.0;

/**
 * Implied volatility from a Black (forward) price. Returns NaN when the price
 * lies outside the no-arbitrage bounds or below what double precision resolves.
 */
export function impliedVolBlack(isCall, price, F, K, T, df = 1, { tol = 1e-12, maxIter = 100 } = {}) {
  const intrinsic = df * Math.max(isCall ? F - K : K - F, 0);
  const upper = df * (isCall ? F : K);
  if (!(price > intrinsic) || !(price < upper) || !(T > 0)) return NaN;
  // Invert the out-of-the-money twin: an in-the-money price is mostly intrinsic
  // value, which hides the volatility information in rounding.
  if (intrinsic > 0) {
    price -= df * (isCall ? F - K : K - F);
    isCall = !isCall;
  }

  let lo = IV_LO, hi = IV_HI;
  const f = (s) => blackPrice(isCall, F, K, T, s, df) - price;
  if (f(lo) > 0 || f(hi) < 0) return NaN;

  // Brenner-Subrahmanyam-style start, kept inside the bracket
  let s = Math.sqrt(2 * Math.abs(Math.log(F / K)) / T) || Math.sqrt(2 * Math.PI / T) * price / (df * F);
  if (!(s > lo && s < hi)) s = 0.5 * (lo + hi);

  for (let i = 0; i < maxIter; i++) {
    const diff = f(s);
    if (Math.abs(diff) <= tol * Math.max(price, 1e-300)) return s;
    if (diff > 0) hi = s; else lo = s;
    const vega = blackVega(F, K, T, s, df);
    let next = s - diff / vega;
    // fall back to bisection when vega is tiny or Newton leaves the bracket
    if (!(vega > 1e-12 * df * F) || !(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - s) < 1e-15 * s) return next;
    s = next;
  }
  return s;
}

export function impliedVol(isCall, price, S0, K, T, r = 0, q = 0, opts) {
  return impliedVolBlack(isCall, price, S0 * Math.exp((r - q) * T), K, T, Math.exp(-r * T), opts);
}
