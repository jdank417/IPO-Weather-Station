Architecture
============

Constraints
-----------

* The site is hosted on GitHub Pages only. There is no server, no database,
  and no runtime API call that needs a secret.
* Everything a visitor interacts with runs client-side in JavaScript
  (ES modules, no build step).
* Data arrives through GitHub Actions: a scheduled workflow fetches raw data,
  runs the Python calibration and estimation, and commits JSON under
  ``site/data/``. The site only reads that static JSON.
* Secrets such as ``FRED_API_KEY`` live in GitHub Actions secrets.
* Every third-party dependency is pinned: GitHub Actions by commit SHA,
  Python packages by exact version, CDN scripts by exact version.

Data flow
---------

::

   Cboe CSVs, FRED, Ritter (manual)
            |
            v
   pipeline/ (Python, in Actions)  --commit-->  site/data/*.json
                                                     |
                                                     v
                                      browser: COS pricer, IV solver,
                                      Hamilton filter, Plotly surface

Workflows
---------

``deploy.yml``
   Uploads ``site/`` as a Pages artifact and deploys it. Runs on pushes to
   ``main`` that touch ``site/``, on manual dispatch, and after the
   ``Update data`` workflow succeeds. The last trigger exists because commits
   pushed with the default ``GITHUB_TOKEN`` do not start other ``push``
   workflows.

``update-data.yml``
   Tuesday to Saturday at 01:23 and 11:17 UTC (after the US close; Cboe's
   refresh time varies). Runs the tests, then ``python -m pipeline.update``,
   and commits ``site/data/`` only if it changed.

``ci.yml``
   Runs the Python tests on pushes to ``main`` and on pull requests.

One-time repository setup
-------------------------

Settings → Pages → Build and deployment → Source: **GitHub Actions**.
