User interface
==============

``site/index.html`` with ``site/js/app.js`` (ES modules, no build step).

Data
----

On load the page fetches ``data/latest.json`` (written by the daily pipeline).
If it cannot be loaded the page says so and falls back to illustrative
parameters; it never invents a "today".

Sliders
-------

* √v0 and √θ are shown as volatilities; the model receives variances.
* κ is shown with its half-life :math:`\ln 2/\kappa` in days.
* ξ and ρ sit in a separate group labelled as assumptions: the VIX term
  structure does not identify them. Defaults are ξ = 0.6 and ρ = −0.7.
* Only the slider that moved is read, so untouched parameters keep their exact
  fitted values rather than snapping to the slider step.
* "Reset to today" restores the fitted (v0, κ, θ) and the default ξ, ρ.

Surface
-------

* 10 maturities (1 week to 2 years) by 19 strikes from −2.5 to +2 standard
  deviations of :math:`\ln(K/F)`, using today's expected average variance for
  each maturity. The grid is fixed at load so the axes stay still while the
  surface moves; the plot uses the standardized strike, and the hover shows the
  actual log-moneyness.
* Computed in a module Web Worker (``worker.js``). While a computation is in
  flight, newer slider positions are coalesced into one pending request, so
  drags never queue up stale work. If module workers are unavailable, the page
  computes on the main thread. A full surface takes about 20 to 50 ms.
* Redraw budget: the 3D surface is the expensive part (a WebGL buffer rebuild
  per update). It is redrawn only when the worker returns new values, at most
  about 8 times a second while a slider is held, and exactly once more on
  release. The term-structure chart and slider labels update every frame.
* While a slider is held, the z-axis and color ranges only widen, so the
  surface reshapes in place instead of rescaling every frame; on release they
  auto-fit again.
* Charts resize only when their width changes (debounced). Plotly's
  ``responsive`` mode is off because mobile browsers fire height-only resizes
  whenever the address bar shows or hides.
* The pinned gl3d bundle has no bar trace, so monthly counts are drawn as a
  step line with a light area wash.
* If the browser drops the WebGL context, the page rebuilds the surface.
* Range inputs use ``touch-action: none`` so a slightly diagonal drag on a
  slider does not scroll the page.
* Colors: one sequential blue ramp, light to dark for low to high in light
  mode, and stepped toward the dark surface for low values in dark mode.
* A status badge (icon plus text, never color alone) reports whether the Feller
  condition :math:`2\kappa\theta > \xi^2` holds.
* A table view mirrors the surface.

Term-structure panel
--------------------

Today's Cboe closes (markers with direct labels), today's fitted curve, and,
once v0, κ or θ move, the curve implied by the sliders. A legend is always
shown and a table view mirrors the values. Category colors were checked with a
palette validator in both modes (worst colorblind-simulated separation
ΔE 9.2 light, 9.4 dark).

IPO window forecast
-------------------

The top card shows the probability that **next month** is a hot IPO month
(``site/js/regime.js``; see :doc:`regime_model`), with a meter whose shaded
band is the 90% range over 300 parameter draws. A compact copy sits at the top
of the slider panel so it stays visible while dragging.

* v0, θ and κ feed the forecast through the 1-year expected vol
  :math:`\sqrt{A(1y)}`; ξ and ρ are labelled "surface only".
* SKEW and 5-year breakeven sliders feed only the forecast; moving them does
  not recompute the surface.
* "Reset to today" restores the latest daily SKEW and breakeven as well.
* The card states plainly that none of the covariate effects is statistically
  significant.

The history section shows Ritter's monthly net IPO counts and the model's
smoothed hot-regime probability, followed by the forecast path (no IPO data)
up to the current month, on a shared date axis. Tables mirror both charts, and
the coefficients (with standard errors) and the model comparison are one click
away.

Dependencies
------------

Plotly ``plotly.js-gl3d-dist-min@2.35.2`` from jsDelivr, pinned with a
subresource-integrity hash. If it fails to load, the page shows a message and
the tables still work.

Mobile and themes
-----------------

The layout is a single column below 60 rem. Below about 560 px the surface
hides its colorbar and uses short axis titles. Colors come from CSS custom
properties with light and dark sets, and the charts redraw when the system
color scheme changes.
