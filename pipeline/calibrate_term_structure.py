"""Fit Heston (v0, kappa, theta) to the VIX term structure, one day at a time.

Under Heston, the risk-neutral expected average variance over [0, T] is

    A(T) = theta + (v0 - theta) * (1 - exp(-kappa T)) / (kappa T)

We treat (VIX_T / 100)^2 as A(T) at each available horizon and solve a bounded
nonlinear least-squares problem in variance units. xi and rho do not enter A(T)
and are therefore NOT identified here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import least_squares

# Calendar-day horizons of each index, as a fraction of a 365-day year.
HORIZON_DAYS = {"VIX9D": 9, "VIX": 30, "VIX3M": 91, "VIX6M": 182}
HORIZONS = {k: d / 365.0 for k, d in HORIZON_DAYS.items()}
TENORS = tuple(HORIZON_DAYS)  # ordered short -> long

# Parameter bounds (v0, kappa, theta). v0 up to (200% vol)^2 to survive crash days;
# theta up to (100% vol)^2; kappa between a ~7-year and a ~8-day half-life.
LOWER = np.array([1e-4, 0.1, 1e-4])
UPPER = np.array([4.0, 30.0, 1.0])

# Weak prior on log(kappa). On days when the curve is a near-linear ramp, only
# kappa * (theta - v0) is identified and an unpenalized fit runs to kappa -> 0,
# theta -> infinity. The penalty residual PRIOR_WEIGHT * mean(target variance) *
# ln(kappa / KAPPA_PRIOR) settles those days while barely moving well-identified ones.
KAPPA_PRIOR = 2.0
PRIOR_WEIGHT = 0.01

MIN_POINTS = 3          # three parameters need at least three horizons
BAD_FIT_VOLPTS = 0.75   # flag a day whose worst residual exceeds this many VIX points
FLAT_REL = 0.02         # |v0 - theta| / theta below this: kappa is barely identified


def expected_avg_variance(T, v0, kappa, theta):
    """A(T); numerically stable as kappa*T -> 0 (where A -> v0)."""
    w, _ = _weight(kappa * np.asarray(T, dtype=float))
    return theta + (v0 - theta) * w


def model_vix(T, v0, kappa, theta):
    """Model-implied VIX-style index level (vol points) at horizon(s) T."""
    return 100.0 * np.sqrt(expected_avg_variance(T, v0, kappa, theta))


@dataclass
class DayFit:
    date: str
    n_points: int
    tenors: list[str]
    v0: float | None = None
    kappa: float | None = None
    theta: float | None = None
    residuals_volpts: dict[str, float] = field(default_factory=dict)  # model - observed
    rmse_volpts: float | None = None
    flags: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.v0 is not None


def _weight(x):
    """w(x) = (1 - e^{-x}) / x and dw/dx, stable near x = 0."""
    small = x < 1e-6
    xs = np.where(small, 1.0, x)
    w = np.where(small, 1.0 - x / 2.0 + x * x / 6.0, -np.expm1(-xs) / xs)
    dw = np.where(small, -0.5 + x / 3.0, (np.exp(-xs) * (xs + 1.0) - 1.0) / xs**2)
    return w, dw


def _grid_start(T: np.ndarray, target_var: np.ndarray, lam: float) -> np.ndarray:
    """Global start by variable projection: for fixed kappa, A(T) is linear in (v0, theta)."""
    kappas = np.geomspace(LOWER[1], UPPER[1], 241)
    w, _ = _weight(kappas[:, None] * T[None, :])            # (K, n)
    X = np.stack([w, 1.0 - w], axis=-1)                       # (K, n, 2)
    XtX = np.einsum("kni,knj->kij", X, X)
    Xty = np.einsum("kni,n->ki", X, target_var)
    coef = np.linalg.solve(XtX + 1e-18 * np.eye(2), Xty[..., None])[..., 0]
    coef = np.clip(coef, LOWER[[0, 2]], UPPER[[0, 2]])
    sse = np.sum((np.einsum("kni,ki->kn", X, coef) - target_var) ** 2, axis=1)
    sse += (lam * np.log(kappas / KAPPA_PRIOR)) ** 2
    k = int(np.argmin(sse))
    return np.array([coef[k, 0], kappas[k], coef[k, 1]])


def _solve(T: np.ndarray, target_var: np.ndarray, x0: np.ndarray, lam: float):
    def resid(p):
        w, _ = _weight(p[1] * T)
        return np.append(p[2] + (p[0] - p[2]) * w - target_var, lam * np.log(p[1] / KAPPA_PRIOR))

    def jac(p):
        w, dw = _weight(p[1] * T)
        J = np.column_stack([w, (p[0] - p[2]) * dw * T, 1.0 - w])
        return np.vstack([J, [0.0, lam / p[1], 0.0]])

    x0 = np.clip(x0, LOWER * 1.0001, UPPER * 0.9999)
    return least_squares(
        resid, x0, jac=jac, bounds=(LOWER, UPPER), method="trf",
        x_scale=np.array([0.01, 1.0, 0.01]), xtol=1e-12, ftol=1e-13, gtol=1e-13, max_nfev=500,
    )


def fit_day(date: str, quotes: dict[str, float], warm_start: tuple[float, float, float] | None = None,
            prior_weight: float = PRIOR_WEIGHT) -> DayFit:
    """Fit one day. ``quotes`` maps tenor symbol -> index level; missing tenors are omitted.

    ``prior_weight=0`` gives the plain bounded least-squares fit.
    """
    tenors = [t for t in TENORS if t in quotes and quotes[t] is not None and math.isfinite(quotes[t]) and quotes[t] > 0]
    fit = DayFit(date=date, n_points=len(tenors), tenors=tenors)
    if len(tenors) < 4:
        missing = [t for t in TENORS if t not in tenors]
        fit.flags.append("missing:" + "+".join(missing))
    if len(tenors) < MIN_POINTS:
        fit.flags.append("insufficient_data")
        return fit
    if len(tenors) == MIN_POINTS:
        fit.flags.append("exactly_identified")

    T = np.array([HORIZONS[t] for t in tenors])
    vix = np.array([quotes[t] for t in tenors])
    target = (vix / 100.0) ** 2

    lam = prior_weight * float(np.mean(target))

    # Refine from a global grid start and from the previous day's fit; keep the better.
    starts = [_grid_start(T, target, lam)]
    if warm_start is not None and all(math.isfinite(x) for x in warm_start):
        starts.insert(0, np.array(warm_start))
    best = min((_solve(T, target, s, lam) for s in starts), key=lambda r: r.cost)

    v0, kappa, theta = (float(x) for x in best.x)
    fit.v0, fit.kappa, fit.theta = v0, kappa, theta
    model = model_vix(T, v0, kappa, theta)
    res = model - vix
    fit.residuals_volpts = {t: float(r) for t, r in zip(tenors, res)}
    fit.rmse_volpts = float(np.sqrt(np.mean(res ** 2)))

    rel = (UPPER - LOWER) * 1e-6
    names = ("v0", "kappa", "theta")
    for i, name in enumerate(names):
        if best.x[i] <= LOWER[i] + rel[i] or best.x[i] >= UPPER[i] - rel[i]:
            fit.flags.append(f"{name}_at_bound")
    if not best.success:
        fit.flags.append("solver_failed")
    if np.max(np.abs(res)) > BAD_FIT_VOLPTS:
        fit.flags.append("bad_fit")
    if abs(v0 - theta) / theta < FLAT_REL:
        fit.flags.append("flat_term_structure")
    return fit


def build_table(series: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    """Pivot {tenor: {date: level}} into {date: {tenor: level}} over the tenors we fit."""
    table: dict[str, dict[str, float]] = {}
    for tenor in TENORS:
        for day, level in series.get(tenor, {}).items():
            table.setdefault(day, {})[tenor] = level
    return table


def calibrate_history(table: dict[str, dict[str, float]], start: str | None = None,
                      prior_weight: float = PRIOR_WEIGHT) -> list[DayFit]:
    """Fit every date (ascending), warm-starting each day from the last good fit."""
    fits: list[DayFit] = []
    warm = None
    for day in sorted(table):
        if start is not None and day < start:
            continue
        f = fit_day(day, table[day], warm, prior_weight)
        if f.ok and "bad_fit" not in f.flags:
            warm = (f.v0, f.kappa, f.theta)
        fits.append(f)
    return fits
