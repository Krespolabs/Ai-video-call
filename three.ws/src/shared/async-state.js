/**
 * async-state — the one network/render boundary for data-driven surfaces.
 *
 * Wraps the loading → fetch → empty / error / retry lifecycle so every surface
 * fails into a *designed* state instead of a blank container or an unhandled
 * rejection. It is the orchestration layer on top of two existing modules:
 *
 *   - state-kit.js     → the skeleton / empty / error visual shells
 *   - error-messages.js → friendly, redacted copy for known failure causes
 *
 * Usage (the common case — one call wires all four states):
 *
 *   import { loadInto } from './shared/async-state.js';
 *
 *   loadInto(grid, {
 *     load:   () => api.listAgents().then((r) => r.agents),
 *     render: (agents, el) => { el.innerHTML = agents.map(card).join(''); },
 *     empty:  { title: 'No agents yet', body: 'Deploy your first agent to see it here.',
 *               actions: [{ label: 'Deploy', href: '/deploy', primary: true }] },
 *     skeleton: { count: 8, variant: 'card' },
 *     context: 'dashboard:agents',
 *   });
 *
 * On failure the container shows a retryable error state; clicking Retry re-runs
 * the same load. Technical detail still goes to console (via resolveError), so
 * this never *hides* an error from developers — it only stops users seeing a void.
 */

import {
	skeletonHTML,
	emptyStateHTML,
	errorStateHTML,
	ensureStateKitStyles,
} from './state-kit.js';
import { resolveError } from './error-messages.js';

/**
 * Default emptiness test: treats `null`/`undefined`, empty arrays, and
 * `{ items: [] }` / `{ length: 0 }` shapes as empty. Override via opts.isEmpty
 * for anything else.
 */
function defaultIsEmpty(data) {
	if (data == null) return true;
	if (Array.isArray(data)) return data.length === 0;
	if (typeof data.length === 'number') return data.length === 0;
	return false;
}

function renderSkeleton(container, skeleton) {
	if (skeleton === false) return;
	ensureStateKitStyles();
	if (typeof skeleton === 'string') {
		container.innerHTML = skeleton;
		return;
	}
	const { count = 6, variant = 'card', wrap } = skeleton || {};
	const html = skeletonHTML(count, variant);
	container.innerHTML = typeof wrap === 'function' ? wrap(html) : html;
}

/**
 * Run an async load with designed loading/empty/error/retry states.
 *
 * @param {Element} container  Element whose innerHTML hosts each state.
 * @param {object}  opts
 * @param {() => Promise<*>}      opts.load     Async data fetch. Throw to trigger the error state.
 * @param {(data, container) => void} opts.render  Render the populated state.
 * @param {(data) => boolean}    [opts.isEmpty] Emptiness test (default handles arrays / {items}).
 * @param {object|false}         [opts.skeleton] { count, variant, wrap } | HTML string | false.
 * @param {object}               [opts.empty]    emptyStateHTML opts ({ title, body, actions, icon }).
 * @param {object}               [opts.error]    errorStateHTML override ({ title, body }).
 * @param {string}               [opts.errorScope]  data attribute on the retry button.
 * @param {string}               [opts.context]  Console grouping label for resolveError.
 * @returns {Promise<*|null>} The loaded data, or null if it errored or was empty.
 */
export async function loadInto(container, opts = {}) {
	if (!container) return null;
	const {
		load,
		render,
		isEmpty = defaultIsEmpty,
		skeleton = { count: 6, variant: 'card' },
		empty,
		error,
		errorScope = '',
		context = 'async-state',
	} = opts;

	if (typeof load !== 'function' || typeof render !== 'function') {
		throw new Error('loadInto requires load() and render() functions');
	}

	renderSkeleton(container, skeleton);

	let data;
	try {
		data = await load();
	} catch (err) {
		renderError(container, err, { error, errorScope, context }, () =>
			loadInto(container, opts),
		);
		return null;
	}

	if (isEmpty(data)) {
		if (empty) {
			ensureStateKitStyles();
			container.innerHTML = emptyStateHTML(empty);
		} else {
			render(data, container);
		}
		return null;
	}

	render(data, container);
	return data;
}

/**
 * Render a retryable error state into a container and wire its Retry button.
 * Exposed for surfaces that own their own fetch loop but want the shared shell.
 *
 * @param {Element}  container
 * @param {*}        err        Anything resolveError accepts (Error/string/{status}).
 * @param {object}   [opts]     { error?: {title,body}, errorScope?, context? }
 * @param {Function} [onRetry]  Called when the user clicks Retry.
 */
export function renderError(container, err, opts = {}, onRetry) {
	if (!container) return;
	const { error, errorScope = '', context = 'async-state' } = opts;
	const friendly = resolveError(err, context); // logs technical detail to console
	ensureStateKitStyles();
	container.innerHTML = errorStateHTML({
		title: error?.title || friendly.title,
		body: error?.body || friendly.body,
		scope: errorScope,
	});
	if (typeof onRetry === 'function') {
		// Node is replaced on every render, so the listener dies with it — no leak.
		container.querySelector('[data-sk-retry]')?.addEventListener('click', onRetry);
	}
}

if (typeof window !== 'undefined') {
	window.twsAsyncState = { loadInto, renderError };
}
