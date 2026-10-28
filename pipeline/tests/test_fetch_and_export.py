import json

import pytest

from pipeline.calibrate_term_structure import HORIZONS, TENORS, build_table, calibrate_history, model_vix
from pipeline.export_json import export
from pipeline.fetch_cboe import CboeFormatError, parse_history

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


def test_parse_skew_layout():
    values, problems = parse_history("DATE,SKEW\n01/02/1990,126.09\n", "SKEW")
    assert values == {"1990-01-02": 126.09} and problems == []


@pytest.mark.parametrize("text", ["", "<html>redirect</html>", "DATE,OPEN\n01/02/2024,1\n"])
def test_parse_rejects_wrong_format(text):
    with pytest.raises(CboeFormatError):
        parse_history(text, "CLOSE")


def _synthetic_series():
    series = {t: {} for t in TENORS}
    for i, day in enumerate(["2024-01-02", "2024-01-03", "2024-01-04"]):
        for t in TENORS:
            series[t][day] = float(model_vix(HORIZONS[t], 0.02 + 0.002 * i, 2.0, 0.05))
    del series["VIX9D"]["2024-01-04"]  # newest day has a missing tenor
    series["VIX"].pop("2024-01-03")
    series["VIX3M"].pop("2024-01-03")   # middle day: insufficient data
    return series


def test_export_writes_strict_json(tmp_path):
    series = _synthetic_series()
    table = build_table(series)
    fits = calibrate_history(table)
    latest = export(fits, table, {"2024-01-03": 140.0}, tmp_path)

    hist = json.loads((tmp_path / "vix_fits.json").read_text())
    assert hist["dates"] == ["2024-01-02", "2024-01-03", "2024-01-04"]
    assert hist["v0"][1] is None and "insufficient_data" in hist["flags"][1]
    assert len({len(hist[k]) for k in ("dates", "v0", "kappa", "theta", "rmse_volpts", "n_points", "flags")}) == 1

    on_disk = json.loads((tmp_path / "latest.json").read_text())
    assert on_disk == latest
    assert latest["date"] == "2024-01-04" and latest["latest_data_date"] == "2024-01-04"
    assert [p["symbol"] for p in latest["points"]] == ["VIX", "VIX3M", "VIX6M"]
    assert latest["skew"] == {"date": "2024-01-03", "level": 140.0}
    assert len(latest["curve"]["days"]) == len(latest["curve"]["level"])


def test_export_is_deterministic(tmp_path):
    series = _synthetic_series()
    table = build_table(series)
    fits = calibrate_history(table)
    export(fits, table, {}, tmp_path / "a")
    export(fits, table, {}, tmp_path / "b")
    for name in ("vix_fits.json", "latest.json"):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()
