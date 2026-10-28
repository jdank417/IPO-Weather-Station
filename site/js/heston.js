// Heston characteristic function ("little Heston trap", Albrecher et al. 2007)
// and European option pricing with the COS method (Fang & Oosterlee 2008).
//
// Conventions: Y = ln(S_T / S_0), forward F = S_0 exp((r - q) T), discount
// exp(-r T). Complex numbers are handled as [re, im] pairs inline for speed.

export const COS_N = 2048;  // number of cosine terms (see docs/pricing.rst for the accuracy sweep)
export const COS_L = 12;    // truncation width in standard deviations (F&O suggest 10-12 for Heston)

/**
 * Characteristic function E[exp(i u Y)] of Y = ln(S_T/S_0) under Heston.
 * Writes the complex result into out[0], out[1] and returns out.
 */
export function hestonCF(u, T, p, r = 0, q = 0, out = [0, 0]) {
  const { v0, kappa, theta, xi, rho } = p;
  const xi2 = xi * xi;

  // beta = kappa - rho*xi*i*u
  const bRe = kappa, bIm = -rho * xi * u;
  // d^2 = beta^2 + xi^2 (u^2 + i u)
  const d2Re = bRe * bRe - bIm * bIm + xi2 * u * u;
  const d2Im = 2 * bRe * bIm + xi2 * u;
  // principal square root (Re d >= 0)
  const mod = Math.hypot(d2Re, d2Im);
  let dRe = Math.sqrt(0.5 * (mod + d2Re));
  let dIm = Math.sqrt(Math.max(0, 0.5 * (mod - d2Re)));
  if (d2Im < 0) dIm = -dIm;

  // g = (beta - d) / (beta + d)
  const nRe = bRe - dRe, nIm = bIm - dIm;
  const pRe = bRe + dRe, pIm = bIm + dIm;
  const pDen = pRe * pRe + pIm * pIm;
  const gRe = (nRe * pRe + nIm * pIm) / pDen;
  const gIm = (nIm * pRe - nRe * pIm) / pDen;

  // e = exp(-d T)
  const eMag = Math.exp(-dRe * T);
  const eRe = eMag * Math.cos(-dIm * T), eIm = eMag * Math.sin(-dIm * T);

  // 1 - g e
  const ogeRe = 1 - (gRe * eRe - gIm * eIm);
  const ogeIm = -(gRe * eIm + gIm * eRe);
  // 1 - g
  const ogRe = 1 - gRe, ogIm = -gIm;

  // log((1 - g e) / (1 - g)) = log(1 - g e) - log(1 - g); in the trap form
  // |g| <= 1 and |e| <= 1 keep both arguments off the negative real axis.
  const lRe = Math.log(Math.hypot(ogeRe, ogeIm)) - Math.log(Math.hypot(ogRe, ogIm));
  const lIm = Math.atan2(ogeIm, ogeRe) - Math.atan2(ogIm, ogRe);

  // C = (r - q) i u T + kappa theta / xi^2 [ (beta - d) T - 2 log(...) ]
  const k = kappa * theta / xi2;
  const CRe = k * (nRe * T - 2 * lRe);
  const CIm = (r - q) * u * T + k * (nIm * T - 2 * lIm);

  // D = (beta - d) / xi^2 * (1 - e) / (1 - g e)
  const omeRe = 1 - eRe, omeIm = -eIm;
  const fDen = ogeRe * ogeRe + ogeIm * ogeIm;
  const fRe = (omeRe * ogeRe + omeIm * ogeIm) / fDen;
  const fIm = (omeIm * ogeRe - omeRe * ogeIm) / fDen;
  const DRe = (nRe * fRe - nIm * fIm) / xi2;
  const DIm = (nRe * fIm + nIm * fRe) / xi2;

  const zRe = CRe + DRe * v0, zIm = CIm + DIm * v0;
  const m = Math.exp(zRe);
  out[0] = m * Math.cos(zIm);
  out[1] = m * Math.sin(zIm);
  return out;
}

/**
 * Cumulants c1, c2, c4 of Y = ln(S_T/S_0).
 *
 * c1 is closed form. c2 and c4 come from the CF itself: with
 * R(u) = ln|phi(u)| = -c2 u^2/2 + c4 u^4/24 - ..., Richardson differences at
 * u = h, 2h give c2 and c4 to O(h^4). (The closed-form c2 printed in Fang &
 * Oosterlee 2008 is not reliable as commonly transcribed: it can go negative.)
 */
export function hestonCumulants(T, p, r = 0, q = 0) {
  const { v0, kappa, theta } = p;
  const e = Math.exp(-kappa * T);
  // E[int_0^T v dt]
  const intVar = theta * T + (v0 - theta) * (1 - e) / kappa;
  const c1 = (r - q) * T - 0.5 * intVar;

  // h is scaled by the integrated variance (c2 h^2 ~ 4e-6): small enough that the
  // O(h^4) truncation is negligible, large enough that round-off is too
  // (checked against mpmath cumulants in tests/js/pricing.test.js)
  const h = 0.002 / Math.sqrt(Math.max(intVar, 1e-10));
  const z = [0, 0];
  const R = (u) => { hestonCF(u, T, p, 0, 0, z); return Math.log(Math.hypot(z[0], z[1])); };
  const R1 = R(h), R2 = R(2 * h);
  const c2 = -(16 * R1 - R2) / (6 * h * h);
  const c4 = 2 * (R2 - 4 * R1) / (h ** 4);
  return { c1, c2, c4 };
}

/** COS truncation interval [a, b] for Y: c1 +/- L sqrt(c2 + sqrt(c4)). */
export function cosInterval(T, p, r = 0, q = 0, L = COS_L) {
  const { c1, c2, c4 } = hestonCumulants(T, p, r, q);
  const w = L * Math.sqrt(Math.max(c2, 1e-10) + Math.sqrt(Math.max(c4, 0)));
  return [c1 - w, c1 + w];
}

/**
 * Prepare a maturity slice: the CF evaluated at the COS frequencies, shifted by a.
 * Reusing a slice across strikes makes a strike grid nearly free.
 */
export function cosSlice(T, p, { r = 0, q = 0, N = COS_N, L = COS_L } = {}) {
  const [a, b] = cosInterval(T, p, r, q, L);
  const re = new Float64Array(N), im = new Float64Array(N);
  const tmp = [0, 0];
  const w = Math.PI / (b - a);
  for (let k = 0; k < N; k++) {
    const u = k * w;
    hestonCF(u, T, p, r, q, tmp);
    // phi(u) * exp(-i u a)
    const c = Math.cos(u * a), s = Math.sin(u * a);
    re[k] = tmp[0] * c + tmp[1] * s;
    im[k] = tmp[1] * c - tmp[0] * s;
  }
  re[0] *= 0.5; // first term of the COS sum has weight 1/2
  im[0] *= 0.5;
  return { T, a, b, N, r, q, re, im };
}

/**
 * European put on the slice by COS. Calls come from put-call parity: the put
 * payoff is bounded, which makes the cosine expansion far less sensitive to the
 * truncation range (Fang & Oosterlee 2008, Sec. 5.1).
 */
export function cosPut(slice, S0, K) {
  const { T, a, b, N, r, q, re } = slice;
  const kk = Math.log(K / S0);   // put pays when Y < kk
  const d = Math.min(kk, b);
  if (d <= a) return 0;          // strike below the truncation range: put is ~0
  const bma = b - a;
  const ed = Math.exp(d), ea = Math.exp(a);
  const eNegK = Math.exp(-kk);
  // cos/sin(k * phi) by angle addition instead of calling trig N times
  const phi = Math.PI * (d - a) / bma;
  const c1 = Math.cos(phi), s1 = Math.sin(phi);
  let cd = 1, sd = 0;
  let sum = re[0] * ((d - a) - eNegK * (ed - ea));
  for (let k = 1; k < N; k++) {
    const t = cd * c1 - sd * s1;
    sd = sd * c1 + cd * s1;
    cd = t;
    const w = k * Math.PI / bma;
    // chi_k(a, d) = int_a^d e^y cos(w (y - a)) dy;  psi_k(a, d) = int_a^d cos(w (y - a)) dy
    const chi = (cd * ed - ea + w * sd * ed) / (1 + w * w);
    const psi = sd / w;
    sum += re[k] * (psi - eNegK * chi);
  }
  // V_k = 2/(b-a) * K * (psi - e^{-kk} chi); price = e^{-rT} sum Re(...) V_k
  const price = Math.exp(-r * T) * K * (2 / bma) * sum;
  return Math.max(price, 0);
}

/**
 * European call priced directly from the call payoff's cosine coefficients.
 * Less robust to truncation than cosPut + parity; kept for verification.
 */
export function cosCallDirect(slice, S0, K) {
  const { T, a, b, N, r, re } = slice;
  const kk = Math.log(K / S0);   // call pays when Y > kk
  const c = Math.max(kk, a);
  if (c >= b) return 0;
  const bma = b - a;
  const eb = Math.exp(b), ec = Math.exp(c);
  const eNegK = Math.exp(-kk);
  let sum = 0;
  for (let k = 0; k < N; k++) {
    const w = k * Math.PI / bma;
    const cb = Math.cos(w * bma), sb = Math.sin(w * bma);
    const cc = Math.cos(w * (c - a)), sc = Math.sin(w * (c - a));
    const chi = (cb * eb - cc * ec + w * (sb * eb - sc * ec)) / (1 + w * w);
    const psi = k === 0 ? b - c : (sb - sc) / w;
    sum += re[k] * (eNegK * chi - psi);
  }
  return Math.exp(-r * T) * K * (2 / bma) * sum;
}

export function cosCall(slice, S0, K) {
  const { T, r, q } = slice;
  const put = cosPut(slice, S0, K);
  const call = put + S0 * Math.exp(-q * T) - K * Math.exp(-r * T);
  return Math.max(call, 0);
}

/**
 * P(ln(S_T/S_0) <= x) from the slice: the COS density coefficients integrated
 * from a to x. Uses the same angle-addition recurrence as cosPut.
 */
export function cosCdf(slice, x) {
  const { a, b, N, re } = slice;
  if (x <= a) return 0;
  if (x >= b) return 1;
  const bma = b - a;
  const phi = Math.PI * (x - a) / bma;
  const c1 = Math.cos(phi), s1 = Math.sin(phi);
  let c = 1, s = 0;
  let sum = re[0] * (x - a);
  for (let k = 1; k < N; k++) {
    const t = c * c1 - s * s1;
    s = s * c1 + c * s1;
    c = t;
    sum += re[k] * s * bma / (k * Math.PI);
  }
  return Math.min(1, Math.max(0, (2 / bma) * sum));
}

/** Convenience: single option price. */
export function hestonPrice(isCall, S0, K, T, p, opts = {}) {
  const slice = cosSlice(T, p, opts);
  return isCall ? cosCall(slice, S0, K) : cosPut(slice, S0, K);
}

/** Feller condition 2 kappa theta > xi^2 (variance stays strictly positive). */
export function fellerOK({ kappa, theta, xi }) {
  return 2 * kappa * theta > xi * xi;
}
