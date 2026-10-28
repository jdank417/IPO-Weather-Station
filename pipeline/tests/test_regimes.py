import math

import numpy as np
import pytest

from pipeline.calibrate_term_structure import DayFit
from pipeline.fetch_fred import parse_csv
from pipeline.fit_ipo_regimes import fit_best, hamilton_filter, logistic, next_month, to_gauge_params
from pipeline.load_ritter import load
from pipeline.monthly import build_monthly, cpi_yoy, vol1y

TRUE = {"mu": (1.5, 2.8), "sigma": 0.45, "g_cold": (-3.0, 1.2), "g_hot": (2.5, -1.0)}


def simulate(n=400, seed=1):
    """Two-regime data where a single covariate raises P(cold -> hot) and lowers P(hot -> hot)."""
    rng = np.random.default_rng(seed)
    z = rng.normal(size=n)
    X = np.column_stack([np.ones(n), z])
    s = np.zeros(n, int)
    for t in range(1, n):
        g = TRUE["g_hot"] if s[t - 1] else TRUE["g_cold"]
        s[t] = rng.random() < logistic(np.dot(g, X[t]))
    y = np.array(TRUE["mu"])[s] + rng.normal(scale=TRUE["sigma"], size=n)
    return y, X


def test_mle_recovers_tvtp_parameters():
    y, X = simulate()
    res = fit_best(y, X, seeds=range(2), search_reps=20)
    g = to_gauge_params(list(res.model.param_names), np.asarray(res.params), 1)
    assert g["mu"]["cold"] == pytest.approx(TRUE["mu"][0], abs=0.15)
    assert g["mu"]["hot"] == pytest.approx(TRUE["mu"][1], abs=0.15)
    assert g["sigma"] == pytest.approx(TRUE["sigma"], rel=0.15)
    se = dict(zip(res.model.param_names, np.asarray(res.bse)))
    # transition coefficients within ~2.5 standard errors of the truth
    for (state, truth) in (("cold", TRUE["g_cold"]), ("hot", TRUE["g_hot"])):
        j = 1 - g["hot_regime_index"] if state == "cold" else g["hot_regime_index"]
        for c, b in enumerate(truth):
            err = se[f"p[{j}->0].tvtp{c}"]
            assert abs(g["gamma"][state][c] - b) < 2.5 * err + 0.05, (state, c, g["gamma"][state][c], b, err)


def test_mapping_and_filter_match_statsmodels():
    """Whichever regime statsmodels labels hot; the other labeling is covered below."""
    y, X = simulate(seed=3)
    res = fit_best(y, X, seeds=[0], search_reps=10)
    names, params = list(res.model.param_names), np.asarray(res.params)
    g = to_gauge_params(names, params, 1)
    filt, ll, _ = hamilton_filter(y, X, g)
    ref = np.asarray(res.filtered_marginal_probabilities)[:, g["hot_regime_index"]]
    np.testing.assert_allclose(filt, ref, atol=1e-9)
    assert ll == pytest.approx(res.llf, abs=1e-7)


def test_mapping_handles_hot_as_regime_zero():
    # hand-built parameters with regime 0 hot: P(S_t=0|S_{t-1}=j) = logistic(beta_j x)
    names = ["p[0->0].tvtp0", "p[1->0].tvtp0", "p[0->0].tvtp1", "p[1->0].tvtp1", "const[0]", "const[1]", "sigma2"]
    params = np.array([2.0, -1.0, 0.5, 0.3, 3.0, 1.0, 0.25])
    g = to_gauge_params(names, params, 1)
    assert g["hot_regime_index"] == 0
    x = np.array([1.0, 0.7])
    # from hot (regime 0): P(hot) = P(S_t=0 | S_{t-1}=0)
    assert logistic(np.dot(g["gamma"]["hot"], x)) == pytest.approx(logistic(2.0 + 0.5 * 0.7))
    # from cold (regime 1): P(hot) = P(S_t=0 | S_{t-1}=1)
    assert logistic(np.dot(g["gamma"]["cold"], x)) == pytest.approx(logistic(-1.0 + 0.3 * 0.7))
    assert g["sigma"] == pytest.approx(0.5)


def test_next_month():
    assert next_month("2025-12") == "2026-01"
    assert next_month("2026-01") == "2026-02"


def test_ritter_file_parses():
    rows = load()
    months = [r.month for r in rows]
    assert months[0] == "1960-01" and months == sorted(months)
    recent = [r for r in rows if r.month >= "2009-01"]
    assert all(r.net is not None and r.net >= 0 and r.gross >= r.net for r in recent)
    # months without net IPOs have no first-day return rather than a fake zero
    assert all(r.first_day_return is None for r in recent if r.net == 0)


def test_fred_parse_skips_missing():
    vals = parse_csv("observation_date,T5YIE\n2024-01-01,2.1\n2024-01-02,.\n2024-01-03,\n2024-01-04,2.3\n")
    assert vals == {"2024-01-01": 2.1, "2024-01-04": 2.3}
    with pytest.raises(ValueError):
        parse_csv("<html>")


def test_monthly_panel():
    fits = [
        DayFit(date="2024-01-02", n_points=4, tenors=[], v0=0.04, kappa=2.0, theta=0.05),
        DayFit(date="2024-01-03", n_points=4, tenors=[], v0=0.04, kappa=2.0, theta=0.05, flags=["bad_fit"]),
        DayFit(date="2024-02-01", n_points=4, tenors=[], v0=0.09, kappa=2.0, theta=0.05),
    ]
    fred = {"CPIAUCSL": {"2023-01-01": 100.0, "2024-01-01": 103.0}, "T5YIE": {"2024-01-02": 2.0, "2024-01-03": 2.2}}
    panel = build_monthly(fits, {"2024-01-02": 140.0, "2024-01-05": 150.0}, fred)
    jan = panel["2024-01"]
    assert jan["n_fit_days"] == 1                      # the bad fit is excluded
    assert jan["vol1y"] == pytest.approx(vol1y(0.04, 2.0, 0.05))
    assert jan["skew"] == pytest.approx(145.0)
    assert jan["be5"] == pytest.approx(2.1)
    assert jan["cpi_yoy"] == pytest.approx(3.0)
    assert panel["2024-02"]["skew"] is None            # missing stays missing
    assert cpi_yoy({"2024-01-01": 1.0}) == {}
    assert vol1y(0.04, 1e-9, 0.04) == pytest.approx(20.0)
    assert math.isfinite(vol1y(0.3, 30.0, 0.01))
