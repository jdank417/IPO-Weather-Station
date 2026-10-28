# Market Weather Station

A static, math-heavy web app on GitHub Pages: **what the options market thinks
happens next to the S&P 500.** Two tabs: market-implied odds of big moves, and
a day-by-day replay of past crises. Written for non-specialists; technical
detail lives in `docs/`.

(The repo started as "IPO Weather Station", a volatility-to-IPO model. That
link was not statistically reliable, so the project pivoted. The IPO code is in
git history.)

## Hard constraints

- **Hosting is GitHub Pages only.** No servers, no databases, no runtime API
  calls that need secrets. All math the visitor interacts with runs client-side.
- **Data arrives via GitHub Actions.** A scheduled workflow fetches data, runs
  Python calibration, and commits JSON to `site/data/`. The site only reads
  static JSON.
- Secrets (optional `FRED_API_KEY`) live in GitHub Actions secrets.
- Raw Cboe data is never committed or published; only derived values and a few
  single latest-day readings (see `docs/data_sources.rst`).
- Project documentation beyond this file and the README is `.rst` under `docs/`.
- Pin every third-party version (CDN with SRI hash, requirements). GitHub
  Actions are pinned by full commit SHA with the tag in a trailing comment.

## Layout

```
site/
  index.html, css/style.css
  js/
    app.js          page controller (tabs, odds, replay)
    heston.js       little-trap CF, COS prices and CDF
    odds.js         odds, quantiles, fan, "1 in N"
    impliedvol.js   Black-Scholes + IV solver
    surface.js      IV surface grid; worker.js runs it off the main thread
    termstructure.js  expected average variance, surface grid helper
  data/             latest.json, history.json, events.json (pipeline output)
pipeline/
  fetch_cboe.py     VIX9D, VIX, VIX3M, VIX6M, VVIX, SPX
  fetch_fred.py     DTB3
  calibrate_term_structure.py   v0, kappa, theta per day
  full_params.py    xi from VVIX, rho realized, drift
  odds.py           numpy COS CDF (timeline precompute)
  events.py         crisis windows; facts computed from data
  export_json.py, update.py (entry point)
  tests/
tests/js/           node:test suites and fixtures
docs/               .rst
.github/workflows/  update-data.yml (daily), deploy.yml, ci.yml
```

## Model (details in docs/)

- Heston under the pricing measure. Daily: v0, kappa, theta from the VIX term
  structure (bounded least squares with a weak log-kappa prior, kappa <= 60,
  bad fits kept and flagged `approx`); xi from VVIX; rho = trailing 252-day
  realized correlation of S&P returns with changes in v0; r = 3-month T-bill,
  q = 1.3%.
- Odds are terminal, risk-neutral probabilities from the COS CDF. The UI must
  say they include an insurance premium and that the model has no jumps (tails
  probably understated). SKEW is deliberately not used (see docs/odds_model.rst).

## Rules for changes

- Tests before UI polish. Python: calibration recovery, CDF vs Gil-Pelaez, xi
  and rho estimators. JS: COS prices and CDF vs Python fixtures (tight
  tolerances, stressed parameter sets), parity, IV round-trips.
- Event facts (drawdowns, peak VIX, peak odds) are computed, never typed in.
- Keep the page simple: headline numbers, one question widget, one chart per
  idea. Mobile and light/dark must work; the 3D surface is throttled by
  measured draw cost.

Checks before pushing: `.venv/bin/python -m pytest` and `npm test`.
Live at https://jdank417.github.io/IPO-Weather-Station/.
