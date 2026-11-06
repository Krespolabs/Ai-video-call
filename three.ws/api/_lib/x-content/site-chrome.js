// Floating site chrome that follows a visitor across every route and parks
// itself over a corner of the viewport: the corner stack, the discovery card,
// the language switcher, the walk companion, the cookie banner. Each is one of
// our own features, which is exactly why none of them may sit in a frame that
// announces a different one. Framing them out is a crop, not an edit of the
// product surface.
//
// One list, shared by every capture path, so a new piece of chrome is hidden
// everywhere the day it is added here.

export const SITE_CHROME = [
	'#tws-corner-stack',
	'.tws-corner-item',
	'.tws-disc-card',
	'.tws-atlas-hint',
	'.twx-i18n-fab',
	'lang-switcher',
	'.walk-companion',
	'.walk-trail-layer',
	'.walk-c2w-fx',
	'#cookie-banner',
	'.cookie-banner',
	'[data-consent-banner]',
];

// A stylesheet installed before any page script runs holds regardless of when a
// node appears. Removing nodes once after load is not enough: the discovery
// card is injected on a timer and reappeared during the settle.
//
// `show` names chrome that is the subject of this capture and must stay: the
// walk companion is chrome on every page except the ones about what it does.
export const chromeStylesheet = (extra = [], show = []) => `${[...SITE_CHROME.filter((selector) => !show.includes(selector)), ...extra].join(',')}{display:none !important}`;
