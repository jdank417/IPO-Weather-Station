Odds model
==========

The site answers questions like "what is the chance the S&P 500 is 10% or
more lower on December 31?" with the probability implied by option prices,
under a Heston model fitted every day.

Parameters, every day
---------------------

=========  =============================================  ======================
parameter  meaning                                         source
=========  =============================================  ======================
v0         variance today                                  VIX term structure
kappa      speed at which variance reverts                 VIX term structure
theta      long-run variance                               VIX term structure
xi         volatility of variance ("vol of vol")           VVIX
rho        correlation of price and variance shocks       realized, past year
r, q       T-bill rate, dividend yield                     FRED DTB3, fixed 1.3%
=========  =============================================  ======================

v0, kappa, theta
   Fitted to VIX9D, VIX, VIX3M and VIX6M (:doc:`calibration`).

xi from VVIX
   Under Heston, :math:`\mathrm{VIX}^2(\tau) = a + b\,v` with
   :math:`b = (1 - e^{-\kappa\tau})/(\kappa\tau)` and :math:`\tau` = 30 days, so
   :math:`d(\mathrm{VIX}^2) = b\,\xi\sqrt{v}\,dW` and the volatility of VIX is
   :math:`b\,\xi\sqrt{v}/(2\,\mathrm{VIX}^2)`. Setting that equal to
   VVIX/100 gives

   .. math::

      \xi = \frac{2\,\mathrm{VIX}^2\,(\mathrm{VVIX}/100)}{b\,\sqrt{v_0}},

   clamped to [0.05, 3]. VVIX is a 30-day implied volatility of VIX, so this
   is an approximation (instantaneous vs. 30-day average). As a cross-check,
   the realized volatility of the fitted v0 over the last year implies about
   0.8 against 0.42 from VVIX; the realized figure is inflated by day-to-day
   fit noise, and VVIX is the forward-looking, option-consistent input.

rho from realized correlation
   The trailing 252-day correlation of daily S&P 500 log returns with daily
   changes in the fitted v0, both scaled by :math:`\sqrt{v_0}`. In Heston,
   :math:`\rho` is the same under real-world and risk-neutral probabilities,
   so a realized estimate is legitimate. It runs from about −0.6 to −0.8
   across years (−0.72 in late 2026). Until 120 observations exist it
   defaults to −0.7.

Drift
   Moves are measured from the latest close, with forward
   :math:`F = S_0 e^{(r - q)T}`, :math:`r` the 3-month T-bill rate and
   :math:`q` = 1.3%.

Odds
----

:math:`P(S_T \le K)` is the CDF of :math:`\ln(S_T/S_0)` from the COS
expansion of the density (:doc:`pricing`). "Up" odds are :math:`1 - P`. The
fan chart solves :math:`P(S_T/S_0 \le x) = p` for
:math:`p \in \{5, 25, 50, 75, 95\}\%` by bisection.

Headline cards
   10%+ down and 10%+ up on December 31 of the current year (next year's if
   fewer than 30 days remain), and 20%+ down one year ahead. All are
   **terminal** probabilities (the level on that date), not "at any time
   before".

Replay timeline
   The daily odds of a 10%+ fall over one month, precomputed in Python
   (``pipeline/odds.py``, a numpy mirror of the browser code) for every day
   since 2009-09.

What the odds are not
---------------------

* **Risk-neutral, not real-world.** Option prices include an insurance
  premium; historically, implied odds of large falls have exceeded how often
  they happened.
* **No jumps.** Pure Heston cannot produce sudden crashes, so extreme
  short-horizon tail odds are probably understated.
* **Why not SKEW?** Cboe defines SKEW = 100 − 10 × (30-day risk-neutral
  skewness). In October 2026 SKEW ≈ 149, a skewness near −4.9. Heston with
  these parameters gives about −0.65, and even adding lognormal crash jumps
  cannot reach −4.9 without implausible jump sizes (around −50% per jump).
  SKEW is dominated by a few far out-of-the-money puts, so it is not used.
* **Approximate days.** When the fear curve has a shape a one-factor model
  cannot fit (mostly the peak of crises), the day is kept and labelled
  approximate.

Tests
-----

* ``pipeline/tests``: COS CDF vs. Gil-Pelaez integration (1e-9); xi from VVIX
  inverts the Heston VIX dynamics exactly; the rolling correlation recovers
  :math:`\rho` from simulated Heston paths.
* ``tests/js/odds.test.js``: COS CDF vs. a Gil-Pelaez fixture (1e-9, including
  crisis-like and high-xi sets); CDF equals the strike-derivative of put
  prices; quantiles invert the CDF; integrating :math:`P(S_T/S_0 > k)` over
  :math:`k` recovers the forward :math:`e^{(r-q)T}`.
