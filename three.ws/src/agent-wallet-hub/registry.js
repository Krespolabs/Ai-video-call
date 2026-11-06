/**
 * Agent Wallet hub — tab registry.
 *
 * The hub is built so each tab self-registers in ITS OWN file. A later task
 * (deposit/trade/snipe/pay/withdraw) ships its tab by:
 *   1. writing `src/agent-wallet-hub/tabs/<name>.js` that calls
 *      `registerWalletTab({ ... })` at import time, and
 *   2. importing that file once from `src/agent-wallet-hub/index.js`.
 *
 * It never edits a shared array of tab definitions — registration is a side
 * effect of importing the tab module. `order` keeps the tab strip stable
 * regardless of import order.
 *
 * A tab definition:
 *   {
 *     id:      'balance',          // unique, used in the URL hash + data attrs
 *     label:   'Balance',          // tab strip text
 *     order:   10,                 // ascending sort key
 *     ownerOnly: false,            // hide from non-owner (read-only) viewers
 *     mount({ panel, ctx }) { ... return { destroy?, onShow?, onHide? } }
 *   }
 *
 * `ctx` (shared hub context) gives every tab the same primitives:
 *   { agentId, isOwner, network, getNetwork, onNetworkChange, escapeHtml,
 *     shortAddress, copyToClipboard, toast }
 */

const _tabs = new Map();

/**
 * Register a wallet hub tab. Idempotent per id (HMR / double-import safe): a
 * later registration with the same id replaces the earlier one.
 * @param {{ id: string, label: string, order?: number, ownerOnly?: boolean,
 *           mount: (args: { panel: HTMLElement, ctx: object }) => (object|void) }} def
 */
export function registerWalletTab(def) {
	if (!def || !def.id || typeof def.mount !== 'function') {
		throw new Error('registerWalletTab requires { id, label, mount }');
	}
	_tabs.set(def.id, {
		id: def.id,
		label: def.label || def.id,
		order: Number.isFinite(def.order) ? def.order : 100,
		ownerOnly: !!def.ownerOnly,
		mount: def.mount,
	});
}

/** All registered tabs, sorted by `order` then label. */
export function getRegisteredTabs() {
	return [..._tabs.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** The tabs a given viewer may see (owner-only tabs hidden from visitors). */
export function getVisibleTabs(isOwner) {
	return getRegisteredTabs().filter((t) => isOwner || !t.ownerOnly);
}
