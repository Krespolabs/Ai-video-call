// @three-ws/tour — CDN <script> entry (dist/tour.global.js).
// ============================================================
// The one-tag install: an IIFE with three + @three-ws/walk inlined, exposed as
// `window.ThreeWsTour`. Dropping the script with `data-tour` auto-creates a
// tour from the tag's data-* attributes — no bundler, no import map:
//
//   <script src="https://unpkg.com/@three-ws/tour/dist/tour.global.js"
//           data-tour
//           data-curriculum="https://cdn.example.com/tour/curriculum.json"
//           data-avatar="realistic-female"
//           defer></script>
//
// Attributes → options:
//   data-curriculum   curriculum URL (required for auto-init)
//   data-avatar       guideAvatarId (default 'realistic-female')
//   data-asset-base   avatar GLB origin       (default 'https://three.ws')
//   data-manifest-url animation manifest      (default 'https://three.ws/animations/manifest.json')
//   data-tts-endpoint optional TTS endpoint — omit for paced captions
//   data-mode         'guided' (default) | 'explore' | 'platformer' — explore
//                     lets the visitor drive the avatar with arrow keys /
//                     joystick to glowing GTA-style checkpoints; platformer is
//                     explore with gravity and jumping (the page's DOM is solid
//                     ground). Visitors can switch the two live with M.
//   data-autostart    'full' | 'quick' — start immediately on load
//
// Any element with [data-tour-start] becomes a start button
// (data-tour-start="quick" for the Quick track). The controller is exposed as
// window.__featureTour, matching the documented app-style global.
//
// Sites that bundle keep using the side-effect-free ESM entry (./index.js);
// this module is only ever the IIFE's entry point.

import { createFeatureTour } from './index.js';

export * from './index.js';

const CDN_ASSET_BASE = 'https://three.ws';
const CDN_MANIFEST = 'https://three.ws/animations/manifest.json';

function autoInit() {
	if (window.__featureTour) return; // idempotent — first tagged script wins
	const tag = document.currentScript || document.querySelector('script[data-tour]');
	if (!tag || !tag.hasAttribute('data-tour')) return;

	const d = tag.dataset;
	if (!d.curriculum) {
		console.warn('[three-ws/tour] <script data-tour> needs data-curriculum="<url>"');
		return;
	}

	const tour = createFeatureTour({
		curriculum: d.curriculum,
		guideAvatarId: d.avatar || 'realistic-female',
		assetBase: d.assetBase || CDN_ASSET_BASE,
		manifestUrl: d.manifestUrl || CDN_MANIFEST,
		ttsEndpoint: d.ttsEndpoint || null,
		mode: d.mode === 'explore' || d.mode === 'platformer' ? d.mode : 'guided',
	});
	window.__featureTour = tour;
	tour.bootstrap();

	// Wire every [data-tour-start] element as a start button, including ones
	// added later (themes and section editors inject markup after load).
	const wire = (root) => {
		for (const el of root.querySelectorAll('[data-tour-start]')) {
			if (el.__twsTourWired) continue;
			el.__twsTourWired = true;
			el.addEventListener('click', (e) => {
				e.preventDefault();
				tour.start(el.getAttribute('data-tour-start') === 'quick' ? 'quick' : 'full');
			});
		}
	};
	wire(document);
	new MutationObserver(() => wire(document)).observe(document.body, { childList: true, subtree: true });

	if (d.autostart) tour.start(d.autostart === 'quick' ? 'quick' : 'full');
}

if (typeof window !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', autoInit, { once: true });
	} else {
		autoInit();
	}
}
