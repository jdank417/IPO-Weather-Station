"""Write the static JSON the site reads (site/data/). Never hand-edit the output."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from pipeline.calibrate_term_structure import HORIZON_DAYS, HORIZONS, TENORS, DayFit, model_vix

SITE_DATA = Path(__file__).resolve().parent.parent / "site" / "data"
SOURCE = "Cboe Global Markets daily index histories (VIX9D, VIX, VIX3M, VIX6M, SKEW); fits by IPO Weather Station"
SCHEMA_VERSION = 1


def _r(x: float | None, sig: int = 6) -> float | None:
    if x is None or not math.isfinite(x):
        return None
    return float(f"{x:.{sig}g}")


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8")


def history_payload(fits: list[DayFit]) -> dict:
    """Columnar daily fit history: derived parameters, fit quality and flags only."""
    return {
        "schema": SCHEMA_VERSION,
        "source": SOURCE,
        "units": {"v0": "annualized variance", "theta": "annualized variance", "kappa": "per year", "rmse_volpts": "VIX points"},
        "dates": [f.date for f in fits],
        "v0": [_r(f.v0) for f in fits],
        "kappa": [_r(f.kappa) for f in fits],
        "theta": [_r(f.theta) for f in fits],
        "rmse_volpts": [_r(f.rmse_volpts, 4) for f in fits],
        "n_points": [f.n_points for f in fits],
        "flags": [f.flags for f in fits],
    }


def latest_payload(fits: list[DayFit], table: dict[str, dict[str, float]], skew: dict[str, float]) -> dict:
    """Latest good fit, its observed points, and a sampled fitted curve."""
    good = [f for f in fits if f.ok]
    if not good:
        raise RuntimeError("no successful fit to export")
    f = good[-1]
    quotes = table[f.date]
    curve_days = np.unique(np.concatenate([np.linspace(1, 365, 73), list(HORIZON_DAYS.values())]))
    curve = model_vix(curve_days / 365.0, f.v0, f.kappa, f.theta)
    skew_date = max(d for d in skew if d <= f.date) if any(d <= f.date for d in skew) else None
    return {
        "schema": SCHEMA_VERSION,
        "source": SOURCE,
        "date": f.date,
        "latest_data_date": fits[-1].date,  # differs from "date" if the newest day could not be fitted
        "params": {"v0": _r(f.v0), "kappa": _r(f.kappa), "theta": _r(f.theta)},
        "note": "xi and rho are not identified by the VIX term structure; the site uses user-set defaults.",
        "fit": {"rmse_volpts": _r(f.rmse_volpts, 4), "flags": f.flags, "n_points": f.n_points},
        "points": [
            {"symbol": t, "days": HORIZON_DAYS[t], "T": _r(HORIZONS[t]), "level": _r(quotes[t]),
             "fitted": _r(float(model_vix(HORIZONS[t], f.v0, f.kappa, f.theta))),
             "residual_volpts": _r(f.residuals_volpts[t], 4)}
            for t in TENORS if t in f.residuals_volpts
        ],
        "curve": {"days": [_r(float(d), 5) for d in curve_days], "level": [_r(float(v), 5) for v in curve]},
        "skew": None if skew_date is None else {"date": skew_date, "level": _r(skew[skew_date])},
    }


def export(fits: list[DayFit], table: dict[str, dict[str, float]], skew: dict[str, float], out_dir: Path = SITE_DATA) -> dict:
    """Write vix_fits.json and latest.json. Output is deterministic so unchanged data makes no commit."""
    latest = latest_payload(fits, table, skew)
    _write(out_dir / "vix_fits.json", history_payload(fits))
    _write(out_dir / "latest.json", latest)
    return latest
