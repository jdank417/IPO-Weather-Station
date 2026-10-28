VIX term-structure calibration
==============================

Model
-----

Under the pricing measure the Heston variance follows

.. math::

   dv_t = \kappa(\theta - v_t)\,dt + \xi\sqrt{v_t}\,dW^{(2)}_t .

Its expected average variance over :math:`[0, T]` is

.. math::

   A(T) = \theta + (v_0 - \theta)\,\frac{1 - e^{-\kappa T}}{\kappa T}.

A VIX-style index with horizon :math:`T` is (up to discretization details of
the Cboe methodology) the square root of the risk-neutral expected average
variance, so each day we set :math:`A(T_i) \approx (\mathrm{VIX}_{T_i}/100)^2`.

Horizons (calendar days / 365):

========  =====
Index     Days
========  =====
VIX9D     9
VIX       30
VIX3M     91
VIX6M     182
========  =====

What is and is not identified
-----------------------------

* :math:`A(T)` depends on :math:`v_0, \kappa, \theta` only. **The vol-of-vol**
  :math:`\xi` **and the correlation** :math:`\rho` **do not appear and are not
  identified by the term structure.** They come from VVIX and realized
  correlation instead (:doc:`odds_model`).
* With four horizons and three parameters there is one degree of freedom.
* When the curve is close to a straight ramp across 9 to 182 days, only the
  product :math:`\kappa(\theta - v_0)` is pinned down: an unpenalized fit slides
  to :math:`\kappa \to 0,\ \theta \to \infty`. On 2011 to 2026 data that
  happened on about a quarter of days (theta up to 200% vol).

Estimator
---------

Bounded nonlinear least squares in variance units, plus one penalty residual:

.. math::

   \min_{v_0,\kappa,\theta}\ \sum_i \bigl(A(T_i) - (\mathrm{VIX}_{T_i}/100)^2\bigr)^2
   + \Bigl(\lambda\,\bar{y}\,\ln\frac{\kappa}{\kappa_0}\Bigr)^2

with :math:`\bar{y}` the mean observed variance, :math:`\kappa_0 = 2`
(half-life about four months) and :math:`\lambda = 0.01`. This is a weak
log-normal prior on :math:`\kappa`: it decides the ramp days and barely moves
well-identified ones. A sweep over :math:`\lambda \in \{0, 0.003, 0.01, 0.03\}`
on the full history gave:

=========  ===========  ======================  ==================
lambda     median RMSE  theta 95th pct (vol)    kappa-at-bound days
=========  ===========  ======================  ==================
0          0.150        74.9%                   1015
0.003      0.150        69.7%                   686
0.01       0.153        42.2%                   325
0.03       0.174        35.2%                   180
=========  ===========  ======================  ==================

(RMSE in VIX points, 2011-01-04 to 2026-10-27.)

Bounds: :math:`v_0 \in [10^{-4}, 4]`, :math:`\theta \in [10^{-4}, 1]`,
:math:`\kappa \in [0.1, 60]` per year (half-life between about 4 days and 7
years). The cap was raised from 30 after March 2020, whose steeply inverted
curves need very fast mean reversion.

Solver details
  For fixed :math:`\kappa`, :math:`A(T)` is linear in :math:`(v_0, \theta)`. A
  241-point log grid over :math:`\kappa` with a closed-form 2x2 solve at each
  point gives a global starting value; ``scipy.optimize.least_squares`` (TRF,
  analytic Jacobian) refines it, and is also run from the previous day's fit
  (warm start). The lower-cost result wins. The weight
  :math:`(1-e^{-x})/x` uses ``expm1`` and a Taylor branch near zero.

Flags (never silent drops)
--------------------------

Every calendar row from the first fittable day is exported, with flags:

``missing:<tenors>``
   One or more horizons absent that day.
``exactly_identified``
   Three horizons: zero residual degrees of freedom (all days before VIX9D).
``insufficient_data``
   Fewer than three horizons; no parameters are reported.
``bad_fit``
   Worst residual above both 0.75 VIX points and 4% of the 30-day VIX level.
   Usually a humped or extremely inverted curve, which a one-factor model
   cannot reproduce. These days are *kept* in the published history with an
   ``approx`` flag: they are often the most dramatic crisis days, and the site
   labels them as approximate.
``<param>_at_bound``
   An estimate sits on a bound (mostly ``kappa`` at 30 on crash days).
``flat_term_structure``
   :math:`|v_0 - \theta| / \theta < 2\%`: :math:`\kappa` barely matters.
``solver_failed``
   The optimizer did not report convergence.

Warm starts carry forward only from fits that are not ``bad_fit``.

Tests
-----

``pipeline/tests/test_calibration.py`` generates term structures from the
formula above and checks that:

* with the prior switched off, parameters are recovered to 1e-6 relative;
* with the default prior, the curve stays within 0.02 VIX points and
  :math:`v_0` within 3%; :math:`\theta` (an extrapolation past six months when
  :math:`\kappa T` is small) within 15%;
* with 0.05-point noise, median :math:`v_0` is within 5% and the median-fit
  curve within 0.1 points of the truth;
* three-point days, missing values, humped curves and bounds are flagged.
