"""Daily entry point: fetch data, calibrate every day, export JSON.

    python -m pipeline.update            # download fresh CSVs
    python -m pipeline.update --offline  # reuse data/cache/
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from pipeline import fetch_fred
from pipeline.calibrate_term_structure import MIN_POINTS, build_table, calibrate_history
from pipeline.export_json import SITE_DATA, export
from pipeline.fetch_cboe import DEFAULT_CACHE, load_all
from pipeline.full_params import full_params


def main() -> None:
    ap = argparse.ArgumentParser(description="Fetch, calibrate and export the daily market odds data.")
    ap.add_argument("--offline", action="store_true", help="use cached CSVs instead of downloading")
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--out-dir", type=Path, default=SITE_DATA)
    args = ap.parse_args()

    series, problems = load_all(args.cache_dir, refresh=not args.offline)
    for sym, probs in problems.items():
        for p in probs:
            print(f"warning: {sym} {p}")
    fred = fetch_fred.load_all(args.cache_dir, refresh=not args.offline)

    table = build_table(series)
    # Before VIX3M exists (2009-09-18) only VIX and VIX6M are available: too few
    # horizons for three parameters. Start the history at the first fittable day.
    start = min(d for d, q in table.items() if len(q) >= MIN_POINTS)
    fits = calibrate_history(table, start=start)
    params = full_params(fits, series["VIX"], series["VVIX"], series["SPX"], fred["DTB3"])
    latest = export(fits, params, series["VIX"], series["VVIX"], series["SPX"], args.out_dir)

    flag_counts = Counter(fl.split(":")[0] for f in fits for fl in f.flags)
    print(f"fitted {sum(f.ok for f in fits)}/{len(fits)} days, {fits[0].date} .. {fits[-1].date}; "
          f"{len(params)} days with all five parameters")
    print("flag counts:", dict(sorted(flag_counts.items())))
    print("latest:", latest["date"], latest["params"], "r", latest["r"], "rho", latest["rho_source"])


if __name__ == "__main__":
    main()
