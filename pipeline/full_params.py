"""Complete the daily Heston parameter set.

The VIX term structure fixes v0, kappa and theta (calibrate_term_structure.py)
but says nothing about xi or rho. Two more public inputs pin them down:

* xi (vol of vol) from Cboe's VVIX. Under Heston, VIX^2(tau) = a + b v with
  b = (1 - exp(-kappa tau)) / (kappa tau), tau = 30 days, so
  d(VIX^2) = b xi sqrt(v) dW and the volatility of VIX is
  b xi sqrt(v) / (2 VIX^2). Setting that equal to VVIX / 100 gives
  xi = 2 VIX^2 (VVIX / 100) / (b sqrt(v0)).
* rho from the trailing one-year correlation of daily S&P 500 log returns with
  daily changes in the fitted v0, both scaled by sqrt(v0). In Heston rho is
  the same under real-world and risk-neutral probabilities, so a realized
  estimate is legitimate.

The drift uses the 3-month Treasury bill rate (FRED DTB3) and a fixed S&P 500
dividend yield. See docs/odds_model.rst.
"""

from __future__ import annotations

import math
from bisect import bisect_right

from pipeline.calibrate_term_structure import DayFit

VIX_TAU = 30 / 365
XI_BOUNDS = (0.05, 3.0)
RHO_BOUNDS = (-0.99, 0.5)
RHO_DEFAULT = -0.7
RHO_WINDOW = 252          # trading days
RHO_MIN_OBS = 120
DIVIDEND_YIELD = 0.013    # S&P 500 trailing dividend yield, roughly constant over the sample


def xi_from_vvix(v0: float, kappa: float, vix: float, vvix: float) -> float:
    x = kappa * VIX_TAU
    b = -math.expm1(-x) / x if x > 1e-9 else 1.0
    xi = 2.0 * (vix / 100.0) ** 2 * (vvix / 100.0) / (b * math.sqrt(v0))
    return min(max(xi, XI_BOUNDS[0]), XI_BOUNDS[1])


def _corr(a: list[float], b: list[float]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    sab = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    saa = sum((x - ma) ** 2 for x in a)
    sbb = sum((y - mb) ** 2 for y in b)
    return sab / math.sqrt(saa * sbb) if saa > 0 and sbb > 0 else float("nan")


def rolling_rho(dates: list[str], v0: dict[str, float], spx: dict[str, float]) -> dict[str, float | None]:
    """Trailing-window correlation for each date (None until enough history)."""
    usable = [d for d in dates if d in v0 and d in spx]
    z1, z2, ends = [], [], []
    for prev, d in zip(usable, usable[1:]):
        s = math.sqrt(v0[prev])
        z1.append(math.log(spx[d] / spx[prev]) / s)
        z2.append((v0[d] - v0[prev]) / s)
        ends.append(d)
    out: dict[str, float | None] = {}
    for i, d in enumerate(ends):
        lo = max(0, i + 1 - RHO_WINDOW)
        if i + 1 - lo < RHO_MIN_OBS:
            out[d] = None
            continue
        r = _corr(z1[lo:i + 1], z2[lo:i + 1])
        out[d] = None if math.isnan(r) else min(max(r, RHO_BOUNDS[0]), RHO_BOUNDS[1])
    return out


def as_of(series: dict[str, float], day: str) -> float | None:
    """Latest value on or before `day`."""
    keys = sorted(series)
    i = bisect_right(keys, day)
    return series[keys[i - 1]] if i else None


def full_params(fits: list[DayFit], vix: dict[str, float], vvix: dict[str, float],
                spx: dict[str, float], tbill: dict[str, float]) -> dict[str, dict]:
    """{date: {v0, kappa, theta, xi, rho, r, q, rho_source, approx}} for days with a fit and VVIX.

    Days flagged bad_fit are kept (approx=True): they are usually the most
    dramatic crisis days, when a one-factor model is stretched but still the
    best available summary. The UI labels them.
    """
    good = [f for f in fits if f.ok]
    v0 = {f.date: f.v0 for f in good}
    rho = rolling_rho([f.date for f in good], v0, spx)
    tb_keys = sorted(tbill)
    out = {}
    for f in good:
        if f.date not in vvix or f.date not in vix:
            continue
        rr = rho.get(f.date)
        i = bisect_right(tb_keys, f.date)
        r = tbill[tb_keys[i - 1]] / 100.0 if i else 0.0
        out[f.date] = {
            "v0": f.v0, "kappa": f.kappa, "theta": f.theta,
            "xi": xi_from_vvix(f.v0, f.kappa, vix[f.date], vvix[f.date]),
            "rho": RHO_DEFAULT if rr is None else rr,
            "rho_source": "default" if rr is None else "realized",
            "approx": "bad_fit" in f.flags,
            "r": r, "q": DIVIDEND_YIELD,
        }
    return out
