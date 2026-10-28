"""Two-regime Markov-switching model of IPO activity with time-varying
transition probabilities (Diebold, Lee & Weinbach 1994; Filardo 1994).

    y_t = log(1 + net IPOs in month t) ~ N(mu_{S_t}, sigma^2)
    P(S_t = hot | S_{t-1} = j) = logistic(gamma_j' [1, z_{t-1}])

z_{t-1} are last month's standardized covariates, so this month's conditions
drive next month's regime. Estimated by maximum likelihood with statsmodels'
MarkovRegression (exog_tvtp). Exports site/data/regime.json, which the
browser filters forward (site/js/regime.js). See docs/regime_model.rst.

    python -m pipeline.fit_ipo_regimes [--fixture]
"""

from __future__ import annotations

import argparse
import json
import math
import warnings
from pathlib import Path

import numpy as np
import statsmodels.api as sm

from pipeline import fetch_fred
from pipeline.calibrate_term_structure import DayFit
from pipeline.export_json import SITE_DATA, _r, _write
from pipeline.fetch_cboe import DEFAULT_CACHE
from pipeline.fetch_cboe import load_all as load_cboe
from pipeline.load_ritter import load as load_ritter
from pipeline.monthly import build_monthly

SPEC = ("vol1y", "skew", "be5")
ALTERNATIVES = {
    "constant transitions": (),
    "vol": ("vol1y",),
    "vol + SKEW": ("vol1y", "skew"),
    "vol + SKEW + 5y breakeven (used)": SPEC,
    "vol + SKEW + 10y real yield": ("vol1y", "skew", "ry10"),
    "spot vol + long-run vol + SKEW + 5y breakeven": ("spot_vol", "long_vol", "skew", "be5"),
}
LABELS = {
    "vol1y": "1-year expected vol (%)", "spot_vol": "spot vol (%)", "long_vol": "long-run vol (%)",
    "skew": "Cboe SKEW", "be5": "5y breakeven inflation (%)", "ry10": "10y real yield (%)",
    "cpi_yoy": "CPI inflation, y/y (%)", "kappa": "kappa",
}
FIRST_MONTH = "2009-10"   # first full month with a three-horizon VIX fit
N_SEEDS = 4
SEARCH_REPS = 40
N_DRAWS = 300


def next_month(m: str) -> str:
    y, mm = int(m[:4]), int(m[5:])
    return f"{y + (mm == 12):04d}-{mm % 12 + 1:02d}"


def fits_from_json(path: Path = SITE_DATA / "vix_fits.json") -> list[DayFit]:
    h = json.loads(path.read_text())
    return [DayFit(date=d, n_points=n, tenors=[], v0=v, kappa=k, theta=t, flags=fl)
            for d, v, k, t, n, fl in zip(h["dates"], h["v0"], h["kappa"], h["theta"], h["n_points"], h["flags"])]


def build_sample(panel: dict, ipo: dict, cols: tuple[str, ...]):
    """In-sample rows (month t with IPO data, covariates from month t-1)."""
    months, prevs = [], []
    for prev in sorted(panel):
        m = next_month(prev)
        if prev < FIRST_MONTH or m not in ipo or ipo[m].net is None:
            continue
        if any(panel[prev].get(c) is None for c in cols):
            continue
        months.append(m)
        prevs.append(prev)
    y = np.array([math.log1p(ipo[m].net) for m in months])
    Z = np.array([[panel[p][c] for c in cols] for p in prevs], float).reshape(len(prevs), len(cols))
    return months, prevs, y, Z


def fit_best(y: np.ndarray, X: np.ndarray, seeds=range(N_SEEDS), search_reps=SEARCH_REPS):
    """Best valid MLE over several random-search seeds (finite, nonzero SEs)."""
    best = None
    for seed in seeds:
        np.random.seed(seed)
        model = sm.tsa.MarkovRegression(y, k_regimes=2, exog_tvtp=X, switching_variance=False)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                res = model.fit(disp=False, search_reps=search_reps)
            except (ValueError, np.linalg.LinAlgError):
                continue
            bse = np.asarray(res.bse)
        if not np.all(np.isfinite(bse)) or np.any(bse <= 0):
            continue
        if best is None or res.llf > best.llf:
            best = res
    if best is None:
        raise RuntimeError("no valid Markov-switching fit")
    return best


def to_gauge_params(param_names: list[str], params: np.ndarray, k_cov: int) -> dict:
    """Map statsmodels parameters to the browser's hot/cold parametrization.

    statsmodels: P(S_t = 0 | S_{t-1} = j) = logistic(beta_j' x).
    Export:      P(S_t = hot | S_{t-1} = s) = logistic(gamma_s' x) for s in {cold, hot}.
    """
    p = dict(zip(param_names, params))
    mu = np.array([p["const[0]"], p["const[1]"]])
    hot = int(np.argmax(mu))
    cold = 1 - hot
    beta = {j: np.array([p[f"p[{j}->0].tvtp{c}"] for c in range(k_cov + 1)]) for j in (0, 1)}
    sign = 1.0 if hot == 0 else -1.0     # P(hot) = logistic(+beta) if hot is regime 0, else logistic(-beta)
    return {
        "mu": {"cold": float(mu[cold]), "hot": float(mu[hot])},
        "sigma": float(math.sqrt(p["sigma2"])) if p["sigma2"] > 0 else float("nan"),
        "gamma": {"cold": (sign * beta[cold]).tolist(), "hot": (sign * beta[hot]).tolist()},
        "hot_regime_index": hot,
    }


def logistic(x):
    return 1.0 / (1.0 + np.exp(-x))


def hamilton_filter(y, X, g):
    """Filtered P(hot) for the exported parametrization (mirrors site/js/regime.js)."""
    mu = np.array([g["mu"]["cold"], g["mu"]["hot"]])
    gc, gh = np.array(g["gamma"]["cold"]), np.array(g["gamma"]["hot"])

    def trans(x):
        a, b = logistic(x @ gc), logistic(x @ gh)    # P(hot | cold), P(hot | hot)
        return np.array([[1 - a, 1 - b], [a, b]])    # [to, from]

    P0 = trans(X[0])
    # steady state of the first transition matrix (statsmodels' initialization)
    a, b = P0[1, 0], P0[0, 1]
    p = np.array([b / (a + b), a / (a + b)])
    out, ll = [], 0.0
    for t in range(len(y)):
        if t > 0:
            p = trans(X[t]) @ p
        dens = np.exp(-0.5 * ((y[t] - mu) / g["sigma"]) ** 2) / (g["sigma"] * math.sqrt(2 * math.pi))
        f = p * dens
        ll += math.log(f.sum())
        p = f / f.sum()
        out.append(p[1])
    return np.array(out), ll, p


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="use cached FRED/Cboe CSVs")
    ap.add_argument("--out-dir", type=Path, default=SITE_DATA)
    ap.add_argument("--fixture", type=Path, default=None, help="also write a JS test fixture here")
    ap.add_argument("--compare", action="store_true", help="refit the alternative specifications")
    args = ap.parse_args()

    fits = fits_from_json(args.out_dir / "vix_fits.json")
    # the daily job downloads the Cboe CSVs in pipeline.update just before this runs
    cboe, _ = load_cboe(DEFAULT_CACHE, refresh=False)
    fred = fetch_fred.load_all(DEFAULT_CACHE, refresh=not args.offline)
    panel = build_monthly(fits, cboe["SKEW"], fred)
    ritter = load_ritter()
    ipo = {r.month: r for r in ritter}

    months, prevs, y, Z = build_sample(panel, ipo, SPEC)
    z_mean, z_sd = Z.mean(axis=0), Z.std(axis=0, ddof=0)
    X = np.column_stack([np.ones(len(y)), (Z - z_mean) / z_sd])
    res = fit_best(y, X)
    names = list(res.model.param_names)
    params, cov = np.asarray(res.params), np.asarray(res.cov_params())
    g = to_gauge_params(names, params, len(SPEC))

    # our filter must reproduce statsmodels exactly before anything is exported
    filt, ll, p_last = hamilton_filter(y, X, g)
    sm_filt = np.asarray(res.filtered_marginal_probabilities)[:, g["hot_regime_index"]]
    assert np.max(np.abs(filt - sm_filt)) < 1e-8 and abs(ll - res.llf) < 1e-6, "filter mismatch with statsmodels"
    smooth = np.asarray(res.smoothed_marginal_probabilities)[:, g["hot_regime_index"]]

    # parameter draws from the asymptotic normal for uncertainty bands
    rng = np.random.default_rng(20251231)
    draws = []
    for v in rng.multivariate_normal(params, cov, size=N_DRAWS * 2, method="eigh"):
        d = to_gauge_params(names, v, len(SPEC))
        if math.isfinite(d["sigma"]) and d["hot_regime_index"] == g["hot_regime_index"]:
            draws.append(d)
        if len(draws) == N_DRAWS:
            break

    # months after the sample with covariates: filtered forward without IPO data
    last = months[-1]
    forward = []
    m = last
    while m in panel and all(panel[m].get(c) is not None for c in SPEC):
        forward.append(m)
        m = next_month(m)
    # forward[0] is the last in-sample month; its covariates drive the first out-of-sample transition

    comparison = None
    if args.compare:
        comparison = []
        for label, cols in ALTERNATIVES.items():
            mm, _, yy, ZZ = build_sample(panel, ipo, cols)
            XX = np.column_stack([np.ones(len(yy))] + ([((ZZ - ZZ.mean(0)) / ZZ.std(0))] if cols else []))
            try:
                rr = fit_best(yy, XX)
                comparison.append({"spec": label, "n": len(yy), "k": len(rr.params), "llf": _r(rr.llf, 6),
                                   "aic": _r(rr.aic, 6), "bic": _r(rr.bic, 6)})
            except RuntimeError:
                comparison.append({"spec": label, "n": len(yy), "k": None, "llf": None, "aic": None, "bic": None})
    else:
        prev_file = args.out_dir / "regime.json"
        if prev_file.exists():
            comparison = json.loads(prev_file.read_text()).get("comparison")

    se = dict(zip(names, np.asarray(res.bse)))
    hot_i = g["hot_regime_index"]
    sign = 1.0 if hot_i == 0 else -1.0
    coef_table = []
    for s_name, j in (("cold", 1 - hot_i), ("hot", hot_i)):
        for c, cname in enumerate(("const",) + SPEC):
            key = f"p[{j}->0].tvtp{c}"
            coef_table.append({"from": s_name, "covariate": cname, "gamma": _r(sign * params[names.index(key)]), "se": _r(se[key])})

    out = {
        "schema": 1,
        "description": "Two-regime Markov-switching model of log(1 + monthly net IPOs) with logistic time-varying transition probabilities",
        "sources": {
            "ipo": "Jay R. Ritter, IPOALL.xlsx (net IPO counts), University of Florida",
            "vol": "Heston fits to the Cboe VIX term structure (this site)",
            "skew": "Cboe SKEW index, monthly mean",
            "inflation": "FRED: T5YIE (5-year breakeven inflation), monthly mean",
        },
        "sample": {"first": months[0], "last": last, "n": len(y), "ritter_vintage": ritter[-1].month},
        "covariates": [{"key": c, "label": LABELS[c], "mean": _r(float(mu_), 8), "sd": _r(float(sd_), 8)}
                       for c, mu_, sd_ in zip(SPEC, z_mean, z_sd)],
        "covariate_lag_months": 1,
        "params": {
            "mu": {k: _r(v, 10) for k, v in g["mu"].items()},
            "sigma": _r(g["sigma"], 10),
            "gamma": {k: [_r(x, 10) for x in v] for k, v in g["gamma"].items()},
        },
        "loglik": _r(res.llf, 10), "aic": _r(res.aic, 8), "bic": _r(res.bic, 8),
        "coefficients": coef_table,
        "regime_means_ipos_per_month": {"cold": _r(math.expm1(g["mu"]["cold"]), 4), "hot": _r(math.expm1(g["mu"]["hot"]), 4)},
        "history": {
            "months": months,
            "y": [_r(v, 10) for v in y],
            "net_ipos": [ipo[m].net for m in months],
            "z": [[_r(v, 10) for v in row] for row in X[:, 1:]],
            "p_hot_filtered": [_r(v, 6) for v in filt],
            "p_hot_smoothed": [_r(v, 6) for v in smooth],
        },
        "forward": {
            "months": forward,
            "x": [[_r(panel[m][c], 8) for c in SPEC] for m in forward],
        },
        "last_filtered": {"month": last, "p_hot": _r(float(p_last[1]), 10)},
        # latest daily values: the gauge's "today" defaults for the non-surface covariates
        "latest_inputs": {
            "skew": {"date": max(cboe["SKEW"]), "value": _r(cboe["SKEW"][max(cboe["SKEW"])], 6)},
            "be5": {"date": max(fred["T5YIE"]), "value": _r(fred["T5YIE"][max(fred["T5YIE"])], 6)},
        },
        "draws": [{"mu": [_r(d["mu"]["cold"], 8), _r(d["mu"]["hot"], 8)], "sigma": _r(d["sigma"], 8),
                   "gamma_cold": [_r(x, 8) for x in d["gamma"]["cold"]], "gamma_hot": [_r(x, 8) for x in d["gamma"]["hot"]]}
                  for d in draws],
        "comparison": comparison,
    }
    _write(args.out_dir / "regime.json", out)

    monthly = {"schema": 1, "months": sorted(panel), "fields": list(panel[next(iter(panel))].keys())}
    for f in monthly["fields"]:
        monthly[f] = [_r(panel[m][f], 6) if isinstance(panel[m][f], float) else panel[m][f] for m in monthly["months"]]
    _write(args.out_dir / "monthly.json", monthly)

    if args.fixture:
        args.fixture.parent.mkdir(parents=True, exist_ok=True)
        args.fixture.write_text(json.dumps({
            "params": out["params"], "y": y.tolist(), "z": X[:, 1:].tolist(),
            "statsmodels_filtered_p_hot": sm_filt.tolist(), "statsmodels_llf": res.llf,
        }) + "\n")

    print(f"sample {months[0]}..{last} n={len(y)}  llf {res.llf:.2f}  BIC {res.bic:.2f}")
    print("regime means (IPOs/month):", out["regime_means_ipos_per_month"])
    print(f"last filtered P(hot) {p_last[1]:.3f} ({last}); forward months {forward[0]}..{forward[-1]}; draws {len(draws)}")
    for row in coef_table:
        print(f"  from {row['from']:4s} {row['covariate']:6s} {row['gamma']:8.3f} ({row['se']:.3f})")


if __name__ == "__main__":
    main()
