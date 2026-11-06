// ── log.js — tiny gated logger for three.ws ─────────────────────────────────
//
// A production console should be quiet: noise hides real problems and looks
// unprofessional when a developer opens DevTools. This logger keeps verbose
// diagnostics (warn/info/debug/log) out of production consoles while letting
// genuine error reporting through, so operators still see what matters.
//
// Gating:
//   - In dev (`import.meta.env.DEV`) every level prints.
//   - In production, warn/info/debug/log are silenced UNLESS the developer
//     opts in via `?debug` in the URL or `localStorage['tws:debug'] = '1'`.
//   - `error` always prints — a real error on a healthy page is a bug to fix,
//     not noise to mute. Pair these with a user-facing state (see A04).
//
// Call sites already carry a `[tag]` prefix in the message, so the default
// `log` export is a drop-in for `console` — swap `console.` → `log.`. For new
// code, `createLogger('tag')` prefixes every line for you.

function debugFlagEnabled() {
	if (typeof window === 'undefined') return false;
	try {
		const params = new URLSearchParams(window.location.search);
		if (params.has('debug') && params.get('debug') !== '0') return true;
		if (window.localStorage?.getItem('tws:debug') === '1') return true;
	} catch {
		// Sandboxed iframe / storage disabled — treat as no opt-in.
	}
	return false;
}

// `import.meta.env.DEV` is statically replaced at build time, so in a prod
// bundle `VERBOSE` collapses to the debug-flag check evaluated once at load.
const IS_DEV = Boolean(import.meta.env?.DEV);
const VERBOSE = IS_DEV || debugFlagEnabled();

const noop = () => {};

// Bind directly to console methods so DevTools reports the real call site
// (file:line) instead of pointing every line back into this module.
const bind = (method) =>
	typeof console !== 'undefined' && typeof console[method] === 'function'
		? console[method].bind(console)
		: noop;

/**
 * The shared logger. `warn` / `info` / `debug` / `log` are gated; `error`
 * always emits.
 */
export const log = {
	error: bind('error'),
	warn: VERBOSE ? bind('warn') : noop,
	info: VERBOSE ? bind('info') : noop,
	debug: VERBOSE ? bind('debug') : noop,
	log: VERBOSE ? bind('log') : noop,
};

/**
 * Create a logger that prefixes every line with `[tag]`.
 * @param {string} tag short module identifier, e.g. 'marketplace'
 */
export function createLogger(tag) {
	const prefix = `[${tag}]`;
	const wrap = (fn) => (...args) => fn(prefix, ...args);
	return {
		error: wrap(bind('error')),
		warn: VERBOSE ? wrap(bind('warn')) : noop,
		info: VERBOSE ? wrap(bind('info')) : noop,
		debug: VERBOSE ? wrap(bind('debug')) : noop,
		log: VERBOSE ? wrap(bind('log')) : noop,
	};
}

/** Whether verbose diagnostics are currently enabled (dev or `?debug`). */
export const isVerbose = VERBOSE;

export default log;
