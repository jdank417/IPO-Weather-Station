import math

import numpy as np
import pytest

from pipeline.calibrate_term_structure import (
    HORIZONS, LOWER, TENORS, UPPER, build_table, calibrate_history, expected_avg_variance, fit_day, model_vix,
)

# (v0, kappa, theta): contango, backwardation (stress), steep stress, calm, near-flat-ish
TRUE_PARAMS = [
    (0.02, 2.0, 0.05),
    (0.09, 4.0, 0.04),
    (0.40, 8.0, 0.06),
    (0.01, 1.0, 0.03),
    (0.03, 3.0, 0.045),
]


def synthetic_quotes(v0, kappa, theta, noise_volpts=0.0, rng=None, tenors=TENORS):
    q = {}
    for t in tenors:
        level = float(model_vix(HORIZONS[t], v0, kappa, theta))
        if noise_volpts:
            level += rng.normal(0.0, noise_volpts)
        q[t] = level
    return q


def test_formula_limits():
    # kappa*T -> 0 gives A = v0; kappa*T -> inf gives A = theta
    assert expected_avg_variance(1e-9, 0.04, 2.0, 0.09) == pytest.approx(0.04, rel=1e-8)
    assert expected_avg_variance(1e4, 0.04, 2.0, 0.09) == pytest.approx(0.09, rel=1e-4)
    # small-x branch agrees with the direct formula across the switch point
    for x in (1e-7, 1e-6, 1.1e-6, 1e-3):
        direct = 0.09 + (0.04 - 0.09) * -math.expm1(-x) / x
        assert expected_avg_variance(x, 0.04, 1.0, 0.09) == pytest.approx(direct, rel=1e-12)


@pytest.mark.parametrize("params", TRUE_PARAMS)
def test_exact_recovery_without_prior(params):
    fit = fit_day("2020-01-02", synthetic_quotes(*params), prior_weight=0.0)
    assert fit.ok
    np.testing.assert_allclose([fit.v0, fit.kappa, fit.theta], params, rtol=1e-6)
    assert fit.rmse_volpts < 1e-8
    assert not any(f.endswith("_at_bound") or f == "bad_fit" for f in fit.flags)


@pytest.mark.parametrize("params", TRUE_PARAMS)
def test_default_prior_keeps_curve_and_short_end(params):
    """The log-kappa prior trades a tiny misfit for stability.

    The curve over the observed horizons and v0 (the short end) stay tight; theta is
    an extrapolation beyond 6 months when kappa*T is small, so the prior moves it
    more (up to ~15% for kappa = 1).
    """
    fit = fit_day("2020-01-02", synthetic_quotes(*params))
    assert fit.rmse_volpts < 0.02
    assert fit.v0 == pytest.approx(params[0], rel=0.03)
    assert fit.theta == pytest.approx(params[2], rel=0.15)
    assert fit.kappa == pytest.approx(params[1], rel=0.5)


@pytest.mark.parametrize("params", TRUE_PARAMS)
def test_recovery_with_noise(params):
    """Noise of 0.05 VIX points (roughly quote rounding) leaves v0 and theta well pinned."""
    rng = np.random.default_rng(12345)
    est = np.array([
        [f.v0, f.kappa, f.theta]
        for f in (fit_day("2020-01-02", synthetic_quotes(*params, noise_volpts=0.05, rng=rng)) for _ in range(40))
    ])
    med = np.median(est, axis=0)
    assert med[0] == pytest.approx(params[0], rel=0.05)
    assert med[2] == pytest.approx(params[2], rel=0.15)
    # the fitted curve over observed horizons is unbiased to well within quote precision
    T = np.array([HORIZONS[t] for t in TENORS])
    assert np.max(np.abs(model_vix(T, *med) - model_vix(T, *params))) < 0.1
    # kappa is the weakly identified parameter; only require the right ballpark
    assert params[1] / 2 < med[1] < params[1] * 2


def test_three_points_is_exactly_identified():
    params = (0.02, 2.0, 0.05)
    q = synthetic_quotes(*params, tenors=("VIX", "VIX3M", "VIX6M"))
    fit = fit_day("2010-01-04", q, prior_weight=0.0)
    np.testing.assert_allclose([fit.v0, fit.kappa, fit.theta], params, rtol=1e-6)
    assert "exactly_identified" in fit.flags
    assert "missing:VIX9D" in fit.flags


def test_insufficient_data_is_flagged_not_dropped():
    fit = fit_day("2008-06-02", {"VIX": 20.0, "VIX6M": 22.0})
    assert not fit.ok
    assert "insufficient_data" in fit.flags
    fits = calibrate_history({"2008-06-02": {"VIX": 20.0, "VIX6M": 22.0}})
    assert len(fits) == 1 and not fits[0].ok


def test_bad_values_treated_as_missing():
    q = synthetic_quotes(0.02, 2.0, 0.05)
    q["VIX9D"] = float("nan")
    fit = fit_day("2020-01-02", q)
    assert fit.n_points == 3 and "missing:VIX9D" in fit.flags


def test_humped_curve_is_flagged_bad_fit():
    # a one-factor model cannot produce a hump; the fit must say so
    fit = fit_day("2020-01-02", {"VIX9D": 30.0, "VIX": 20.0, "VIX3M": 28.0, "VIX6M": 21.0})
    assert fit.ok and "bad_fit" in fit.flags


def test_estimates_respect_bounds():
    fit = fit_day("2020-01-02", {"VIX9D": 12.0, "VIX": 15.0, "VIX3M": 19.0, "VIX6M": 23.0}, prior_weight=0.0)
    x = np.array([fit.v0, fit.kappa, fit.theta])
    assert np.all(x >= LOWER) and np.all(x <= UPPER)


def test_history_warm_start_and_pivot():
    rng = np.random.default_rng(7)
    series = {t: {} for t in TENORS}
    days = [f"2021-03-{d:02d}" for d in range(1, 21)]
    for i, day in enumerate(days):
        q = synthetic_quotes(0.02 + 0.001 * i, 2.5, 0.05, noise_volpts=0.02, rng=rng)
        for t, v in q.items():
            series[t][day] = v
    fits = calibrate_history(build_table(series))
    assert [f.date for f in fits] == days
    assert all(f.ok and f.n_points == 4 for f in fits)
    v0s = np.array([f.v0 for f in fits])
    np.testing.assert_allclose(v0s, 0.02 + 0.001 * np.arange(20), atol=0.002)
