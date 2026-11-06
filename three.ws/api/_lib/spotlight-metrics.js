// Verified results for Agent Spotlight entries and /stories.
//
// A spotlight write-up is a claim in the builder's own words. The figures in
// this module are the opposite: computed server-side from tables the builder
// cannot type into, keyed by agent_id, each with the source a reader can check.
//
//   coins           pump_agent_mints (mainnet): every coin the agent launched,
//                   with its mint, a Solscan link and its three.ws launch page.
//   service_income  agent_revenue_events (x402 skill sales, USDC net of the
//                   platform fee) plus agent_hires (completed hires by other
//                   agents). USDC is valued 1:1 in USD. Same definition as the
//                   agent earnings read model, so the two never disagree.
//   creator_fees    pump.fun creator fees from the agent earnings read model
//                   (api/_lib/agent-earnings.js, served at
//                   GET /api/agents/:id/earnings). Loaded lazily: when that
//                   module or its snapshot is not available on a deployment,
//                   the metric reports `available: false` and says so, rather
//                   than showing a zero nobody measured.
//   activity        conversations and logged actions, already carried on the
//                   entry itself (agent.chat_count / agent.action_count).
//
// `qualifies` is true when the agent has a RESULT to show: at least one coin
// launched, creator fees above zero, or service income above zero. Activity
// counts alone never make a story.

import { sql } from './db.js';
import { SOLANA_USDC_MINT } from '../payments/_config.js';

const USDC_DECIMALS = 6;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function emptyMetrics(agentId) {
	return {
		coins: { count: 0, items: [], source: 'pump_agent_mints', source_url: `/launches` },
		service_income: {
			usd: 0,
			skill_sales_usd: 0,
			skill_sales_count: 0,
			hires_usd: 0,
			hires_count: 0,
			source: 'agent_revenue_events + agent_hires',
			source_url: `/api/agents/${agentId}/earnings`,
		},
		creator_fees: {
			available: false,
			sol: null,
			usd: null,
			reason: 'not_loaded',
			source_url: `/api/agents/${agentId}/earnings`,
		},
	};
}

function coinItem(row) {
	return {
		mint: row.mint,
		name: row.name || null,
		symbol: row.symbol || null,
		launched_at: row.created_at,
		launch_url: `/launches/${row.mint}`,
		solscan_url: `https://solscan.io/token/${row.mint}`,
	};
}

/**
 * Coins and service income for many agents in three queries.
 * @param {string[]} agentIds
 * @returns {Promise<Map<string, ReturnType<typeof emptyMetrics>>>}
 */
export async function baseMetrics(agentIds) {
	const ids = [...new Set((agentIds || []).filter(Boolean))];
	const out = new Map(ids.map((id) => [id, emptyMetrics(id)]));
	if (!ids.length) return out;

	const [coins, sales, hires] = await Promise.all([
		sql`
			select agent_id, mint, name, symbol, created_at
			from pump_agent_mints
			where agent_id = any(${ids}::uuid[]) and network = 'mainnet'
			order by created_at desc
		`,
		sql`
			select agent_id, coalesce(sum(net_amount), 0)::text as atomics, count(*)::int as n
			from agent_revenue_events
			where agent_id = any(${ids}::uuid[]) and currency_mint = ${SOLANA_USDC_MINT}
			group by agent_id
		`,
		sql`
			select provider_agent_id as agent_id, coalesce(sum(usd), 0)::float8 as usd, count(*)::int as n
			from agent_hires
			where provider_agent_id = any(${ids}::uuid[]) and status = 'completed'
			group by provider_agent_id
		`,
	]);

	for (const row of coins) {
		const m = out.get(row.agent_id);
		if (!m) continue;
		m.coins.items.push(coinItem(row));
		m.coins.count += 1;
	}
	for (const row of sales) {
		const m = out.get(row.agent_id);
		if (!m) continue;
		m.service_income.skill_sales_usd = round2(Number(BigInt(row.atomics)) / 10 ** USDC_DECIMALS);
		m.service_income.skill_sales_count = row.n;
	}
	for (const row of hires) {
		const m = out.get(row.agent_id);
		if (!m) continue;
		m.service_income.hires_usd = round2(row.usd);
		m.service_income.hires_count = row.n;
	}
	for (const m of out.values()) {
		m.service_income.usd = round2(m.service_income.skill_sales_usd + m.service_income.hires_usd);
	}
	return out;
}

// The earnings read model is loaded on first use. A deployment that does not
// carry it (or whose snapshot table is missing) degrades creator fees to
// "not available" instead of failing the whole entry.
let earningsModule;
async function loadEarnings() {
	if (earningsModule === undefined) {
		earningsModule = await import('./agent-earnings.js').catch((err) => {
			console.warn('[spotlight-metrics] agent earnings read model unavailable:', err?.message || err);
			return null;
		});
	}
	return earningsModule?.getAgentEarnings ? earningsModule : null;
}

/**
 * Attach creator fees for the given agents (in place).
 * @param {Map<string, ReturnType<typeof emptyMetrics>>} metrics
 */
export async function attachCreatorFees(metrics) {
	const mod = await loadEarnings();
	if (!mod) {
		for (const m of metrics.values()) m.creator_fees.reason = 'earnings_unavailable';
		return metrics;
	}
	const ids = [...metrics.keys()];
	if (!ids.length) return metrics;
	const agents = await sql`
		select id, name, is_public, meta->>'solana_address' as solana_address
		from agent_identities
		where id = any(${ids}::uuid[]) and deleted_at is null
	`;
	await Promise.all(
		agents.map(async (agent) => {
			const m = metrics.get(agent.id);
			if (!m) return;
			try {
				const e = await mod.getAgentEarnings(agent, { window: 'all' });
				const sol = Number(e?.lifetime_creator_fees?.earned_sol);
				m.creator_fees = {
					available: Number.isFinite(sol),
					sol: Number.isFinite(sol) ? sol : null,
					usd: e?.lifetime_creator_fees?.earned_usd ?? null,
					refreshed_at: e?.refreshed_at ?? null,
					reason: Number.isFinite(sol) ? null : 'no_figure',
					source_url: `/api/agents/${agent.id}/earnings`,
				};
			} catch (err) {
				console.warn(`[spotlight-metrics] creator fees for ${agent.id} failed:`, err?.message || err);
				m.creator_fees.reason = 'earnings_unavailable';
			}
		}),
	);
	return metrics;
}

/** True when the agent has a result a story can stand on. */
export function qualifies(m) {
	if (!m) return false;
	return (
		m.coins.count > 0 ||
		m.service_income.usd > 0 ||
		(m.creator_fees.available && Number(m.creator_fees.sol) > 0)
	);
}

/**
 * Shape metrics for the API: the three result metrics plus which of them are
 * live on this deployment, so a client can say "creator fees are not measured
 * here yet" instead of printing a zero.
 */
export function shapeVerified(m) {
	return {
		coins: m.coins,
		service_income: m.service_income,
		creator_fees: m.creator_fees,
		live: ['coins', 'service_income', ...(m.creator_fees.available ? ['creator_fees'] : [])],
		qualifies: qualifies(m),
	};
}

/**
 * Full verified metrics (coins, service income, creator fees) for many agents.
 * @param {string[]} agentIds
 */
export async function verifiedMetrics(agentIds) {
	const metrics = await baseMetrics(agentIds);
	await attachCreatorFees(metrics);
	return metrics;
}
