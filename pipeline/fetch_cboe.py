"""Download and parse Cboe daily index histories (VIX family, VVIX, SPX).

Source: Cboe's published "daily_prices" CSVs (the files linked from
https://www.cboe.com/tradable_products/vix/vix_historical_data/). The CSVs are
cached locally under ``data/cache/`` and are *not* committed: Cboe's website
terms restrict republishing its data, so the site only ships derived values
plus a few latest-day readings. See docs/data_sources.rst.
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import time
import urllib.request
from pathlib import Path

URL = "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/{symbol}_History.csv"

# symbol -> CSV column holding the daily closing level
SERIES = {
    "VIX9D": "CLOSE",
    "VIX": "CLOSE",
    "VIX3M": "CLOSE",
    "VIX6M": "CLOSE",
    "VVIX": "VVIX",   # volatility of VIX: pins down Heston's vol of vol
    "SPX": "SPX",     # S&P 500 level: realized correlation and today's level
}

DEFAULT_CACHE = Path(__file__).resolve().parent.parent / "data" / "cache"


class CboeFormatError(ValueError):
    """The downloaded file does not look like a Cboe history CSV."""


def download(symbol: str, cache_dir: Path, retries: int = 4) -> Path:
    """Fetch one history CSV into ``cache_dir`` and return its path."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / f"{symbol}_History.csv"
    req = urllib.request.Request(
        URL.format(symbol=symbol),
        headers={"User-Agent": "ipo-weather-station/1.0 (+github.com/jdank417/IPO-Weather-Station)"},
    )
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
            break
        except OSError:
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
    text = body.decode("utf-8-sig")
    parse_history(text, SERIES[symbol])  # validate before overwriting the cache
    dest.write_text(text, encoding="utf-8")
    return dest


def parse_history(text: str, column: str) -> tuple[dict[str, float], list[str]]:
    """Parse a Cboe history CSV.

    Returns ``(values, problems)`` where ``values`` maps ISO date -> level and
    ``problems`` lists rows that were present but unusable (blank, non-numeric,
    non-positive). Unusable rows are reported, never silently coerced.
    """
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if not lines:
        raise CboeFormatError("empty file")
    header = [h.strip().upper() for h in lines[0].split(",")]
    if not header or header[0] != "DATE" or column not in header:
        raise CboeFormatError(f"unexpected header {header!r}, need DATE and {column}")
    col = header.index(column)

    values: dict[str, float] = {}
    problems: list[str] = []
    for ln in lines[1:]:
        cells = [c.strip() for c in ln.split(",")]
        try:
            day = dt.datetime.strptime(cells[0], "%m/%d/%Y").date().isoformat()
        except (ValueError, IndexError):
            problems.append(f"bad date: {ln!r}")
            continue
        try:
            v = float(cells[col])
        except (ValueError, IndexError):
            problems.append(f"{day}: missing/non-numeric {column}")
            continue
        if not math.isfinite(v) or v <= 0:
            problems.append(f"{day}: non-positive {column}={v}")
            continue
        values[day] = v
    if not values:
        raise CboeFormatError("no usable rows")
    return values, problems


def load_all(cache_dir: Path = DEFAULT_CACHE, refresh: bool = True) -> tuple[dict[str, dict[str, float]], dict[str, list[str]]]:
    """Return ``({symbol: {date: level}}, {symbol: problems})``."""
    series: dict[str, dict[str, float]] = {}
    problems: dict[str, list[str]] = {}
    for symbol, column in SERIES.items():
        path = cache_dir / f"{symbol}_History.csv"
        if refresh or not path.exists():
            path = download(symbol, cache_dir)
        series[symbol], problems[symbol] = parse_history(path.read_text(encoding="utf-8"), column)
    return series, problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    args = ap.parse_args()
    series, problems = load_all(args.cache_dir, refresh=True)
    for sym, vals in series.items():
        dates = sorted(vals)
        print(f"{sym:6s} {len(vals):6d} rows  {dates[0]} .. {dates[-1]}  problems={len(problems[sym])}")


if __name__ == "__main__":
    main()
