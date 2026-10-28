# IPO Weather Station

A static, math-heavy web app on GitHub Pages that links the stock market's
expected volatility ("fear") and inflation to the odds that the IPO market is
"hot."

- **Stage 1 – Volatility Surface Sculptor.** Each day a GitHub Action fits the
  Heston variance parameters (v0, kappa, theta) to Cboe's VIX term structure.
  The browser prices options with the COS method and draws the implied-vol
  surface, with sliders for every Heston parameter.
- **Stage 2 – IPO window gauge.** A two-regime Markov-switching model with
  time-varying transition probabilities maps volatility and inflation
  covariates onto the probability of a hot IPO market.

Status: Milestone 2 (daily VIX term-structure calibration). See `CLAUDE.md` for the
full plan and `docs/` for design notes.

## Layout

```
site/        static site published to Pages (reads JSON from site/data/)
pipeline/    Python fetch / calibrate / export, run by GitHub Actions
data/raw/    raw downloads, incl. manually added Ritter IPO data
docs/        reStructuredText documentation
.github/     deploy and data-update workflows
```

## Local preview

```
python3 -m http.server -d site 8000
```

then open http://localhost:8000.

## Pipeline

```
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python -m pytest
.venv/bin/python -m pipeline.update          # download Cboe CSVs, fit, write site/data/
.venv/bin/python -m pipeline.update --offline  # reuse data/cache/
```

## Deploying

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
Every push to `main` that touches `site/` publishes the site.

## Data sources

- Cboe Global Markets: VIX9D, VIX, VIX3M, VIX6M and SKEW daily index
  histories (cdn-api.cboe.com `daily_prices` CSVs). Raw files are not
  redistributed here; see `docs/data_sources.rst` for usage terms.
- Jay R. Ritter, University of Florida, IPO data (Stage 2).
- Federal Reserve Bank of St. Louis, FRED (Stage 2).
