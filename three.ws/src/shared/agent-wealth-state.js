/**
 * Embodied Finance — the agent's live wealth state, the single source of truth
 * for the DYNAMICS that ride on top of the static net-worth aura.
 *
 * `wallet-networth.js` answers "how much is this wallet worth, and therefore how
 * bright is its baseline aura." This module answers the second, livelier half:
 * "is this agent earning *right now*?" It turns the agent's real custody flow
 * (24h net momentum, money streams crediting it this second, the recency of its
 * last tip) into a small, honest dynamics descriptor that every surface — the
 * 3D avatar, the galaxy star, IRL/AR, the 2D chip — applies the same way, so a
 * given agent reads at the same "wealth tier AND wealth trend" everywhere.
 *
 * Every number is real. It comes from GET /api/agents/:id/solana/networth, whose
 * `flow` block is computed server-side from agent_custody_events (confirmed tips
 * in, spends/withdraws out) and the live balance read — the same endpoint the
 * presence panel uses, fetched once and shared. Nothing here invents a trend: a
 * flat wallet returns a flat (neutral) dynamic, an RPC outage returns the same
 * neutral state, never a misleading "rich/earning" glow.
 *
 * $THREE is the only coin this platform names; flow is coin-agnostic USD value.
 */

import { tierForUsd, NETWORTH_TIERS } from './wallet-networth.js';

// A tip counts as "fresh" (worthy of a recency glow) for this long after it
// lands. Short enough that the glow means "just now," not "earlier today."
const RECENT_TIP_MS = 120_000;

// Client-side cache mirrors the server's 60s wallet-read window so a page with
// the same agent on multiple surfaces (card + hero + galaxy) makes one request.
const CACHE_TTL_MS = 60_000;
const _cache = new Map(); // key -> { at, state }
const _inflight = new Map(); // key -> Promise<state>

function agentIdOf(agent) {
	if (!agent) return null;
	if (typeof agent === 'string') return agent;
	return agent.agent_id || agent.agentId || agent.id || null;
}

/** A coherent neutral state — what every soft-failure path returns. Never faked. */
function neutralState(agentId, network) {
	return {
		agentId, network,
		tier: 'dormant', tierLabel: 'Dormant', level: 0,
		balanceSol: 0, balanceUsd: 0,
		momentum: 0, momentumUsd24h: 0, inflowUsd24h: 0, outflowUsd24h: 0,
		streamingNow: 0, lastTipAt: null,
		holdsThree: false, prefs: null,
		isOwner: false, ok: false,
	};
}

/**
 * Fetch + normalize an agent's live wealth state into the canonical contract
 * the task defines: { tier, balanceSol, balanceUsd, momentum, streamingNow,
 * lastTipAt, holdsThree, prefs, isOwner } (plus the raw USD figures for the
 * owner's "why" breakdown and an `ok` flag the caller can use to decide whether
 * to keep its last real state).
 *
 * @param {string|object} agent  an agent id or any record holding one
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network]
 * @param {boolean} [opts.fresh]  bypass the 60s client cache
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<WealthState>}
 */
export async function fetchWealthState(agent, opts = {}) {
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = agentIdOf(agent);
	if (!agentId) return neutralState(null, network);
	const key = `${agentId}:${network}`;

	if (!opts.fresh) {
		const hit = _cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
		const pending = _inflight.get(key);
		if (pending) return pending;
	}

	const p = (async () => {
		try {
			const r = await fetch(
				`/api/agents/${encodeURIComponent(agentId)}/solana/networth`,
				{ headers: { accept: 'application/json' }, credentials: 'include', signal: opts.signal },
			);
			if (!r.ok) {
				// 404 = no agent; 502 = RPC holding-last-state. Both → neutral; the
				// caller keeps whatever real state it already had rather than snapping.
				return neutralState(agentId, network);
			}
			const body = await r.json().catch(() => null);
			const d = body?.data;
			const flow = d?.flow || {};
			const state = normalizeWealth(agentId, network, d, flow);
			_cache.set(key, { at: Date.now(), state });
			return state;
		} catch {
			return neutralState(agentId, network); // network/abort — hold-last-state
		} finally {
			_inflight.delete(key);
		}
	})();
	_inflight.set(key, p);
	return p;
}

/** Map the server `flow` block (+ portfolio) onto the canonical wealth state. */
function normalizeWealth(agentId, network, data, flow) {
	const balanceUsd = Number(flow.balance_usd ?? data?.portfolio?.usd) || 0;
	const balanceSol = Number(flow.balance_sol ?? data?.portfolio?.sol) || 0;
	const t = data?.tier?.key ? data.tier : tierForUsd(balanceUsd);
	// $THREE is the only coin the platform names; holding it earns the brand accent
	// on the avatar and nameplate. Real holding from the same canonical read — the
	// `portfolio.three` block is present only when the agent actually holds $THREE.
	const three = data?.portfolio?.three;
	const holdsThree = !!(three && (Number(three.amount) > 0 || Number(three.usd) > 0));
	return {
		agentId, network,
		tier: t.key || flow.tier || 'dormant',
		tierLabel: t.label || NETWORTH_TIERS.find((x) => x.key === t.key)?.label || 'Dormant',
		level: Number.isFinite(t.index) ? t.index : (NETWORTH_TIERS.find((x) => x.key === t.key)?.level ?? 0),
		balanceSol,
		balanceUsd,
		momentum: clamp(Number(flow.momentum) || 0, -1, 1),
		momentumUsd24h: Number(flow.momentum_usd_24h) || 0,
		inflowUsd24h: Number(flow.inflow_usd_24h) || 0,
		outflowUsd24h: Number(flow.outflow_usd_24h) || 0,
		streamingNow: Math.max(0, Number(flow.streaming_now) || 0),
		lastTipAt: flow.last_tip_at || null,
		holdsThree,
		// The owner's saved presentation prefs travel with the state so a surface that
		// reads the wealth state (the living-avatar nameplate) honours how the owner
		// configured the agent without a second request. Raw here; consumers normalize.
		prefs: data?.prefs || null,
		isOwner: !!data?.is_owner,
		ok: true,
	};
}

/**
 * Pure real-data → dynamics descriptor: the live modifiers a surface layers on
 * top of the static net-worth visual. Deterministic given (state, now); no
 * random. `now` is injected so this stays testable.
 *
 * @returns {{
 *   trend, momentum, intensityDelta, warmth, streaming, streamingCount,
 *   recentTip, recentTipAgeMs
 * }}
 */
export function computeWealthDynamics(state, now = Date.now()) {
	const m = clamp(Number(state?.momentum) || 0, -1, 1);
	// Momentum nudges the aura intensity within a small, tasteful band so an
	// earning agent glows a touch warmer and a bleeding one dims honestly —
	// never enough to overpower the tier itself.
	const intensityDelta = m * 0.16;
	// Warmth shifts the accent toward gold on inflow, toward cool on outflow.
	const warmth = m; // -1 cool … +1 warm
	const trend = m > 0.04 ? 'up' : m < -0.04 ? 'down' : 'flat';

	const streamingCount = Math.max(0, Number(state?.streamingNow) || 0);
	const streaming = streamingCount > 0;

	let recentTip = false;
	let recentTipAgeMs = Infinity;
	if (state?.lastTipAt) {
		const t = Date.parse(state.lastTipAt);
		if (Number.isFinite(t)) {
			recentTipAgeMs = now - t;
			recentTip = recentTipAgeMs >= 0 && recentTipAgeMs < RECENT_TIP_MS;
		}
	}
	return { trend, momentum: m, intensityDelta, warmth, streaming, streamingCount, recentTip, recentTipAgeMs };
}

/** Short, honest momentum label, e.g. "+$12 today" / "—" / "−$4 today". */
export function formatMomentum(state) {
	const v = Number(state?.momentumUsd24h) || 0;
	if (v === 0) return '—';
	const sign = v > 0 ? '+' : '−';
	const a = Math.abs(v);
	const num = a < 1 ? a.toFixed(2) : a < 1000 ? Math.round(a).toString() : `${(a / 1000).toFixed(1)}k`;
	return `${sign}$${num} today`;
}

/** Invalidate the client cache for an agent (e.g. right after a confirmed tip). */
export function invalidateWealthState(agentId, network = 'mainnet') {
	_cache.delete(`${agentIdOf(agentId)}:${network}`);
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || 0)); }

export const _internals = { RECENT_TIP_MS, CACHE_TTL_MS, normalizeWealth, neutralState };

if (typeof window !== 'undefined') {
	window.twsWealthState = { fetchWealthState, computeWealthDynamics, formatMomentum, invalidateWealthState };
}
