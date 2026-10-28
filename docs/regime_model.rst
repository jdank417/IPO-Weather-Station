IPO regime model
================

Question
--------

Does the options market's fear (the Heston variance state fitted to the VIX
term structure, and Cboe SKEW) or inflation tell us anything about whether the
IPO market is about to be hot?

Data
----

* **IPO activity**: Jay Ritter's monthly *net* IPO counts (operating companies;
  excludes SPACs, direct listings, penny stocks, units, closed-end funds, REITs,
  ADRs, banks and S&Ls). See :doc:`data_sources`.
* **Volatility**: monthly means of daily fits from the Stage 1 calibration
  (bad-fit days excluded).
* **SKEW**: monthly mean of Cboe SKEW.
* **Inflation**: monthly mean of the 5-year breakeven (FRED ``T5YIE``). CPI
  year-over-year, the 10-year breakeven and the 10-year real yield are also in
  ``site/data/monthly.json`` for comparison.

Sample: 2009-11 to 2025-12 (194 months). It starts after the first full month
with a three-horizon VIX fit (2009-10) and ends with the Ritter vintage.

Model
-----

.. math::

   y_t = \log(1 + \text{net IPOs}_t) \mid S_t \sim N(\mu_{S_t}, \sigma^2),
   \qquad S_t \in \{\text{cold}, \text{hot}\}

.. math::

   P(S_t = \text{hot} \mid S_{t-1} = s) = \operatorname{logistic}\bigl(\gamma_s^\top [1, z_{t-1}]\bigr)

with :math:`z_{t-1}` last month's standardized covariates (time-varying transition
probabilities, Diebold, Lee and Weinbach 1994; Filardo 1994). The covariates
are lagged one month so that this month's conditions predict next month's
regime. "Hot" is the regime with the higher mean. Estimated by maximum
likelihood with statsmodels ``MarkovRegression(exog_tvtp=...)`` (12 seeds
times 150 random starts reach the same optimum).

Covariates used
~~~~~~~~~~~~~~~

1. **1-year expected vol** :math:`\sqrt{A(1\,\text{y}; v_0, \kappa, \theta)}`,
   the Heston expected average variance over one year. One number that responds
   to all three fitted parameters, so the site's v0, θ and κ sliders all move
   the gauge. ξ and ρ do not enter.
2. **Cboe SKEW**.
3. **5-year breakeven inflation**.

Design choices and tradeoffs
----------------------------

**Dependent variable.** First-day returns are undefined in months with no
IPOs (17 such months since 1960 are marked "na", and they cluster in cold
markets), so the count is the natural switching variable. A first attempt with
regime-specific variances collapsed one regime onto months with exactly one IPO
(variance → 0, unbounded likelihood), a known pathology for discrete data.
A common variance avoids it. A variant using the log trailing 3-month count
with regime-specific variances gave the same qualitative conclusions.

**Small sample.** 194 months and two regimes leave few regime switches to
learn from. The covariate set is therefore three variables, and the site
shows a 90% band from 300 draws of the parameters from their asymptotic normal
distribution, not just a point.

Results
-------

Regime means: about 5.2 net IPOs a month (cold) and 14.4 (hot). Transition
coefficients (standardized covariates, standard errors in parentheses) are in
``site/data/regime.json`` under ``coefficients``. At the time of writing:

======  ==========  ===============  ================
from    covariate   gamma            (s.e.)
======  ==========  ===============  ================
cold    const       −3.20            (0.88)
cold    1y vol      −0.64            (0.84)
cold    SKEW        −0.60            (0.87)
cold    5y BE       −0.80            (0.63)
hot     const        2.12            (0.56)
hot     1y vol      −0.20            (0.72)
hot     SKEW         0.81            (1.23)
hot     5y BE       −0.19            (1.10)
======  ==========  ===============  ================

Signs are economically sensible: higher volatility, crash fear and inflation
expectations lower the chance that a cold market turns hot. **None of the
covariate effects is statistically significant.**

Model comparison (same sample; LR test against constant transitions):

==============================================  =====  ========  ======  ======  =========
specification                                   k      log L     AIC     BIC     LR p
==============================================  =====  ========  ======  ======  =========
constant transitions                            5      −188.28   386.6   402.9   –
1y vol                                          7      −188.10   390.2   413.1   0.83
1y vol + SKEW                                   9      −187.50   393.0   422.4   0.82
**1y vol + SKEW + 5y breakeven (used)**         11     −186.35   394.7   430.7   0.70
1y vol + SKEW + 10y real yield                  11     −185.43   392.9   428.8   0.58
spot vol + long-run vol + SKEW + 5y breakeven   13     −177.3    380.7   423.1   0.005*
==============================================  =====  ========  ======  ======  =========

\* The last specification's apparent gain is a quasi-separation artifact: its
transition coefficients run to about ±50 with standard errors near 60 (the
logistic saturates to fit a handful of transitions exactly), and the optimum
is unstable across seeds. Level-plus-slope variants of the volatility state
(spot vol and :math:`\sqrt{A(1y)} - \sqrt{v_0}`) were not significant either
(p from 0.19 to 0.75).

**Honest reading:** in this sample, the strongest evidence is for persistent
hot and cold IPO regimes. The volatility and inflation covariates shift the
transition odds in plausible directions, but the data cannot distinguish those
effects from zero. BIC prefers constant transition probabilities. The gauge is
best read as "what the point estimates imply", with the band showing how
little the data pin down.

From the model to the gauge
---------------------------

``site/js/regime.js`` re-implements the Hamilton filter. The tests check it
against statsmodels' filtered probabilities (to 1e-8) and log-likelihood
(1e-6); the pipeline also refuses to export if its own Python filter disagrees
with statsmodels.

1. Filter through the sample (ending at the Ritter vintage month).
2. Predict forward (no IPO observations) through each later month, using that
   month's covariates from ``site/data/regime.json`` ``forward``.
3. For the current month, replace the covariates with the what-if values:
   1-year vol computed from the surface sliders (v0, θ, κ), plus the SKEW and
   breakeven sliders. The result is the probability that **next month** is
   hot.

Steps 1 and 2 run once per parameter draw at load; slider moves only redo
step 3, which takes microseconds.

Caveats: monthly covariates are averages, while the what-if inputs are
point-in-time values; months between the Ritter vintage and today are filled
by prediction only, so the state becomes less certain the older the vintage
is. Updating ``data/raw/IPOALL.xlsx`` to a newer vintage and re-running the
pipeline fixes that.

Not implemented
---------------

The optional local-projection extension (Jordà 2005, IPO activity on inflation
surprises) is not implemented. Given how weak the inflation effect is here,
impulse responses would mostly show wide bands.
