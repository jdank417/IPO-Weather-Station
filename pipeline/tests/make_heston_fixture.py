"""Generate the JS pricer's reference fixture by direct numerical integration.

Independent of the COS method: prices come from the Lewis (2001) single-integral
formula evaluated with adaptive quadrature (scipy.integrate.quad),

    C = S0 e^{-qT} - sqrt(F K) e^{-rT} / pi * int_0^inf Re[e^{i u k} phi(u - i/2)] / (u^2 + 1/4) du,

with k = ln(F/K) and phi the CF of ln(S_T/F). The CF is written separately from
site/js/heston.js using numpy complex arithmetic, and is checked against Heston's
original (1993) form at short maturities, where that form has no branch issues.

    python -m pipeline.tests.make_heston_fixture
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import mpmath as mp
import numpy as np
from scipy.integrate import quad
from scipy.special import ndtr

OUT = Path(__file__).resolve().parents[2] / "tests" / "js" / "fixtures" / "heston_reference.json"


def cf_trap(u, T, v0, kappa, theta, xi, rho):
    """CF of ln(S_T/F) (zero drift), Albrecher et al. 'little trap' form."""
    u = np.asarray(u, dtype=complex)
    iu = 1j * u
    beta = kappa - rho * xi * iu
    d = np.sqrt(beta * beta + xi * xi * (u * u + iu))
    g = (beta - d) / (beta + d)
    e = np.exp(-d * T)
    C = kappa * theta / xi**2 * ((beta - d) * T - 2.0 * np.log((1 - g * e) / (1 - g)))
    D = (beta - d) / xi**2 * (1 - e) / (1 - g * e)
    return np.exp(C + D * v0)


def cf_original(u, T, v0, kappa, theta, xi, rho):
    """Heston (1993) original form, for cross-checking at short T only."""
    u = np.asarray(u, dtype=complex)
    iu = 1j * u
    beta = kappa - rho * xi * iu
    d = np.sqrt(beta * beta + xi * xi * (u * u + iu))
    G = (beta + d) / (beta - d)
    e = np.exp(d * T)
    C = kappa * theta / xi**2 * ((beta + d) * T - 2.0 * np.log((1 - G * e) / (1 - G)))
    D = (beta + d) / xi**2 * (1 - e) / (1 - G * e)
    return np.exp(C + D * v0)


def lewis_call(S0, K, T, params, r=0.0, q=0.0):
    F = S0 * math.exp((r - q) * T)
    k = math.log(F / K)

    def integrand(u):
        z = cf_trap(u - 0.5j, T, *params)
        return float((np.exp(1j * u * k) * z).real / (u * u + 0.25))

    total, err = 0.0, 0.0
    # integrate on [0, 50], then [50, inf): oscillation is concentrated early
    for lo, hi in ((0.0, 50.0), (50.0, np.inf)):
        val, e = quad(integrand, lo, hi, limit=2000, epsabs=1e-14, epsrel=1e-12)
        total += val
        err += e
    call = S0 * math.exp(-q * T) - math.sqrt(F * K) * math.exp(-r * T) / math.pi * total
    return call, err


def exact_cumulants(T, v0, kappa, theta, xi, rho):
    """c1, c2, c4 of ln(S_T/S_0) (r = q = 0) by high-precision differentiation of the CGF."""
    mp.mp.dps = 40

    def cgf(s):
        u = mp.mpc(0, -s)  # phi(-i s) = E[exp(s Y)]
        iu = 1j * u
        beta = kappa - rho * xi * iu
        d = mp.sqrt(beta**2 + xi**2 * (u * u + iu))
        g = (beta - d) / (beta + d)
        e = mp.exp(-d * T)
        C = kappa * theta / xi**2 * ((beta - d) * T - 2 * mp.log((1 - g * e) / (1 - g)))
        D = (beta - d) / xi**2 * (1 - e) / (1 - g * e)
        return mp.re(C + D * v0)

    return [float(mp.diff(cgf, 0, n)) for n in (1, 2, 4)]


def black_call(F, K, T, sigma, df=1.0):
    sT = sigma * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * sT * sT) / sT
    return df * (F * ndtr(d1) - K * ndtr(d1 - sT))


PARAM_SETS = {
    "base": dict(v0=0.04, kappa=2.0, theta=0.04, xi=0.5, rho=-0.7),
    "fitted_today": dict(v0=0.0262, kappa=2.84, theta=0.0686, xi=0.6, rho=-0.7),
    "high_xi": dict(v0=0.04, kappa=1.5, theta=0.04, xi=1.5, rho=-0.7),
    "rho_minus_0_9": dict(v0=0.09, kappa=3.0, theta=0.05, xi=1.0, rho=-0.9),
    "stress_backwardation": dict(v0=0.36, kappa=6.0, theta=0.06, xi=1.2, rho=-0.85),
    "low_vol_pos_rho": dict(v0=0.01, kappa=1.0, theta=0.02, xi=0.3, rho=0.3),
    "slow_kappa": dict(v0=0.03, kappa=0.2, theta=0.08, xi=0.4, rho=-0.5),
}
MATURITIES = [1 / 52, 1 / 12, 0.25, 1.0, 2.0]
# strikes as standardized log-moneyness ln(K/F) / sqrt(T * sigma_ref^2), sigma_ref = 0.25
Z = [-3.0, -2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0]
RATES = (0.03, 0.01)  # r, q used for the whole fixture


def main() -> None:
    r, q = RATES
    S0 = 100.0

    # CF self-checks before trusting the reference
    for name, p in PARAM_SETS.items():
        args = tuple(p.values())
        for T in MATURITIES:
            assert abs(cf_trap(0.0, T, *args) - 1) < 1e-14
            assert abs(cf_trap(-1j, T, *args) - 1) < 1e-10, (name, T)  # martingale: E[S_T/F] = 1
        u = np.linspace(0.1, 30, 60)
        np.testing.assert_allclose(cf_trap(u, 1 / 12, *args), cf_original(u, 1 / 12, *args), rtol=1e-9, atol=1e-13)

    cases = []
    worst_err = 0.0
    for name, p in PARAM_SETS.items():
        args = tuple(p.values())
        for T in MATURITIES:
            F = S0 * math.exp((r - q) * T)
            for z in Z:
                K = F * math.exp(z * 0.25 * math.sqrt(T))
                call, err = lewis_call(S0, K, T, args, r, q)
                worst_err = max(worst_err, err)
                put = call - S0 * math.exp(-q * T) + K * math.exp(-r * T)
                cases.append({"set": name, "T": T, "K": K, "call": call, "put": put, "quad_err": err})

    # Black-Scholes reference values for the JS IV round-trip and normCdf tests
    bs = []
    for T in (1 / 52, 0.25, 1.0, 3.0):
        for sigma in (0.05, 0.2, 0.6, 1.5):
            for z in (-2.5, -1.0, 0.0, 1.0, 2.5):
                K = 100.0 * math.exp(z * sigma * math.sqrt(T))
                bs.append({"F": 100.0, "K": K, "T": T, "sigma": sigma, "call": black_call(100.0, K, T, sigma)})
    xs = [-38.0, -20.0, -8.5, -7.0, -5.0, -3.0, -1.5, -0.5, 0.0, 0.3, 1.0, 2.2, 4.0, 7.5, 9.0]
    ncdf = [{"x": x, "cdf": float(ndtr(x))} for x in xs]

    cumulants = [
        {"set": name, "T": T, **dict(zip(("c1", "c2", "c4"), exact_cumulants(T, *p.values())))}
        for name, p in PARAM_SETS.items() for T in MATURITIES
    ]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "description": "Heston call/put prices by Lewis (2001) integral with scipy quad; see pipeline/tests/make_heston_fixture.py",
        "S0": S0, "r": r, "q": q,
        "params": PARAM_SETS,
        "max_quad_err": worst_err,
        "cases": cases,
        "cumulants": cumulants,
        "black": bs,
        "normcdf": ncdf,
    }, indent=1) + "\n")
    print(f"wrote {len(cases)} Heston cases, {len(bs)} Black cases to {OUT}; max quad err {worst_err:.2e}")


if __name__ == "__main__":
    main()
