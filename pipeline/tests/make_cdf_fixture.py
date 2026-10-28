"""Reference S&P odds (CDF of ln(S_T/S_0)) by Gil-Pelaez integration, for the JS tests.

    python -m pipeline.tests.make_cdf_fixture
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.integrate import quad

from pipeline.odds import heston_cf

OUT = Path(__file__).resolve().parents[2] / "tests" / "js" / "fixtures" / "cdf_reference.json"

SETS = {
    "today_like": dict(v0=0.0262, kappa=2.84, theta=0.0686, xi=0.42, rho=-0.72),
    "crisis": dict(v0=0.36, kappa=6.0, theta=0.06, xi=1.2, rho=-0.85),
    "high_xi": dict(v0=0.04, kappa=1.5, theta=0.04, xi=1.5, rho=-0.7),
    "slow_kappa": dict(v0=0.03, kappa=0.2, theta=0.08, xi=0.4, rho=-0.5),
}
TS = [7 / 365, 30 / 365, 0.25, 1.0]
XS = [-0.5, -0.2, -0.1, -0.05, 0.0, 0.05, 0.1, 0.2]
R, Q = 0.04, 0.013


def gil_pelaez(x, T, p):
    f = lambda u: (np.exp(-1j * u * x) * heston_cf(u, T, *p, r=R, q=Q)).imag / u
    v = sum(quad(f, lo, hi, limit=2000, epsabs=1e-13, epsrel=1e-12)[0] for lo, hi in ((1e-12, 50), (50, np.inf)))
    return 0.5 - v / math.pi


def main():
    cases = [{"set": n, "T": T, "x": x, "cdf": gil_pelaez(x, T, tuple(p.values()))}
             for n, p in SETS.items() for T in TS for x in XS]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"r": R, "q": Q, "params": SETS, "cases": cases}, indent=1) + "\n")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
