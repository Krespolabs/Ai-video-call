// Acquisition instrumentation — fires the landing view + delegated CTA clicks.
//
// Imported by the home page. It records:
//   • LANDING_VIEWED once on load, with referrer + UTM source/medium/campaign
//     and the current path (no PII — query params other than utm_* are dropped).
//   • CTA_CLICKED for any element carrying `data-cta` (and optional
//     `data-cta-loc`), via a single delegated listener so new CTAs are picked up
//     without per-button wiring.
//
// All tracking goes through the analytics facade, which no-ops when PostHog
// isn't loaded — so this never blocks navigation or breaks the page.

import { track, ANALYTICS_EVENTS, FUNNELS, trackFunnelStep } from './analytics.js';

function utmParams() {
	try {
		const q = new URLSearchParams(location.search);
		const out = {};
		for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
			const v = q.get(key);
			if (v) out[key] = v.slice(0, 120);
		}
		return out;
	} catch {
		return {};
	}
}

let _landingTracked = false;

/** Fire LANDING_VIEWED once, as the first step of the activation funnel. */
export function trackLandingView() {
	if (_landingTracked) return;
	_landingTracked = true;
	trackFunnelStep('activation', ANALYTICS_EVENTS.LANDING_VIEWED, {
		path: location.pathname,
		referrer: document.referrer ? new URL(document.referrer).host : undefined,
		...utmParams(),
	});
}

/**
 * Wire a single delegated click listener that fires CTA_CLICKED for any
 * ancestor carrying `data-cta`. Idempotent — safe to call more than once.
 */
export function wireCtaTracking(root = document) {
	if (root.__ctaTrackingWired) return;
	root.__ctaTrackingWired = true;
	root.addEventListener(
		'click',
		(e) => {
			const el = e.target?.closest?.('[data-cta]');
			if (!el) return;
			track(ANALYTICS_EVENTS.CTA_CLICKED, {
				cta: el.getAttribute('data-cta'),
				location: el.getAttribute('data-cta-loc') || 'home',
			});
		},
		// Capture phase so the event is recorded even if the handler that
		// triggers navigation calls stopPropagation().
		true,
	);
}

/** Convenience: fire the landing view and wire CTA delegation for this page. */
export function initAcquisitionAnalytics() {
	trackLandingView();
	wireCtaTracking();
}

// Re-exported so call sites that already import this module don't also need the
// raw facade for funnel steps.
export { FUNNELS };
