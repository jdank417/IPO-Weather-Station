Data sources
============

Cboe index histories
--------------------

Daily closing levels from Cboe's published CSVs::

   https://cdn-api.cboe.com/api/global/us_indices/daily_prices/{SYMBOL}_History.csv

(``cdn.cboe.com`` redirects there.) Linked from
https://www.cboe.com/tradable_products/vix/vix_historical_data/.

=======  ==========  ===========================================
Symbol   Begins      Notes
=======  ==========  ===========================================
VIX      1990-01-02  OPEN/HIGH/LOW/CLOSE; CLOSE used
VIX6M    2008-01-02
VIX3M    2009-09-18  first day with three horizons: fits start here
VIX9D    2011-01-04  first day with all four horizons
SKEW     1990-01-02  single SKEW column
=======  ==========  ===========================================

(Start dates as of the October 2026 download.)

Days 2009-09-18 to 2011-01-03 have three horizons and are flagged
``exactly_identified``. A day where any tenor is missing, blank or
non-positive is kept and flagged; the parser reports unusable rows instead of
coercing them.

Usage terms
~~~~~~~~~~~

The historical-data page says the data is "furnished without responsibility
for accuracy". Cboe's website Terms (https://www.cboe.com/terms, section 2)
allow downloading one copy for personal non-commercial use and otherwise
require prior written consent to reproduce, distribute or create derivative
works; https://www.cboe.com/use-of-content says use of Cboe data requires
advance approval and a license.

To stay conservative the pipeline:

* downloads the CSVs inside GitHub Actions into ``data/cache/`` (git-ignored);
  raw histories are **not** committed or published;
* publishes only derived quantities (fitted :math:`v_0, \kappa, \theta`,
  residuals, flags) plus the four index levels and the SKEW level for the
  latest day, needed to show the fit.

Whether even that requires a license from Cboe is a decision for the
repository owner. Removing the latest-day levels from ``latest.json`` is a
one-line change in ``pipeline/export_json.py``.

Jay Ritter IPO data
-------------------

"Monthly Number of IPOs and the Average First-Day Return", Jay R. Ritter,
University of Florida, https://site.warrington.ufl.edu/ritter/ipo-data/
(file https://site.warrington.ufl.edu/ritter/files/IPOALL.xlsx). Downloaded
2026-10-28 into ``data/raw/IPOALL.xlsx`` (sha256 prefix ``00f2f3ae0badd456``).
**Vintage: January 1960 to December 2025.** The page states no terms of use.
The file is the source of record and is committed for reproducibility; it is
not fetched automatically. To update it, download a new vintage over it and
re-run ``python -m pipeline.fit_ipo_regimes --compare``.

FRED
----

Federal Reserve Bank of St. Louis, FRED: ``CPIAUCSL`` (CPI), ``T5YIE`` and
``T10YIE`` (breakeven inflation), ``DFII10`` (10-year TIPS real yield).
Downloaded daily via the public ``fredgraph.csv`` endpoint, or the FRED API
when the optional ``FRED_API_KEY`` Actions secret is set. Only monthly
aggregates are published (``site/data/monthly.json``).

Output files
------------

``site/data/vix_fits.json``
   Columnar daily history: ``dates``, ``v0``, ``kappa``, ``theta``,
   ``rmse_volpts``, ``n_points``, ``flags``. ``null`` where no fit exists.
``site/data/latest.json``
   Latest good fit, its observed points and residuals, a sampled fitted curve
   (1 to 365 days) and the latest SKEW.
``site/data/monthly.json``
   Monthly covariate panel (volatility summaries, SKEW, inflation measures).
``site/data/regime.json``
   Regime model parameters, standard errors, model comparison, filtered and
   smoothed probabilities, forward covariates and parameter draws.

Output is deterministic, so the daily job commits only when the data changes.
