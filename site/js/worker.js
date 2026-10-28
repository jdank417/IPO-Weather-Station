// Web Worker: computes the implied-vol surface off the main thread.
// Message in:  { id, params, Ts, ks }
// Message out: { id, iv, ms }  or  { id, error }

import { ivSurface } from './surface.js';

self.onmessage = (e) => {
  const { id, params, Ts, ks } = e.data;
  try {
    const t0 = performance.now();
    const iv = ivSurface(params, Ts, ks);
    self.postMessage({ id, iv, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
