"""Daily entry point: fetch Cboe histories, calibrate every day, export JSON.

    python -m pipeline.update            # download fresh CSVs
    python -m pipeline.update --offline  # reuse data/cache/
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from pipeline.calibrate_term_structure import MIN_POINTS, build_table, calibrate_history
from pipeline.export_json import SITE_DATA, export
from pipeline.fetch_cboe import DEFAULT_CACHE, load_all


def main() -> None:
    ap = argparse.ArgumentParser(description="Fetch, calibrate and export the VIX term-structure fits.")
    ap.add_argument("--offline", action="store_true", help="use cached CSVs instead of downloading")
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--out-dir", type=Path, default=SITE_DATA)
    args = ap.parse_args()

    series, problems = load_all(args.cache_dir, refresh=not args.offline)
    for sym, probs in problems.items():
        for p in probs:
            print(f"warning: {sym} {p}")

    table = build_table(series)
    # Before VIX3M exists (2009-09-18) only VIX and VIX6M are available: too few
    # horizons for three parameters. Start the exported history at the first fittable day.
    start = min(d for d, q in table.items() if len(q) >= MIN_POINTS)
    fits = calibrate_history(table, start=start)
    latest = export(fits, table, series["SKEW"], args.out_dir)

    flag_counts = Counter(fl.split(":")[0] for f in fits for fl in f.flags)
    print(f"fitted {sum(f.ok for f in fits)}/{len(fits)} days, {fits[0].date} .. {fits[-1].date}")
    print("flag counts:", dict(sorted(flag_counts.items())))
    print("latest:", latest["date"], latest["params"], latest["fit"])


if __name__ == "__main__":
    main()
