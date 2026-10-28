User interface
==============

One page, two tabs, written for non-specialists. Technical detail lives in
these docs, not on the page.

Odds tab
--------

* Three headline cards: S&P 500 10%+ down and 10%+ up on December 31, and
  20%+ lower a year from now, each with "about 1 in N" and the index level.
* "Ask the market": a sentence with three selects (direction, size, horizon)
  and the answer.
* Fan chart: where the S&P 500 could be over the next year (median, 50% and
  90% bands; weekly points for the first month, then monthly), on the index
  level axis with % changes on hover.
* "How these odds work, and what they aren't": four bullets plus today's
  parameters in one line.

Crisis replay tab
-----------------

* Crisis chips (one swipeable row on phones). Clicking one loads its window
  and starts playback.
* Date, the day's odds of a 10%+ fall within a month, an "approximate" note
  when the fit was stretched, play/pause and a scrubber.
* The fear landscape: a 3D implied-volatility surface (Plotly gl3d) computed
  in a Web Worker for the day. Strikes span −2.5 to +2 standard deviations
  **at that day's own volatility**, so the smile stays visible in calm and
  panicked markets; the vertical scale is fixed per episode so the landscape
  visibly rises and falls.
* What happened: a one-line description plus computed facts (S&P drawdown,
  peak VIX, peak odds).
* Timeline of the daily odds since 2009 with crisis windows shaded and a
  marker for the current day; click to jump.

Performance
-----------

* Playback is paced by the device: the next day is shown after at least
  three times the measured surface draw time (minimum 140 ms), and the worker
  prices with 512 cosine terms during replay.
* Charts resize only on width changes (mobile address-bar resizes are
  ignored); the surface is rebuilt if the browser drops the WebGL context.

Design
------

Colors are CSS custom properties with light and dark sets; charts redraw on
theme changes. Category colors were checked with a palette validator in both
modes. The pinned gl3d Plotly bundle (``plotly.js-gl3d-dist-min@2.35.2``,
with a subresource-integrity hash) provides both the 3D surface and the 2D
scatter traces.
