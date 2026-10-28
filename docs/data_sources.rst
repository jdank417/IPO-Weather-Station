Data sources
============

Cboe index histories
--------------------

Daily closes from Cboe's published CSVs::

   https://cdn-api.cboe.com/api/global/us_indices/daily_prices/{SYMBOL}_History.csv

(``cdn.cboe.com`` redirects there.) Linked from
https://www.cboe.com/tradable_products/vix/vix_historical_data/.

=======  ==========  =================================================
Symbol   Begins      Used for
=======  ==========  =================================================
VIX      1990-01-02  term structure (30 days); VIX percentile
VIX6M    2008-01-02  term structure (182 days)
VIX3M    2009-09-18  term structure (91 days); fits start here
VIX9D    2011-01-04  term structure (9 days)
VVIX     2006-03-06  vol of vol (xi)
SPX      1975-01-02  realized correlation (rho), today's level, drawdowns
=======  ==========  =================================================

(Start dates as of the October 2026 download.) Days 2009-09-18 to 2011-01-03
have three VIX horizons and are flagged ``exactly_identified``. Unusable rows
(blank, non-numeric, non-positive) are reported by the parser, never coerced.

FRED
----

``DTB3``: 3-month Treasury bill rate, the risk-free rate for the drift.
Downloaded via the public ``fredgraph.csv`` endpoint, or the FRED API when the
optional ``FRED_API_KEY`` Actions secret is set.

Usage terms
~~~~~~~~~~~

Cboe's historical-data page says the data is "furnished without
responsibility for accuracy". Cboe's website Terms
(https://www.cboe.com/terms, section 2) allow downloading one copy for
personal non-commercial use and otherwise require prior written consent to
reproduce or distribute; https://www.cboe.com/use-of-content says use of Cboe
data requires advance approval and a license. To stay conservative:

* raw CSVs are downloaded inside GitHub Actions into ``data/cache/``
  (git-ignored) and never committed or published;
* the site publishes derived quantities (model parameters and model odds),
  single latest-day readings (VIX, VVIX, S&P 500 level, VIX percentile) and,
  per crisis, a few computed facts (peak VIX, S&P drawdown).

Whether even that needs a license from Cboe is a decision for the repository
owner.

Output files
------------

``site/data/latest.json``
   Latest day's full parameter set, rates, S&P level, VIX/VVIX readings and
   fit quality.
``site/data/history.json``
   Columnar daily history since 2009-09: ``v0, kappa, theta, xi, rho, r``,
   1-month odds of a 10%+ fall and rise, and an ``approx`` flag.
``site/data/events.json``
   Crisis windows with hand-written descriptions and computed facts.

All output is deterministic, so the daily job commits only when data changes.
