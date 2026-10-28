"""Write the static JSON the site reads (site/data/). Never hand-edit the output.

Only derived quantities are published: model parameters, model odds, and a
handful of single latest-day readings. Raw Cboe histories stay in data/cache/.
"""

from __future__ import annotations

import json
import math
from bisect import bisect_right
from pathlib import Path

import numpy as np

from pipeline.calibrate_term_structure import DayFit
from pipeline.events import event_stats
from pipeline.odds import cos_cdf

SITE_DATA = Path(__file__).resolve().parent.parent / "site" / "data"
SOURCE = ("Model fits to Cboe Global Markets index data (VIX9D, VIX, VIX3M, VIX6M, VVIX, SPX) "
          "and FRED (DTB3); computed by Market Weather Station")
SCHEMA_VERSION = 2
ONE_MONTH = 30 / 365
PARAM_KEYS = ("v0", "kappa", "theta", "xi", "rho")


def _r(x: float | None, sig: int = 6) -> float | None:
    if x is None or not math.isfinite(x):
        return None
    return float(f"{x:.{sig}g}")


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8")


def month_odds(p: dict) -> tuple[float, float]:
    """P(S&P 10%+ lower) and P(10%+ higher) one month ahead."""
    args = tuple(p[k] for k in PARAM_KEYS)
    lo, hi = cos_cdf([math.log(0.9), math.log(1.1)], ONE_MONTH, *args, r=p["r"], q=p["q"], N=1024)
    return float(lo), float(1.0 - hi)


def history_payload(params: dict[str, dict]) -> dict:
    dates = sorted(params)
    odds = [month_odds(params[d]) for d in dates]
    return {
        "schema": SCHEMA_VERSION,
        "source": SOURCE,
        "q": params[dates[-1]]["q"],
        "dates": dates,
        **{k: [_r(params[d][k]) for d in dates] for k in PARAM_KEYS},
        "r": [_r(params[d]["r"], 4) for d in dates],
        "p_down10_1m": [_r(o[0], 4) for o in odds],
        "p_up10_1m": [_r(o[1], 4) for o in odds],
        "approx": [1 if params[d]["approx"] else 0 for d in dates],
    }


def percentile_rank(values: list[float], x: float) -> float:
    s = sorted(values)
    return bisect_right(s, x) / len(s)


def latest_payload(params: dict[str, dict], fits_by_date: dict[str, DayFit], vix: dict[str, float],
                   vvix: dict[str, float], spx: dict[str, float]) -> dict:
    date = max(params)
    p = params[date]
    f = fits_by_date[date]
    spx_date = max(d for d in spx if d <= date)
    return {
        "schema": SCHEMA_VERSION,
        "source": SOURCE,
        "date": date,
        "latest_data_date": max(fits_by_date),   # differs from "date" if the newest day could not be used
        "params": {k: _r(p[k]) for k in PARAM_KEYS},
        "rho_source": p["rho_source"],
        "approx": p["approx"],
        "r": _r(p["r"], 4), "q": p["q"],
        "spx": {"date": spx_date, "level": _r(spx[spx_date], 7)},
        "vix": _r(vix[date], 5),
        "vvix": _r(vvix[date], 5),
        "vix_percentile": _r(percentile_rank(list(vix.values()), vix[date]), 3),
        "vix_since": min(vix),
        "fit": {"rmse_volpts": _r(f.rmse_volpts, 4), "flags": f.flags, "n_points": f.n_points},
    }


def export(fits: list[DayFit], params: dict[str, dict], vix: dict[str, float], vvix: dict[str, float],
           spx: dict[str, float], out_dir: Path = SITE_DATA) -> dict:
    """Write latest.json, history.json and events.json. Output is deterministic."""
    fits_by_date = {f.date: f for f in fits}
    latest = latest_payload(params, fits_by_date, vix, vvix, spx)
    history = history_payload(params)
    events = event_stats(history, vix, spx)
    _write(out_dir / "latest.json", latest)
    _write(out_dir / "history.json", history)
    _write(out_dir / "events.json", {"schema": SCHEMA_VERSION, "events": [
        {k: (_r(v, 4) if isinstance(v, float) else v) for k, v in e.items()} for e in events]})
    return latest
