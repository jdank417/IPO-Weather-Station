import json
import math

import numpy as np
import pytest
from scipy.integrate import quad

from pipeline.calibrate_term_structure import HORIZONS, TENORS, build_table, calibrate_history, model_vix
from pipeline.events import max_drawdown
from pipeline.export_json import export
from pipeline.fetch_cboe import CboeFormatError, parse_history
from pipeline.fetch_fred import parse_csv
from pipeline.full_params import VIX_TAU, as_of, full_params, rolling_rho, xi_from_vvix
from pipeline.odds import cos_cdf, heston_cf

SAMPLE = """﻿DATE,OPEN,HIGH,LOW,CLOSE
01/02/2024,13.21,14.23,13.10,13.20
01/03/2024,,,,
01/04/2024,14.00,14.20,13.80,-1
not-a-date,1,1,1,1
01/05/2024,13.50,13.70,13.30,13.35
"""


def test_parse_history_reports_problems():
    values, problems = parse_history(SAMPLE.lstrip("﻿"), "CLOSE")
    assert values == {"2024-01-02": 13.20, "2024-01-05": 13.35}
    assert len(problems) == 3
    assert any("2024-01-03" in p for p in problems)
    assert any("non-positive" in p for p in problems)


def test_parse_single_column_layouts():
    assert parse_history("DATE,VVIX\n03/06/2006,71.73\n", "VVIX")[0] == {"2006-03-06": 71.73}
    assert parse_history("DATE,SPX\n01/02/1975,70.23\n", "SPX")[0] == {"1975-01-02": 70.23}


@pytest.mark.parametrize("text", ["", "<html>redirect</html>", "DATE,OPEN\n01/02/2024,1\n"])
def test_parse_rejects_wrong_format(text):
    with pytest.raises(CboeFormatError):
        parse_history(text, "CLOSE")


def test_fred_parse_skips_missing():
    assert parse_csv("observation_date,DTB3\n2024-01-01,5.2\n2024-01-02,.\n2024-01-03,5.1\n") == {
        "2024-01-01": 5.2, "2024-01-03": 5.1}
    with pytest.raises(ValueError):
        parse_csv("<html>")


# ---------- xi and rho ----------

def test_xi_from_vvix_inverts_heston_vix_dynamics():
    v0, kappa, theta, xi = 0.03, 2.5, 0.05, 0.7
    b = (1 - math.exp(-kappa * VIX_TAU)) / (kappa * VIX_TAU)
    vix2 = theta + (v0 - theta) * b           # Heston VIX^2 at tau = 30 days
    vvix = 100 * b * xi * math.sqrt(v0) / (2 * vix2)
    assert xi_from_vvix(v0, kappa, 100 * math.sqrt(vix2), vvix) == pytest.approx(xi, rel=1e-12)


def test_xi_is_clamped():
    assert xi_from_vvix(0.04, 2.0, 20.0, 1e-6) == 0.05
    assert xi_from_vvix(0.0001, 2.0, 80.0, 400.0) == 3.0


def test_rolling_rho_recovers_simulated_correlation():
    rng = np.random.default_rng(0)
    n, rho, xi, dt = 800, -0.7, 0.6, 1 / 252
    dates = [f"d{i:04d}" for i in range(n)]
    v, s = [0.04], [100.0]
    for _ in range(n - 1):
        z1 = rng.normal(); z2 = rho * z1 + math.sqrt(1 - rho * rho) * rng.normal()
        vv = v[-1]
        s.append(s[-1] * math.exp(-0.5 * vv * dt + math.sqrt(vv * dt) * z1))
        v.append(max(vv + 2.0 * (0.04 - vv) * dt + xi * math.sqrt(vv * dt) * z2, 1e-4))
    out = rolling_rho(dates, dict(zip(dates, v)), dict(zip(dates, s)))
    assert out[dates[100]] is None                       # not enough history yet
    est = [out[d] for d in dates[300:]]
    assert np.mean(est) == pytest.approx(rho, abs=0.06)


def test_as_of():
    s = {"2024-01-02": 1.0, "2024-01-05": 2.0}
    assert as_of(s, "2024-01-04") == 1.0 and as_of(s, "2024-01-05") == 2.0 and as_of(s, "2023-12-31") is None


# ---------- odds ----------

def gil_pelaez(x, T, p, r=0.0, q=0.0):
    f = lambda u: (np.exp(-1j * u * x) * heston_cf(u, T, *p, r=r, q=q)).imag / u
    v = sum(quad(f, lo, hi, limit=2000, epsabs=1e-13, epsrel=1e-12)[0] for lo, hi in ((1e-12, 50), (50, np.inf)))
    return 0.5 - v / math.pi


@pytest.mark.parametrize("p", [(0.0262, 2.84, 0.0686, 0.42, -0.72), (0.36, 6.0, 0.06, 1.2, -0.85), (0.03, 0.2, 0.08, 0.4, -0.5)])
def test_cos_cdf_matches_gil_pelaez(p):
    for T in (7 / 365, 30 / 365, 1.0):
        for x in (-0.3, -0.1, 0.0, 0.1):
            assert cos_cdf(x, T, *p, r=0.04, q=0.013)[0] == pytest.approx(gil_pelaez(x, T, p, 0.04, 0.013), abs=1e-9)


def test_cos_cdf_is_a_distribution():
    xs = np.linspace(-1.5, 1.0, 60)
    F = cos_cdf(xs, 0.5, 0.04, 2.0, 0.04, 0.6, -0.7)
    assert np.all(np.diff(F) >= -1e-12) and F[0] < 1e-4 and F[-1] > 1 - 1e-6  # fat left tail


def test_max_drawdown():
    dd, a, b = max_drawdown([("d1", 100), ("d2", 120), ("d3", 90), ("d4", 130), ("d5", 117)])
    assert dd == pytest.approx(-0.25) and (a, b) == ("d2", "d3")
    assert max_drawdown([("d1", 1), ("d2", 2)])[0] == 0.0


# ---------- export ----------

def _inputs():
    days = [f"2024-01-{d:02d}" for d in range(2, 12)]
    series = {t: {} for t in TENORS}
    for i, day in enumerate(days):
        for t in TENORS:
            series[t][day] = float(model_vix(HORIZONS[t], 0.02 + 0.001 * i, 2.0, 0.05))
    fits = calibrate_history(build_table(series))
    vix = dict(series["VIX"])
    vvix = {d: 90.0 for d in days}
    spx = {d: 5000.0 * (1 + 0.001 * i) for i, d in enumerate(days)}
    params = full_params(fits, vix, vvix, spx, {"2023-12-29": 5.0})
    return fits, params, vix, vvix, spx


def test_export_writes_strict_json(tmp_path):
    fits, params, vix, vvix, spx = _inputs()
    latest = export(fits, params, vix, vvix, spx, tmp_path)
    hist = json.loads((tmp_path / "history.json").read_text())
    assert hist["dates"] == sorted(params)
    keys = ("dates", "v0", "kappa", "theta", "xi", "rho", "r", "p_down10_1m", "p_up10_1m", "approx")
    assert len({len(hist[k]) for k in keys}) == 1
    assert all(0 <= p <= 1 for p in hist["p_down10_1m"] + hist["p_up10_1m"])
    assert json.loads((tmp_path / "latest.json").read_text()) == latest
    assert latest["rho_source"] == "default"          # too little history for a realized rho
    assert latest["spx"]["level"] == pytest.approx(5045.0)    # 5000 * (1 + 0.001 * 9)
    assert latest["r"] == 0.05
    assert json.loads((tmp_path / "events.json").read_text())["events"] == []


def test_export_is_deterministic(tmp_path):
    fits, params, vix, vvix, spx = _inputs()
    export(fits, params, vix, vvix, spx, tmp_path / "a")
    export(fits, params, vix, vvix, spx, tmp_path / "b")
    for name in ("history.json", "latest.json", "events.json"):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()
