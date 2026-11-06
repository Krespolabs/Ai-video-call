/**
 * Mission Control — execution. A thin, fast layer over the REAL guarded trade
 * path: POST /api/agents/:id/solana/trade (server-signed, firewall + MEV + spend
 * guard + custody audit enforced server-side). This module NEVER bypasses any of
 * that — it only sequences the same calls the wallet hub's Trade tab makes, with
 * confirm-on-first-use then express mode for keyboard-speed trading.
 */

import {
	previewAgentTrade,
	executeAgentTrade,
	fetchAgentHoldings,
	TradeError,
} from '../agent-solana-wallet.js';
import { confirmModal, toast } from './ui.js';
import { explorerTxUrl, formatSol, formatCompact } from './format.js';

const DEFAULT_SLIPPAGE_BPS = 300; // 3% — matches the server default

function uuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return `mc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function friendlyError(e) {
	if (e instanceof TradeError) {
		switch (e.code) {
			case 'firewall_blocked':
				return 'Firewall blocked this trade — the coin failed a safety check.';
			case 'insufficient_funds':
				return 'Not enough SOL in the agent wallet for this trade.';
			case 'spend_limit_exceeded':
			case 'daily_budget_exceeded':
				return 'This trade would exceed the wallet’s spend guard.';
			case 'slippage_exceeded':
				return 'Price moved past your slippage — trade not sent.';
			case 'network_error':
				return 'Network unreachable — check your connection and retry.';
			default:
				return e.message || 'Trade failed.';
		}
	}
	return e?.message || 'Trade failed.';
}

async function ensureConfirmed(store, { side, mint, sizeDesc }) {
	const agent = store.getAgent();
	if (store.isExpress(agent.id)) return true;
	const ok = await confirmModal({
		title: side === 'buy' ? 'Confirm buy' : 'Confirm sell',
		body:
			`You're about to <b>${side}</b> <b class="mc-mono">${mint.slice(0, 4)}…${mint.slice(-4)}</b>` +
			` ${sizeDesc} from <b>${escapeName(agent.name)}</b>'s wallet on <b>${store.getNetwork()}</b>.` +
			` Every trade runs through the firewall + MEV engine.<br><br>` +
			`<span style="color:var(--ink-faint,#666)">After this, trades execute instantly (express mode). Toggle it off anytime with <kbd>x</kbd>.</span>`,
		confirmLabel: side === 'buy' ? 'Buy' : 'Sell',
		tone: side,
	});
	if (ok) store.setExpress(agent.id);
	return ok;
}

function escapeName(s) {
	return String(s ?? 'agent').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/** Execute a buy of `solAmount` SOL into `mint`. Returns the result or null. */
export async function buy({ store, bus, mint, solAmount }) {
	const agent = store.getAgent();
	if (!agent?.id) { toast('Select a trading agent first.', { tone: 'err' }); return null; }
	if (!(solAmount > 0)) { toast('Pick a buy size first.', { tone: 'warn' }); return null; }

	// Fast client-side gate on the cached firewall verdict — the server is the real
	// gate, this just spares an obviously-blocked round trip and explains why.
	const row = store.getRow(mint);
	if (row?.safety?.verdict === 'block') {
		toast('Firewall has this coin blocked — it likely can’t be sold.', { tone: 'err' });
		return null;
	}

	if (!(await ensureConfirmed(store, { side: 'buy', mint, sizeDesc: `for ${formatSol(solAmount)} SOL` }))) return null;

	bus.emit('trade:pending', { mint, side: 'buy' });
	try {
		const res = await executeAgentTrade({
			agentId: agent.id, side: 'buy', mint, solAmount,
			slippageBps: DEFAULT_SLIPPAGE_BPS, network: store.getNetwork(), idempotencyKey: uuid(),
		});
		const out = res?.out;
		toast(
			`Bought ${formatCompact(out?.amount)} ${out?.asset === 'TOKEN' ? (row?.symbol || 'tokens') : out?.asset || 'tokens'}`,
			{ tone: 'ok', link: res?.signature ? { href: explorerTxUrl(res.signature, store.getNetwork()), label: 'View ↗' } : null },
		);
		bus.emit('trade:done', { mint, side: 'buy', result: res });
		return res;
	} catch (e) {
		toast(friendlyError(e), { tone: 'err' });
		bus.emit('trade:error', { mint, side: 'buy', error: e });
		return null;
	}
}

/** Resolve the full raw token balance the agent holds for `mint` (for a 100% exit). */
export async function holdingRawFor(store, mint) {
	const agent = store.getAgent();
	if (!agent?.id) return null;
	try {
		const data = await fetchAgentHoldings(agent.id, store.getNetwork());
		const t = (data?.tokens || []).find((x) => x.mint === mint);
		return t ? { amount_raw: t.amount_raw, ui_amount: t.ui_amount, decimals: t.decimals } : null;
	} catch {
		return null;
	}
}

/**
 * Sell tokens of `mint`. Pass an explicit `tokenAmountRaw`, or omit it to sell
 * the full on-chain balance (quick exit). Returns the result or null.
 */
export async function sell({ store, bus, mint, tokenAmountRaw, label }) {
	const agent = store.getAgent();
	if (!agent?.id) { toast('Select a trading agent first.', { tone: 'err' }); return null; }

	let raw = tokenAmountRaw;
	let uiHint = label;
	if (raw == null) {
		const h = await holdingRawFor(store, mint);
		if (!h || !(Number(h.amount_raw) > 0)) {
			toast('No balance to sell for this coin.', { tone: 'warn' });
			return null;
		}
		raw = h.amount_raw;
		uiHint = uiHint || `${formatCompact(h.ui_amount)} tokens`;
	}

	if (!(await ensureConfirmed(store, { side: 'sell', mint, sizeDesc: uiHint ? `(${uiHint})` : '' }))) return null;

	bus.emit('trade:pending', { mint, side: 'sell' });
	try {
		const res = await executeAgentTrade({
			agentId: agent.id, side: 'sell', mint, tokenAmountRaw: String(raw),
			slippageBps: DEFAULT_SLIPPAGE_BPS, network: store.getNetwork(), idempotencyKey: uuid(),
		});
		toast(
			`Sold for ${formatSol(res?.out?.amount)} SOL`,
			{ tone: 'ok', link: res?.signature ? { href: explorerTxUrl(res.signature, store.getNetwork()), label: 'View ↗' } : null },
		);
		bus.emit('trade:done', { mint, side: 'sell', result: res });
		return res;
	} catch (e) {
		toast(friendlyError(e), { tone: 'err' });
		bus.emit('trade:error', { mint, side: 'sell', error: e });
		return null;
	}
}

/** Live, non-binding quote (used by the focus pane to preview before execution). */
export async function quote({ store, side, mint, solAmount, tokenAmountRaw }) {
	const agent = store.getAgent();
	if (!agent?.id) throw new TradeError('No trading agent selected.', { code: 'no_agent' });
	return previewAgentTrade({
		agentId: agent.id, side, mint, solAmount, tokenAmountRaw,
		slippageBps: DEFAULT_SLIPPAGE_BPS, network: store.getNetwork(),
	});
}
