// @three-ws/strategies — automated on-chain trading strategies for agents.
// Thin client over the public three.ws strategy endpoints: DCA
// (/api/dca-strategies), copy-trading (/api/copy/*), custodial mirror
// (/api/agents/:id/mirror), and ownable Strategy Objects (/api/strategies).
// Every order still passes the agent's server-side spend leash — this SDK only
// shapes the requests and parses the responses. See README.md for the reference.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// The README names the package's typed error `StrategyError`; it is the same
// shared error the http core throws (stable `code` + HTTP `status`), aliased so
// `instanceof StrategyError` reads naturally for strategy callers.
export { ThreeWsError as StrategyError } from './http.js';

const DCA_INTERVALS = { daily: 86400, weekly: 604800 };
const COPY_SIZING = ['fixed', 'multiplier', 'pct_balance'];
const MIRROR_SIZING = ['fixed', 'proportional', 'pct_balance'];
const NETWORKS = ['mainnet', 'devnet'];
const LIST_SCOPES = ['mine', 'published'];
const LIST_SORTS = ['recent', 'forks', 'equips', 'performance'];
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create a Strategies client bound to a base URL, fetch, and three.ws auth.
 * For most callers the zero-config default functions (`dca()`, `copy()`,
 * `mirror()`, …) are enough; use this when you want to reuse configuration —
 * a bearer `token`, a custom origin, a default `network`, or a `csrfToken` for
 * cookie-session writes — across many calls.
 *
 * @param {object} [options]
 * @param {string} [options.token]      Bearer token. Omit to rely on the three.ws session cookie.
 * @param {string} [options.baseUrl]    API origin (default https://three.ws).
 * @param {typeof fetch} [options.fetch] fetch implementation (default global fetch; pass a payment-aware fetch to auto-settle 402s).
 * @param {'mainnet'|'devnet'} [options.network]  Default network for copy/mirror calls.
 * @param {string} [options.csrfToken]  Required for cookie-session writes (bearer clients are exempt).
 * @param {Record<string,string>} [options.headers]  Extra default headers.
 */
export function createStrategies(options = {}) {
	// The shared http core attaches the bearer as `Authorization`; map our
	// ergonomic `token` onto its `apiKey`, and pass the cookie session through.
	const defaultNetwork = NETWORKS.includes(options.network) ? options.network : 'mainnet';
	const baseHeaders = { ...(options.headers || {}) };
	if (options.csrfToken) baseHeaders['x-csrf-token'] = options.csrfToken;
	const request = createHttp({
		baseUrl: options.baseUrl,
		fetch: options.fetch,
		apiKey: options.token || options.apiKey,
		headers: baseHeaders,
	});

	// ── DCA — POST/GET/DELETE /api/dca-strategies ────────────────────────────

	/** Create a dollar-cost-averaging strategy; the platform cron runs it each interval. */
	async function dca(input = {}, opts = {}) {
		requireUuid(input.agentId, 'agentId');
		requireUuid(input.delegationId, 'delegationId');
		requireEthAddress(input.tokenIn, 'tokenIn');
		requireEthAddress(input.tokenOut, 'tokenOut');
		requireNonEmpty(input.tokenOutSymbol, 'tokenOutSymbol');
		requireWeiString(input.amountPerExecution, 'amountPerExecution');
		const periodSeconds = intervalSeconds(input.interval);
		const slippageBps = input.slippageBps === undefined ? 50 : intInRange(input.slippageBps, 1, 500, 'slippageBps');

		const body = prune({
			agent_id: input.agentId,
			delegation_id: input.delegationId,
			chain_id: input.chainId,
			token_in: input.tokenIn,
			token_out: input.tokenOut,
			token_out_symbol: input.tokenOutSymbol,
			amount_per_execution: input.amountPerExecution,
			period_seconds: periodSeconds,
			slippage_bps: slippageBps,
		});
		const res = await request('/api/dca-strategies', { method: 'POST', body, signal: opts.signal });
		return shapeDca(res);
	}

	/** List an agent's DCA strategies (each row carries its last execution). */
	async function listDca(agentId, opts = {}) {
		requireUuid(agentId, 'agentId');
		const res = await request('/api/dca-strategies', { query: { agent_id: agentId }, signal: opts.signal });
		return (res?.data || []).map(shapeDca);
	}

	/** Cancel an active DCA strategy. */
	async function cancelDca(strategyId, opts = {}) {
		requireUuid(strategyId, 'strategyId');
		const res = await request(`/api/dca-strategies/${strategyId}`, { method: 'DELETE', signal: opts.signal });
		return { ok: Boolean(res?.ok), raw: res };
	}

	// ── Copy — /api/copy/subscriptions + /api/copy/executions ────────────────

	/** Subscribe to a public leader; the copy engine drops sized, non-custodial intents into your inbox. */
	async function copy(leaderAgentId, input = {}, opts = {}) {
		requireUuid(leaderAgentId, 'leaderAgentId');
		const wallet = String(input.copierWallet || '').trim();
		if (!BASE58_RE.test(wallet)) {
			throw new ThreeWsError('copierWallet must be a valid Solana (base58) address.', { code: 'invalid_input' });
		}
		const sizingRule = input.sizingRule === undefined ? 'fixed' : enumValue(input.sizingRule, COPY_SIZING, 'sizingRule');
		const network = input.network === undefined ? defaultNetwork : enumValue(input.network, NETWORKS, 'network');

		const body = prune({
			leader_agent_id: leaderAgentId,
			copier_wallet: wallet,
			network,
			sizing_rule: sizingRule,
			fixed_sol: input.fixedSol,
			multiplier: input.multiplier,
			pct_balance: input.pctBalance,
			per_trade_cap_sol: input.perTradeCapSol,
			min_order_sol: input.minOrderSol,
			daily_budget_sol: input.dailyBudgetSol,
			max_open_copies: input.maxOpenCopies,
			mcap_floor_usd: input.mcapFloorUsd,
			mcap_ceiling_usd: input.mcapCeilingUsd,
			copy_sells: input.copySells,
			require_safety_pass: input.requireSafetyPass,
			min_oracle_score: input.minOracleScore,
			perf_fee_bps: input.perfFeeBps,
			telegram_chat_id: input.telegramChatId,
		});
		const res = await request('/api/copy/subscriptions', { method: 'POST', body, signal: opts.signal });
		return shapeSubscription(res?.subscription);
	}

	/** List your copy subscriptions (with leader info + pending/acted counts). */
	async function listSubscriptions(opts = {}) {
		const res = await request('/api/copy/subscriptions', { signal: opts.signal });
		return (res?.subscriptions || []).map(shapeSubscription);
	}

	/** Read your non-custodial copy-intent inbox (`pending` by default). */
	async function copyExecutions({ status, limit } = {}, opts = {}) {
		const res = await request('/api/copy/executions', {
			query: prune({ status, limit }),
			signal: opts.signal,
		});
		return { executions: (res?.executions || []).map(shapeExecution), raw: res };
	}

	/** Record that you acted on a pending intent from your own wallet. */
	async function actCopy(executionId, txSignature, opts = {}) {
		requireUuid(executionId, 'executionId');
		const res = await request('/api/copy/executions', {
			method: 'POST',
			body: prune({ id: executionId, action: 'acted', tx_signature: txSignature }),
			signal: opts.signal,
		});
		return shapeExecution(res?.execution);
	}

	/** Dismiss a pending intent without acting on it. */
	async function dismissCopy(executionId, opts = {}) {
		requireUuid(executionId, 'executionId');
		const res = await request('/api/copy/executions', {
			method: 'POST',
			body: { id: executionId, action: 'dismissed' },
			signal: opts.signal,
		});
		return shapeExecution(res?.execution);
	}

	/** Pause a subscription (keeps history; resumes on the next `copy()`). */
	async function pauseCopy(subscriptionId, opts = {}) {
		return setSubscriptionStatus(subscriptionId, 'paused', opts);
	}

	/** Stop a subscription (soft — keeps history). */
	async function stopCopy(subscriptionId, opts = {}) {
		return setSubscriptionStatus(subscriptionId, 'stopped', opts);
	}

	async function setSubscriptionStatus(subscriptionId, status, opts = {}) {
		requireUuid(subscriptionId, 'subscriptionId');
		const res = await request('/api/copy/subscriptions', {
			method: 'POST',
			body: { id: subscriptionId, status },
			signal: opts.signal,
		});
		return shapeSubscription(res?.subscription);
	}

	// ── Mirror — custodial follow over /api/agents/:id/mirror ─────────────────

	/** Custodial follow: your agent's wallet sizes and lands the leader's trades through the leashed runtime. */
	async function mirror(agentId, leaderAgentId, input = {}, opts = {}) {
		requireUuid(agentId, 'agentId');
		requireUuid(leaderAgentId, 'leaderAgentId');
		const sizingMode = input.sizingMode === undefined ? 'proportional' : enumValue(input.sizingMode, MIRROR_SIZING, 'sizingMode');
		const network = input.network === undefined ? defaultNetwork : enumValue(input.network, NETWORKS, 'network');

		const body = prune({
			leader_agent_id: leaderAgentId,
			network,
			enabled: input.enabled,
			sizing_mode: sizingMode,
			fixed_sol: input.fixedSol,
			proportion_pct: input.proportionPct,
			pct_balance: input.pctBalance,
			max_per_trade_sol: input.maxPerTradeSol,
			daily_budget_sol: input.dailyBudgetSol,
			min_leader_sol: input.minLeaderSol,
			copy_sells: input.copySells,
			mint_allowlist: input.mintAllowlist,
			mint_denylist: input.mintDenylist,
		});
		const res = await request(`/api/agents/${agentId}/mirror`, { method: 'POST', body, signal: opts.signal });
		return shapeFollow(res?.data?.follow);
	}

	/** Remove a mirror follow edge. */
	async function unmirror(agentId, leaderAgentId, opts = {}) {
		requireUuid(agentId, 'agentId');
		requireUuid(leaderAgentId, 'leaderAgentId');
		const res = await request(`/api/agents/${agentId}/mirror/unfollow`, {
			method: 'POST',
			body: { leader_agent_id: leaderAgentId },
			signal: opts.signal,
		});
		return { removed: Boolean(res?.data?.removed), raw: res };
	}

	/** Toggle the agent-wide mirror kill switch (global halt for this agent's follows). */
	async function killSwitch(agentId, engaged, opts = {}) {
		requireUuid(agentId, 'agentId');
		const res = await request(`/api/agents/${agentId}/mirror/kill`, {
			method: 'POST',
			body: { killed: engaged === true },
			signal: opts.signal,
		});
		return { killed: Boolean(res?.data?.killed), raw: res };
	}

	/** "Run now": process the leader's pending trades through this agent's follows immediately. */
	async function sweep(agentId, opts = {}) {
		requireUuid(agentId, 'agentId');
		const res = await request(`/api/agents/${agentId}/mirror/sync`, { method: 'POST', signal: opts.signal });
		return { synced: res?.data?.synced || [], raw: res };
	}

	/** Live mirror state: follows, recent fills, kill switch, follower counts. */
	async function equipped(agentId, opts = {}) {
		requireUuid(agentId, 'agentId');
		const res = await request(`/api/agents/${agentId}/mirror`, { signal: opts.signal });
		const d = res?.data || {};
		return {
			isOwner: Boolean(d.is_owner),
			killed: Boolean(d.killed),
			following: (d.following || []).map(shapeFollow),
			followingCount: Number(d.following_count || 0),
			followersCount: Number(d.followers_count || 0),
			activeFollowers: Number(d.active_followers || 0),
			recent: (d.recent || []).map(shapeFill),
			raw: res,
		};
	}

	// ── Strategy Objects — /api/strategies ───────────────────────────────────

	/** Author a rule set (validated server-side before it persists). */
	async function createStrategy({ name, description, config } = {}, opts = {}) {
		requireNonEmpty(name, 'name');
		const res = await request('/api/strategies', {
			method: 'POST',
			body: prune({ name, description, config }),
			signal: opts.signal,
		});
		return shapeStrategy(res?.data);
	}

	/** Browse strategies (`scope=mine|published`, `sort`, `q`). */
	async function listStrategies({ scope, sort, q, limit, author, agent } = {}, opts = {}) {
		const query = prune({
			scope: scope === undefined ? undefined : enumValue(scope, LIST_SCOPES, 'scope'),
			sort: sort === undefined ? undefined : enumValue(sort, LIST_SORTS, 'sort'),
			q,
			limit,
			author,
			agent,
		});
		const res = await request('/api/strategies', { query, signal: opts.signal });
		const d = res?.data || {};
		return {
			scope: d.scope || null,
			sort: d.sort || null,
			strategies: (d.strategies || []).map(shapeStrategy),
			raw: res,
		};
	}

	/** One strategy + live performance + equip count. */
	async function getStrategy(strategyId, opts = {}) {
		requireUuid(strategyId, 'strategyId');
		const res = await request(`/api/strategies/${strategyId}`, { signal: opts.signal });
		return shapeStrategy(res?.data);
	}

	/** Proven published strategies ranked by real ROI. */
	async function leaderboard({ limit } = {}, opts = {}) {
		const res = await request('/api/strategies/leaderboard', { query: prune({ limit }), signal: opts.signal });
		const d = res?.data || {};
		return { leaders: (d.leaders || []).map(shapeStrategy), count: Number(d.count || 0), raw: res };
	}

	/** Fork the RULES of a strategy into your library (no wallet access transferred). */
	async function forkStrategy(strategyId, opts = {}) {
		requireUuid(strategyId, 'strategyId');
		const res = await request(`/api/strategies/${strategyId}/fork`, { method: 'POST', signal: opts.signal });
		return shapeStrategy(res?.data);
	}

	/** Toggle a strategy's marketplace visibility. */
	async function publishStrategy(strategyId, published, opts = {}) {
		requireUuid(strategyId, 'strategyId');
		const body = published === undefined ? {} : { published: !!published };
		const res = await request(`/api/strategies/${strategyId}/publish`, { method: 'POST', body, signal: opts.signal });
		return shapeStrategy(res?.data);
	}

	/** Edit name/description/config (bumps version when the config changes). */
	async function updateStrategy(strategyId, patch = {}, opts = {}) {
		requireUuid(strategyId, 'strategyId');
		const body = prune({ name: patch.name, description: patch.description, config: patch.config });
		const res = await request(`/api/strategies/${strategyId}`, { method: 'PATCH', body, signal: opts.signal });
		return shapeStrategy(res?.data);
	}

	/** Soft-delete a strategy (deactivates its equips). */
	async function deleteStrategy(strategyId, opts = {}) {
		requireUuid(strategyId, 'strategyId');
		const res = await request(`/api/strategies/${strategyId}`, { method: 'DELETE', signal: opts.signal });
		return { deleted: Boolean(res?.data?.deleted), raw: res };
	}

	return {
		// DCA
		dca, listDca, cancelDca,
		// Copy
		copy, listSubscriptions, copyExecutions, actCopy, dismissCopy, pauseCopy, stopCopy,
		// Mirror
		mirror, unmirror, killSwitch, sweep, equipped,
		// Strategy Objects
		createStrategy, listStrategies, getStrategy, leaderboard, forkStrategy, publishStrategy, updateStrategy, deleteStrategy,
	};
}

// A module-level default client for the zero-config path: `import { dca }`.
let shared = null;
function defaultClient() {
	return (shared ||= createStrategies());
}

/** Create a DCA strategy. */
export function dca(input, opts) { return defaultClient().dca(input, opts); }
/** List an agent's DCA strategies. */
export function listDca(agentId, opts) { return defaultClient().listDca(agentId, opts); }
/** Cancel a DCA strategy. */
export function cancelDca(strategyId, opts) { return defaultClient().cancelDca(strategyId, opts); }
/** Subscribe to a public leader (non-custodial copy). */
export function copy(leaderAgentId, input, opts) { return defaultClient().copy(leaderAgentId, input, opts); }
/** List your copy subscriptions. */
export function listSubscriptions(opts) { return defaultClient().listSubscriptions(opts); }
/** Read your copy-intent inbox. */
export function copyExecutions(query, opts) { return defaultClient().copyExecutions(query, opts); }
/** Record that you acted on a pending intent. */
export function actCopy(executionId, txSignature, opts) { return defaultClient().actCopy(executionId, txSignature, opts); }
/** Dismiss a pending intent. */
export function dismissCopy(executionId, opts) { return defaultClient().dismissCopy(executionId, opts); }
/** Pause a subscription. */
export function pauseCopy(subscriptionId, opts) { return defaultClient().pauseCopy(subscriptionId, opts); }
/** Stop a subscription. */
export function stopCopy(subscriptionId, opts) { return defaultClient().stopCopy(subscriptionId, opts); }
/** Custodial mirror a leader through your agent's wallet. */
export function mirror(agentId, leaderAgentId, input, opts) { return defaultClient().mirror(agentId, leaderAgentId, input, opts); }
/** Remove a mirror follow edge. */
export function unmirror(agentId, leaderAgentId, opts) { return defaultClient().unmirror(agentId, leaderAgentId, opts); }
/** Toggle the agent-wide mirror kill switch. */
export function killSwitch(agentId, engaged, opts) { return defaultClient().killSwitch(agentId, engaged, opts); }
/** Process the leader's pending trades now. */
export function sweep(agentId, opts) { return defaultClient().sweep(agentId, opts); }
/** Live mirror state for an agent. */
export function equipped(agentId, opts) { return defaultClient().equipped(agentId, opts); }
/** Author a Strategy Object. */
export function createStrategy(input, opts) { return defaultClient().createStrategy(input, opts); }
/** Browse strategies. */
export function listStrategies(query, opts) { return defaultClient().listStrategies(query, opts); }
/** Fetch one strategy. */
export function getStrategy(strategyId, opts) { return defaultClient().getStrategy(strategyId, opts); }
/** Proven strategies ranked by real ROI. */
export function leaderboard(query, opts) { return defaultClient().leaderboard(query, opts); }
/** Fork a strategy's rules into your library. */
export function forkStrategy(strategyId, opts) { return defaultClient().forkStrategy(strategyId, opts); }
/** Toggle a strategy's marketplace visibility. */
export function publishStrategy(strategyId, published, opts) { return defaultClient().publishStrategy(strategyId, published, opts); }
/** Edit a strategy. */
export function updateStrategy(strategyId, patch, opts) { return defaultClient().updateStrategy(strategyId, patch, opts); }
/** Soft-delete a strategy. */
export function deleteStrategy(strategyId, opts) { return defaultClient().deleteStrategy(strategyId, opts); }

/** README headline alias: `strategies({ token })` → a configured client. */
export const strategies = createStrategies;

// ── Response shapers: snake_case → camelCase, keep a `.raw` escape hatch ─────

function shapeDca(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id ?? null,
		status: row.status ?? null,
		chainId: row.chain_id ?? null,
		tokenIn: row.token_in ?? null,
		tokenOut: row.token_out ?? null,
		tokenOutSymbol: row.token_out_symbol ?? null,
		amountPerExecution: row.amount_per_execution ?? null,
		periodSeconds: row.period_seconds ?? null,
		slippageBps: row.slippage_bps ?? null,
		nextExecutionAt: row.next_execution_at ?? null,
		lastExecutionAt: row.last_execution_at ?? null,
		lastExecution: row.last_execution ?? null,
		createdAt: row.created_at ?? null,
		raw: row,
	};
}

function shapeSubscription(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id ?? null,
		status: row.status ?? null,
		leaderAgentId: row.leader_agent_id ?? null,
		leaderName: row.leader_name ?? null,
		leaderWallet: row.leader_wallet ?? null,
		copierWallet: row.copier_wallet ?? null,
		network: row.network ?? null,
		sizingRule: row.sizing_rule ?? null,
		fixedSol: numOrNull(row.fixed_sol),
		multiplier: numOrNull(row.multiplier),
		pctBalance: numOrNull(row.pct_balance),
		perTradeCapSol: numOrNull(row.per_trade_cap_sol),
		minOrderSol: numOrNull(row.min_order_sol),
		dailyBudgetSol: numOrNull(row.daily_budget_sol),
		maxOpenCopies: numOrNull(row.max_open_copies),
		mcapFloorUsd: numOrNull(row.mcap_floor_usd),
		mcapCeilingUsd: numOrNull(row.mcap_ceiling_usd),
		copySells: row.copy_sells ?? null,
		requireSafetyPass: row.require_safety_pass ?? null,
		minOracleScore: numOrNull(row.min_oracle_score),
		perfFeeBps: numOrNull(row.perf_fee_bps),
		pendingCount: numOrNull(row.pending_count),
		actedCount: numOrNull(row.acted_count),
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
		raw: row,
	};
}

function shapeExecution(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id ?? null,
		subscriptionId: row.subscription_id ?? null,
		leaderAgentId: row.leader_agent_id ?? null,
		leaderName: row.leader_name ?? null,
		status: row.status ?? null,
		direction: row.direction ?? null,
		mint: row.mint ?? null,
		orderSol: numOrNull(row.order_sol),
		reason: row.reason ?? null,
		txSignature: row.tx_signature ?? null,
		expiresAt: row.expires_at ?? null,
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
		raw: row,
	};
}

function shapeFollow(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id ?? null,
		leaderAgentId: row.leader_agent_id ?? null,
		leaderName: row.leader_name ?? null,
		network: row.network ?? null,
		enabled: row.enabled ?? null,
		sizingMode: row.sizing_mode ?? null,
		fixedSol: numOrNull(row.fixed_sol),
		proportionPct: numOrNull(row.proportion_pct),
		pctBalance: numOrNull(row.pct_balance),
		maxPerTradeSol: numOrNull(row.max_per_trade_sol),
		dailyBudgetSol: numOrNull(row.daily_budget_sol),
		minLeaderSol: numOrNull(row.min_leader_sol),
		copySells: row.copy_sells ?? null,
		mintAllowlist: row.mint_allowlist || [],
		mintDenylist: row.mint_denylist || [],
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
		raw: row,
	};
}

function shapeFill(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id ?? null,
		leaderAgentId: row.leader_agent_id ?? null,
		leaderName: row.leader_name ?? null,
		side: row.side ?? null,
		mint: row.mint ?? null,
		leaderSol: numOrNull(row.leader_sol),
		plannedSol: numOrNull(row.planned_sol),
		status: row.status ?? null,
		skipReason: row.skip_reason ?? null,
		skipLabel: row.skip_label ?? null,
		signature: row.signature ?? null,
		usd: numOrNull(row.usd),
		priceImpactPct: numOrNull(row.price_impact_pct),
		at: row.at ?? null,
		raw: row,
	};
}

function shapeStrategy(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id ?? null,
		name: row.name ?? null,
		slug: row.slug ?? null,
		description: row.description ?? null,
		config: row.config ?? null,
		version: row.version ?? null,
		published: row.published ?? null,
		publishedAt: row.published_at ?? null,
		ownerId: row.owner_id ?? null,
		ownerName: row.owner_name ?? null,
		forkOf: row.fork_of ?? null,
		forkedFrom: row.forked_from ?? null,
		forksCount: numOrNull(row.forks_count),
		equipsCount: numOrNull(row.equips_count),
		isOwner: row.is_owner ?? undefined,
		equipped: row.equipped ?? undefined,
		performance: shapePerformance(row.performance),
		rank: row.rank ?? undefined,
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
		raw: row,
	};
}

function shapePerformance(p) {
	if (!p || typeof p !== 'object') return p ?? null;
	return {
		proven: Boolean(p.proven),
		trades: Number(p.trades || 0),
		open: Number(p.open || 0),
		wins: numOrNull(p.wins),
		losses: numOrNull(p.losses),
		pnlSol: numOrNull(p.pnl_sol),
		roiPct: numOrNull(p.roi_pct),
		winRate: numOrNull(p.win_rate),
		worstSol: numOrNull(p.worst_sol),
		lastClosedAt: p.last_closed_at ?? null,
	};
}

// ── Input validation: throw `invalid_input` BEFORE any network call ──────────

function intervalSeconds(interval) {
	if (interval in DCA_INTERVALS) return DCA_INTERVALS[interval];
	throw new ThreeWsError(`Invalid interval "${interval}". Expected one of: ${Object.keys(DCA_INTERVALS).join(', ')}.`, { code: 'invalid_input' });
}

function enumValue(value, allowed, label) {
	if (allowed.includes(value)) return value;
	throw new ThreeWsError(`Invalid ${label} "${value}". Expected one of: ${allowed.join(', ')}.`, { code: 'invalid_input' });
}

function intInRange(value, lo, hi, label) {
	const v = Number(value);
	if (!Number.isInteger(v) || v < lo || v > hi) {
		throw new ThreeWsError(`${label} must be an integer between ${lo} and ${hi}.`, { code: 'invalid_input' });
	}
	return v;
}

function requireUuid(value, label) {
	if (typeof value !== 'string' || !UUID_RE.test(value)) {
		throw new ThreeWsError(`${label} must be a UUID.`, { code: 'invalid_input' });
	}
}

function requireEthAddress(value, label) {
	if (typeof value !== 'string' || !ETH_ADDRESS_RE.test(value)) {
		throw new ThreeWsError(`${label} must be a 0x-prefixed 40-character hex address.`, { code: 'invalid_input' });
	}
}

function requireWeiString(value, label) {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) {
		throw new ThreeWsError(`${label} must be a decimal integer string (wei).`, { code: 'invalid_input' });
	}
}

function requireNonEmpty(value, label) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new ThreeWsError(`${label} is required.`, { code: 'invalid_input' });
	}
}

function numOrNull(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}
