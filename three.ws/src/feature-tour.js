// Site-wide Feature Tour — three.ws integration entry.
// ====================================================
// The tour engine lives in src/feature-tour/. This file is the thin platform
// wiring, mirroring src/walk-companion.js: Vite emits it to the stable, unhashed
// path /feature-tour.js (see vite.config.js → rollupOptions.output.entryFileNames),
// and the 'feature-tour-boot' Vite plugin (vite.config.js) injects it with
// <script type="module"> on every page — but only when a tour is starting or
// already in progress — so a page that never runs the tour pays no Three.js cost.
// public/nav.js's "Take the tour" button drives it through window.__featureTour.

import { createFeatureTour } from './feature-tour/index.js';

const tour = createFeatureTour();

// nav.js (the "Take the tour" button) and the /tour page launch + resume the
// tour through this global. Keep the surface they rely on.
window.__featureTour = tour;

tour.bootstrap();
