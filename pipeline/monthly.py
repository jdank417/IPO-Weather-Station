"""Monthly covariate panel for the IPO regime model.

Daily inputs are averaged within each calendar month:

* ``vol1y``: sqrt of the Heston expected average variance over one year,
  sqrt(A(1y; v0, kappa, theta)), in %. It summarizes the whole fitted term
  structure in one number and responds to all three fitted parameters, which
  is what lets the v0 / theta / kappa sliders drive the gauge.
* ``spot_vol``, ``long_vol`` (sqrt v0, sqrt theta, %), ``kappa`` (median):
  reported for reference and alternative specifications.
* ``skew``: Cboe SKEW index.
* ``be5``, ``be10``: 5y and 10y breakeven inflation (%); ``ry10``: 10y TIPS
  real yield (%); ``cpi_yoy``: CPI year-over-year inflation (%), monthly.

Only days whose fit is usable (not ``bad_fit``/``insufficient_data``) enter
the volatility averages; ``n_fit_days`` records how many did.
"""

from __future__ import annotations

import math
from collections import defaultdict
from statistics import mean, median

from pipeline.calibrate_term_structure import DayFit, expected_avg_variance

COVARIATES = ("vol1y", "spot_vol", "long_vol", "kappa", "skew", "be5", "be10", "ry10", "cpi_yoy")


def month_of(day: str) -> str:
    return day[:7]


def vol1y(v0: float, kappa: float, theta: float) -> float:
    return 100.0 * math.sqrt(float(expected_avg_variance(1.0, v0, kappa, theta)))


def usable(f: DayFit) -> bool:
    return f.ok and "bad_fit" not in f.flags


def _monthly_mean(daily: dict[str, float]) -> dict[str, float]:
    acc: dict[str, list[float]] = defaultdict(list)
    for d, v in daily.items():
        acc[month_of(d)].append(v)
    return {m: mean(vs) for m, vs in acc.items()}


def cpi_yoy(cpi: dict[str, float]) -> dict[str, float]:
    by_month = {month_of(d): v for d, v in cpi.items()}
    out = {}
    for m, v in by_month.items():
        y, mm = int(m[:4]), m[5:]
        prev = by_month.get(f"{y - 1:04d}-{mm}")
        if prev:
            out[m] = 100.0 * (v / prev - 1.0)
    return out


def build_monthly(fits: list[DayFit], skew: dict[str, float], fred: dict[str, dict[str, float]]) -> dict[str, dict]:
    """Return {YYYY-MM: {covariate: value or None, 'n_fit_days': int}} for months with any fit."""
    vol_days: dict[str, list[DayFit]] = defaultdict(list)
    for f in fits:
        if usable(f):
            vol_days[month_of(f.date)].append(f)

    skew_m = _monthly_mean(skew)
    be5 = _monthly_mean(fred.get("T5YIE", {}))
    be10 = _monthly_mean(fred.get("T10YIE", {}))
    ry10 = _monthly_mean(fred.get("DFII10", {}))
    infl = cpi_yoy(fred.get("CPIAUCSL", {}))

    panel = {}
    for m in sorted(vol_days):
        fs = vol_days[m]
        panel[m] = {
            "vol1y": mean(vol1y(f.v0, f.kappa, f.theta) for f in fs),
            "spot_vol": mean(100 * math.sqrt(f.v0) for f in fs),
            "long_vol": mean(100 * math.sqrt(f.theta) for f in fs),
            "kappa": median(f.kappa for f in fs),
            "skew": skew_m.get(m),
            "be5": be5.get(m),
            "be10": be10.get(m),
            "ry10": ry10.get(m),
            "cpi_yoy": infl.get(m),
            "n_fit_days": len(fs),
        }
    return panel
