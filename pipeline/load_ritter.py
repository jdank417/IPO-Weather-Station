"""Parse Jay Ritter's monthly IPO file (IPOALL.xlsx).

Source: Jay R. Ritter, University of Florida, "Monthly Number of IPOs and the
Average First-Day Return", https://site.warrington.ufl.edu/ritter/ipo-data/
(file https://site.warrington.ufl.edu/ritter/files/IPOALL.xlsx). Saved
manually to data/raw/IPOALL.xlsx; see docs/data_sources.rst for the vintage.

Columns (per the file's own notes): month, 2-digit year, average first-day
return on net IPOs (%), gross count, net count (excludes SPACs, direct
listings, penny stocks, units, closed-end funds, REITs, ADRs, banks and S&Ls,
and others), and % of IPOs priced above the original file-range midpoint.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import openpyxl

RAW = Path(__file__).resolve().parent.parent / "data" / "raw" / "IPOALL.xlsx"


@dataclass
class IpoMonth:
    month: str               # YYYY-MM
    gross: int
    net: int | None          # None where not reported (before 1975)
    first_day_return: float | None   # % ; None when no net IPOs ('na' / '.')
    pct_above_mid: float | None


def _num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).strip()
    try:
        return float(s)
    except ValueError:
        return None  # 'na', '.', 'see 1975', ...


def load(path: Path = RAW) -> list[IpoMonth]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows: list[IpoMonth] = []
    for r in ws.iter_rows(values_only=True):
        m, y = _num(r[0]), _num(r[1])
        if m is None or y is None or not (1 <= m <= 12) or m != int(m):
            continue
        y = int(y)
        year = y if y >= 100 else (1900 + y if y >= 60 else 2000 + y)
        gross = _num(r[3])
        if gross is None:
            continue
        net = _num(r[4])
        rows.append(IpoMonth(
            month=f"{year:04d}-{int(m):02d}",
            gross=int(gross),
            net=None if net is None else int(net),
            first_day_return=_num(r[2]),
            pct_above_mid=_num(r[5]),
        ))
    months = [x.month for x in rows]
    if months != sorted(months) or len(set(months)) != len(months):
        raise ValueError("Ritter file months are not strictly increasing")
    return rows
