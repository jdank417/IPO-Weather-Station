"""Download FRED series.

Uses the FRED API when the ``FRED_API_KEY`` environment variable is set (a
GitHub Actions secret), otherwise FRED's public ``fredgraph.csv`` download,
which needs no key. Files are cached under ``data/cache/`` (git-ignored).
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipeline.fetch_cboe import DEFAULT_CACHE

SERIES = {
    "DTB3": "3-month Treasury bill rate, secondary market (daily, %)",
}

CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
API_URL = "https://api.stlouisfed.org/fred/series/observations?{query}"


def _get(url: str, retries: int = 4) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ipo-weather-station/1.0"})
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except OSError:
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def parse_csv(text: str) -> dict[str, float]:
    """Parse fredgraph CSV (``observation_date,SERIES``); '.' and blanks are missing."""
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if not lines or not lines[0].lower().startswith(("observation_date", "date")):
        raise ValueError(f"unexpected FRED CSV header: {lines[:1]!r}")
    out: dict[str, float] = {}
    for ln in lines[1:]:
        day, _, val = ln.partition(",")
        try:
            v = float(val)
        except ValueError:
            continue
        if math.isfinite(v):
            out[day] = v
    return out


def download(series: str, cache_dir: Path = DEFAULT_CACHE) -> dict[str, float]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        query = urllib.parse.urlencode({"series_id": series, "api_key": key, "file_type": "json"})
        obs = json.loads(_get(API_URL.format(query=query)))["observations"]
        text = "observation_date," + series + "\n" + "\n".join(f"{o['date']},{o['value']}" for o in obs)
    else:
        text = _get(CSV_URL.format(series=series)).decode("utf-8-sig")
    values = parse_csv(text)  # validate before caching
    (cache_dir / f"FRED_{series}.csv").write_text(text, encoding="utf-8")
    return values


def load_all(cache_dir: Path = DEFAULT_CACHE, refresh: bool = True) -> dict[str, dict[str, float]]:
    out = {}
    for s in SERIES:
        path = cache_dir / f"FRED_{s}.csv"
        out[s] = download(s, cache_dir) if refresh or not path.exists() else parse_csv(path.read_text(encoding="utf-8"))
    return out
