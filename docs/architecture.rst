Architecture
============

Constraints
-----------

* Hosted on GitHub Pages only: no server, no database, no runtime API call
  that needs a secret.
* Everything a visitor interacts with runs client-side (ES modules, no build
  step).
* Data arrives through GitHub Actions: a scheduled workflow fetches raw data,
  runs the Python calibration and commits JSON under ``site/data/``.
* Secrets (the optional ``FRED_API_KEY``) live in Actions secrets.
* Every third-party dependency is pinned: Actions by commit SHA, Python
  packages by exact version, the CDN script by exact version plus an
  integrity hash.

Data flow
---------

::

   Cboe CSVs (VIX9D, VIX, VIX3M, VIX6M, VVIX, SPX), FRED DTB3
            |
            v
   pipeline/update.py (Actions)
     calibrate_term_structure  -> v0, kappa, theta per day
     full_params               -> xi (VVIX), rho (realized), r, q
     odds                      -> daily 1-month odds for the timeline
     events                    -> crisis windows + computed facts
            |
            v
   site/data/latest.json, history.json, events.json
            |
            v
   browser: heston.js (CF, COS prices and CDF), odds.js (odds, quantiles),
            surface.js + worker.js (landscape), app.js (two tabs)

Workflows
---------

``update-data.yml``
   Tuesday to Saturday at 01:23 and 11:17 UTC. Runs the tests, then
   ``python -m pipeline.update``, and commits ``site/data/`` only if it
   changed (rebasing and retrying if ``main`` moved meanwhile).

``deploy.yml``
   Publishes ``site/`` to Pages on pushes that touch it, on demand, and after
   ``Update data`` succeeds (pushes made with ``GITHUB_TOKEN`` do not trigger
   other workflows).

``ci.yml``
   Python and JavaScript tests on pushes to ``main`` and on pull requests.

History
-------

The project began as an "IPO Weather Station" linking volatility to the odds
of a hot IPO market. That model found no statistically reliable link, and the
project was refocused on market-implied S&P 500 odds. The IPO code and its
write-up remain in the git history.
