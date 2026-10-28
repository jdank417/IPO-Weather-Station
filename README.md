# Market Weather Station

**What the options market thinks happens next to the S&P 500.**

Live: https://jdank417.github.io/IPO-Weather-Station/

- **Odds**: the market-implied chance the S&P 500 is 10% lower, or higher, by
  year-end; a "1 in N" for any move and horizon you pick; and a fan chart of
  where the index could be over the next year.
- **Crisis replay**: press play on the COVID crash, Volmageddon, the 2022 rate
  shock, the 2025 tariff shock and more, and watch the market's "fear
  landscape" and crash odds move day by day.

Every trading day a GitHub Action fits a Heston volatility model to Cboe's VIX
term structure, VVIX and the S&P 500's recent behavior, and commits the
parameters as JSON. The browser does the rest: option-pricing math (COS
method) turns the parameters into probabilities on the fly. Not investment
advice; the odds are risk-neutral (they include an insurance premium) and the
model has no sudden-crash jumps.

## Layout

```
site/        static site (reads JSON from site/data/)
pipeline/    Python fetch / calibrate / export, run by GitHub Actions
tests/js/    JavaScript tests (node:test, no dependencies)
docs/        reStructuredText documentation of the math and design
```

## Run it locally

```
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python -m pytest                 # Python tests
npm test                                   # JS tests (Node 22+)
.venv/bin/python -m pipeline.update        # download data, fit, write site/data/
python3 -m http.server -d site 8000        # then open http://localhost:8000
```

## Deploying

Settings → Pages → Source: **GitHub Actions**. Pushes to `main` that touch
`site/` publish the site; the daily data job redeploys after committing data.
An optional `FRED_API_KEY` Actions secret switches FRED downloads to the API.

## Data sources

- Cboe Global Markets: VIX9D, VIX, VIX3M, VIX6M, VVIX and S&P 500 daily index
  histories (cdn-api.cboe.com `daily_prices` CSVs). Raw files are not
  redistributed; see `docs/data_sources.rst` for usage terms.
- Federal Reserve Bank of St. Louis, FRED: DTB3 (3-month Treasury bill rate).

## History

This repository began as the "IPO Weather Station", linking market fear and
inflation to the odds of a hot IPO market. Its regime model found no
statistically reliable link, so the project was refocused; that code remains
in the git history.
