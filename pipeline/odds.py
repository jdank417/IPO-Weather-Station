"""Risk-neutral S&P 500 odds under Heston (numpy mirror of site/js/heston.js).

P(S_T / S_0 <= x) comes from the COS expansion of the density of
Y = ln(S_T / S_0) (Fang & Oosterlee 2008) with the characteristic function in
the "little Heston trap" form. Used to precompute the daily odds timeline for
the replay tab; the browser computes everything else live.
"""

from __future__ import annotations

import math

import numpy as np

COS_N = 2048
COS_L = 12.0


def heston_cf(u, T, v0, kappa, theta, xi, rho, r=0.0, q=0.0):
    """E[exp(i u Y)], Y = ln(S_T/S_0); u may be complex."""
    u = np.asarray(u, dtype=complex)
    iu = 1j * u
    beta = kappa - rho * xi * iu
    d = np.sqrt(beta * beta + xi * xi * (u * u + iu))
    g = (beta - d) / (beta + d)
    e = np.exp(-d * T)
    C = (r - q) * iu * T + kappa * theta / xi**2 * ((beta - d) * T - 2.0 * np.log((1 - g * e) / (1 - g)))
    D = (beta - d) / xi**2 * (1 - e) / (1 - g * e)
    return np.exp(C + D * v0)


def cumulants(T, v0, kappa, theta, xi, rho, r=0.0, q=0.0):
    """c1 closed form; c2, c4 from Richardson differences of ln|phi| (as in heston.js)."""
    e = math.exp(-kappa * T)
    int_var = theta * T + (v0 - theta) * (1 - e) / kappa
    c1 = (r - q) * T - 0.5 * int_var
    h = 0.002 / math.sqrt(max(int_var, 1e-10))
    R1, R2 = (float(np.log(np.abs(heston_cf(x, T, v0, kappa, theta, xi, rho)))) for x in (h, 2 * h))
    c2 = -(16 * R1 - R2) / (6 * h * h)
    c4 = 2 * (R2 - 4 * R1) / h**4
    return c1, c2, c4


def cos_cdf(x, T, v0, kappa, theta, xi, rho, r=0.0, q=0.0, N=COS_N, L=COS_L):
    """P(ln(S_T/S_0) <= x) for scalar or array x."""
    c1, c2, c4 = cumulants(T, v0, kappa, theta, xi, rho, r, q)
    w = L * math.sqrt(max(c2, 1e-10) + math.sqrt(max(c4, 0.0)))
    a, b = c1 - w, c1 + w
    k = np.arange(N)
    u = k * math.pi / (b - a)
    phi = heston_cf(u, T, v0, kappa, theta, xi, rho, r, q) * np.exp(-1j * u * a)
    re = phi.real.copy()
    re[0] *= 0.5
    x = np.clip(np.atleast_1d(np.asarray(x, float)), a, b)
    # density coefficients F_k = 2/(b-a) Re(...); CDF = sum F_k * int_a^x cos(u_k (y - a)) dy
    integ = np.where(k[None, :] == 0, (x - a)[:, None],
                     np.sin(u[None, :] * (x - a)[:, None]) / np.where(k == 0, 1.0, u)[None, :])
    cdf = (2.0 / (b - a)) * integ @ re
    return np.clip(cdf, 0.0, 1.0)


def prob_below(level_ratio, T, params, r=0.0, q=0.0):
    """P(S_T/S_0 <= level_ratio)."""
    return float(cos_cdf(math.log(level_ratio), T, *params, r=r, q=q)[0])
