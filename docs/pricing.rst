Browser pricing engine
======================

Everything here runs client-side in ``site/js/`` (ES modules, no build step).

Characteristic function
-----------------------

``heston.js`` evaluates the characteristic function of
:math:`Y = \ln(S_T/S_0)` in the "little Heston trap" form (Albrecher, Mayer,
Schoutens and Tistaert, 2007):

.. math::

   \beta = \kappa - \rho\xi i u,\quad
   d = \sqrt{\beta^2 + \xi^2(u^2 + iu)},\quad
   g = \frac{\beta - d}{\beta + d},

.. math::

   C = (r-q) i u T + \frac{\kappa\theta}{\xi^2}\Bigl[(\beta - d)T
       - 2\ln\frac{1 - g e^{-dT}}{1 - g}\Bigr],\qquad
   D = \frac{\beta - d}{\xi^2}\,\frac{1 - e^{-dT}}{1 - g e^{-dT}},

and :math:`\varphi(u) = e^{C + D v_0}`. With :math:`\operatorname{Re} d \ge 0`
we have :math:`|g| \le 1` and :math:`|e^{-dT}| \le 1`, so the principal complex
logarithm does not cross its branch cut. Complex arithmetic is written out
inline on (re, im) pairs.

COS method
----------

Following Fang and Oosterlee (2008), with truncation range :math:`[a, b]`,

.. math::

   P(K) \approx e^{-rT} \sum_{k=0}^{N-1}{}' \operatorname{Re}\!\left[
   \varphi\!\left(\tfrac{k\pi}{b-a}\right) e^{-i k\pi a/(b-a)}\right] V_k,
   \qquad V_k = \frac{2K}{b-a}\bigl(\psi_k(a, \tilde d) - e^{-\tilde k}\chi_k(a, \tilde d)\bigr)

for a put, where :math:`\tilde k = \ln(K/S_0)`, :math:`\tilde d = \min(\tilde k, b)`,
and :math:`\chi_k, \psi_k` are the closed-form cosine integrals of
:math:`e^y` and :math:`1`. Calls come from put-call parity, since the bounded put
payoff makes the expansion much less sensitive to the truncation range.
``cosCallDirect`` prices calls from the call payoff and exists for the parity test.

* The CF terms :math:`\varphi(u_k)e^{-iu_k a}` depend only on the maturity, so a
  "slice" is computed once per maturity and reused for every strike.
* :math:`\cos(k\phi)` and :math:`\sin(k\phi)` use angle-addition recurrences
  instead of :math:`2N` trig calls per strike (about 3x faster).

Truncation range
~~~~~~~~~~~~~~~~

:math:`[a, b] = c_1 \pm L\sqrt{c_2 + \sqrt{c_4}}`. :math:`c_1` is closed form.
:math:`c_2` and :math:`c_4` are computed from the CF itself:
:math:`R(u) = \ln|\varphi(u)| = -c_2u^2/2 + c_4u^4/24 - \dots`, so Richardson
differences at :math:`u = h, 2h` give

.. math::

   c_2 = -\frac{16R(h) - R(2h)}{6h^2},\qquad c_4 = \frac{2\bigl(R(2h) - 4R(h)\bigr)}{h^4},

with :math:`h = 0.002/\sqrt{\mathbb{E}\int_0^T v\,dt}`. Against mpmath
derivatives of the cumulant generating function these are within
:math:`10^{-6}` (c2) and :math:`10^{-2}` (c4) relative on the test grid.

.. note::

   The closed-form :math:`c_2` usually quoted from Fang and Oosterlee (2008)
   disagreed with the mpmath values here and even went negative
   (:math:`\kappa = 0.2`). Using it with :math:`c_4 = 0` gave price errors up to
   :math:`10^{-2}` (on :math:`S_0 = 100`) for :math:`\xi = 1.5`.

Accuracy sweep
~~~~~~~~~~~~~~

Worst absolute price error (``S0 = 100``) against the Lewis-integral
reference, over 5 maturities (1 week to 2 years) and 8 strikes per parameter set:

======  ==  ==========  ========  ================  ==========
N       L   base        high xi   rho = -0.9        slow kappa
======  ==  ==========  ========  ================  ==========
512     10  1.6e-9      1.6e-4    9.1e-9            2.5e-9
512     12  1.5e-11     3.7e-4    2.2e-7            7.1e-9
1024    12  1.5e-11     1.2e-6    7.0e-11           2.4e-11
2048    12  1.5e-11     7.0e-9    7.0e-11           2.4e-11
======  ==  ==========  ========  ================  ==========

Defaults: ``COS_N = 2048``, ``COS_L = 12``. A 10 x 21 surface takes about
15 ms in Node 22.

Probabilities (CDF)
-------------------

``cosCdf(slice, x)`` gives :math:`P(\ln(S_T/S_0) \le x)` from the same slice:
the COS density coefficients integrated from :math:`a` to :math:`x`,

.. math::

   F(x) \approx \frac{2}{b-a}\Bigl[\tfrac12 \operatorname{Re}\varphi_0\,(x-a)
   + \sum_{k \ge 1} \operatorname{Re}\bigl(\varphi(u_k)e^{-iu_k a}\bigr)
   \frac{\sin(u_k(x-a))}{u_k}\Bigr],

with the angle-addition recurrence for the sines. It matches Gil-Pelaez
integration to 1e-9 on the test sets and equals the strike-derivative of COS
put prices (a digital option), as it must.

Implied volatility
------------------

``impliedvol.js``:

* Normal CDF: Hart (1968) rational approximation (West 2005) for
  :math:`|x| \le 4`, and the Laplace continued fraction beyond, giving about
  :math:`10^{-14}` relative error in the tails.
* Black (forward) prices; the solver always inverts the out-of-the-money option
  (an in-the-money price is converted by parity), because ITM prices are mostly
  intrinsic value.
* Newton-Raphson on :math:`\sigma` inside a bracket :math:`[10^{-4}, 5]` that
  shrinks every step; bisection when vega is tiny or Newton leaves the bracket.
  Prices outside no-arbitrage bounds return ``NaN``.

In the surface, out-of-the-money prices below ``MIN_PRICE = 1e-9`` of the
forward are reported as ``NaN``: the COS sum's absolute error (about
:math:`10^{-13}`) would dominate their implied vol.

Tests and reference
-------------------

``pipeline/tests/make_heston_fixture.py`` writes
``tests/js/fixtures/heston_reference.json``:

* Heston prices from the Lewis (2001) integral with ``scipy.integrate.quad``
  (quadrature error at most 2e-12), using a separate numpy implementation of
  the CF that is cross-checked against Heston's original 1993 form at short
  maturity, plus :math:`\varphi(0) = 1` and the martingale condition
  :math:`\varphi(-i) = 1`. An independent 2-million-point trapezoid rule agrees
  to 6e-14.
* Seven parameter sets, including :math:`\xi = 1.5` (Feller violated),
  :math:`\rho = -0.9`, a crash-like backwardated state, and
  :math:`\kappa = 0.2`; maturities from one week.
* Exact cumulants (mpmath), Black prices and normal-CDF values from scipy.

``npm test`` (Node's built-in ``node:test``, no dependencies) checks COS prices
to :math:`10^{-10} S_0`, IVs, parity between independent call and put
expansions, IV round-trips, and the :math:`\xi \to 0` limit where the ATM
implied variance must equal the expected average variance from the
calibration formula.
