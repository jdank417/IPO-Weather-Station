"""Market stress episodes for the replay tab.

Titles and one-line descriptions are written by hand; every number shown with
an event (peak VIX, S&P 500 drawdown, peak model odds) is computed from the
data inside the event window.
"""

from __future__ import annotations

EVENTS = [
    {"id": "downgrade-2011", "title": "US credit downgrade", "start": "2011-07-15", "end": "2011-10-14",
     "blurb": "S&P cut the US government's AAA credit rating on August 5, 2011, in the middle of the euro-area debt crisis."},
    {"id": "china-2015", "title": "China devaluation", "start": "2015-07-20", "end": "2015-10-15",
     "blurb": "China devalued the yuan on August 11, 2015; global stocks slid and US markets had a chaotic open on August 24."},
    {"id": "volmageddon-2018", "title": "Volmageddon", "start": "2018-01-16", "end": "2018-03-15",
     "blurb": "On February 5, 2018 the VIX more than doubled in a single day, wiping out funds that had bet on calm markets."},
    {"id": "q4-2018", "title": "Christmas Eve selloff", "start": "2018-09-20", "end": "2019-01-31",
     "blurb": "Rising interest rates and trade-war worries drove a slide through the end of 2018 that bottomed on Christmas Eve."},
    {"id": "covid-2020", "title": "COVID-19 crash", "start": "2020-02-10", "end": "2020-06-15",
     "blurb": "As the pandemic spread in February and March 2020, the S&P 500 had its fastest fall into a bear market on record."},
    {"id": "rates-2022", "title": "Rate shock", "start": "2021-12-15", "end": "2022-11-15",
     "blurb": "The Federal Reserve raised rates at the fastest pace in decades to fight inflation, and stocks fell through most of the year."},
    {"id": "yen-2024", "title": "Yen carry-trade unwind", "start": "2024-07-10", "end": "2024-09-13",
     "blurb": "A Bank of Japan rate hike and weak US jobs data triggered a global selloff that peaked on August 5, 2024."},
    {"id": "tariffs-2025", "title": "Tariff shock", "start": "2025-03-14", "end": "2025-05-30",
     "blurb": "Sweeping US tariffs announced on April 2, 2025 set off one of the sharpest two-day drops in the S&P 500's history."},
]


def max_drawdown(levels: list[tuple[str, float]]) -> tuple[float, str | None, str | None]:
    """Largest peak-to-trough fall (as a negative fraction) and its dates."""
    peak, peak_d = None, None
    worst, w_from, w_to = 0.0, None, None
    for d, x in levels:
        if peak is None or x > peak:
            peak, peak_d = x, d
        dd = x / peak - 1.0
        if dd < worst:
            worst, w_from, w_to = dd, peak_d, d
    return worst, w_from, w_to


def event_stats(history: dict, vix: dict[str, float], spx: dict[str, float]) -> list[dict]:
    dates = history["dates"]
    out = []
    for ev in EVENTS:
        idx = [i for i, d in enumerate(dates) if ev["start"] <= d <= ev["end"]]
        if not idx:
            continue
        p = [(history["p_down10_1m"][i], dates[i]) for i in idx]
        peak_p, peak_p_date = max(p)
        vix_in = [(v, d) for d, v in vix.items() if ev["start"] <= d <= ev["end"]]
        spx_in = sorted((d, v) for d, v in spx.items() if ev["start"] <= d <= ev["end"])
        dd, dd_from, dd_to = max_drawdown(spx_in)
        out.append({
            **ev,
            "first_index": idx[0], "last_index": idx[-1],
            "peak_down10_1m": peak_p, "peak_down10_1m_date": peak_p_date,
            "peak_vix": max(vix_in)[0] if vix_in else None,
            "peak_vix_date": max(vix_in)[1] if vix_in else None,
            "spx_drawdown": dd, "drawdown_from": dd_from, "drawdown_to": dd_to,
        })
    return out
