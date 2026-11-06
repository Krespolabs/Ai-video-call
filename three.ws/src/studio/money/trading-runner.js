/**
 * Trading Brain — P1 brain `market` node runner (P4)
 * ==================================================
 * P1's brain graph can contain a `market` node. The brain *reasons*; THIS runner
 * gives it real, live trading context to reason with — closing the loop the P1
 * spec opened (brain-nodes.js#registerNodeRunner). When the brain runs (the owner
 * chats with their agent), any wired market node calls this runner; we return a
 * `context` string injected into the system prompt so the model answers grounded
 * in the agent's *actual* trading state, not a hallucination:
 *
 *   • the live rule (assisted vs autonomous, armed or not, kill switch),
 *   • real open positions and their P&L,
 *   • for a propose/ask-brain trigger, the live launches matching the rule RIGHT
 *     NOW (real scan — same endpoint the assisted UI uses).
 *
 * It never executes a trade — execution stays behind the explicit assisted-confirm
 * / autonomous-arm guards. This runner only informs the brain. When live matches
 * appear it emits a market event so the avatar (P5) perks up.
 *
 * Loaded for its side effect (registration) by money-mount.js.
 */

import { studio } from '../agent-studio-store.js';
import { registerNodeRunner } from '../brain/brain-nodes.js';
import { apiFetch } from '../../api.js';
import { compileRuleToConfig, normalizeRule, ruleToEnglish } from './trading-compile.js';

// Live market reads are not free — cache the scan briefly so a chatty brain
// doesn't hammer the RPC/feed on every message.
let _scanCache = { at: 0, key: '', candidates: null };
const SCAN_TTL_MS = 60_000;

async function loadTradingState(agentId) {
	const out = { armed: false, killed: false, open: [], rule: null, mode: 'assisted' };
	const bag = studio.agent?.meta?.studio?.trading || {};
	out.rule = bag.rule ? normalizeRule(bag.rule) : null;
	out.mode = bag.mode === 'autonomous' ? 'autonomous' : 'assisted';
	try {
		const res = await apiFetch(`/api/agents/${agentId}/strategies`);
		if (res.ok) {
			const { data } = await res.json();
			out.killed = !!data.killed;
			out.armed = (data.equips || []).some((e) => e.strategy_id === bag.strategyId && e.active);
			out.open = (data.positions || []).filter((p) => p.status === 'open' || p.status === 'closing');
		}
	} catch { /* best-effort context */ }
	return out;
}

async function scanMatches(agentId, rule, signal) {
	const key = JSON.stringify(compileRuleToConfig(rule));
	if (_scanCache.candidates && _scanCache.key === key && Date.now() - _scanCache.at < SCAN_TTL_MS) {
		return _scanCache.candidates;
	}
	try {
		const res = await apiFetch('/api/trading/scan', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId, config: compileRuleToConfig(rule) }),
			signal,
		});
		if (!res.ok) return null;
		const { data } = await res.json();
		_scanCache = { at: Date.now(), key, candidates: data.candidates || [] };
		return _scanCache.candidates;
	} catch {
		return null;
	}
}

registerNodeRunner('market', async (node, ctx) => {
	const agentId = studio.agent?.id;
	if (!agentId) return { context: '' };

	const action = node?.data?.action || 'propose-action';
	const st = await loadTradingState(agentId);

	const lines = ['[Live trading context — real, from this agent\'s wallet and strategy engine]'];
	if (st.rule) {
		lines.push(`Active rule: "${st.rule.name}" — ${ruleToEnglish(st.rule)}`);
		lines.push(`Mode: ${st.mode}. ${st.armed ? 'Autonomous strategy is ARMED.' : 'Not armed for autonomous trading.'}${st.killed ? ' KILL SWITCH IS ON — all autonomous trading is halted.' : ''}`);
	} else {
		lines.push('No trading rule has been authored yet in the Money studio.');
	}

	if (st.open.length) {
		const desc = st.open.slice(0, 5).map((p) => {
			const v = p.value_sol != null ? `${p.value_sol} SOL value` : 'live';
			return `${p.symbol || p.name || p.mint.slice(0, 6)} (${p.entry_sol} SOL in, ${v})`;
		}).join('; ');
		lines.push(`Open positions (${st.open.length}): ${desc}.`);
	} else {
		lines.push('No open positions right now.');
	}

	// Only spend a live scan when the brain is actually meant to act on the signal.
	if (st.rule && !st.killed && (action === 'propose-action' || action === 'ask-brain')) {
		const matches = await scanMatches(agentId, st.rule, ctx?.signal);
		if (matches && matches.length) {
			const top = matches.slice(0, 4).map((c) => {
				const fw = c.firewall?.verdict || 'n/a';
				const mc = c.market_cap_usd != null ? `$${Math.round(c.market_cap_usd).toLocaleString()} mc` : '';
				return `${c.symbol || c.name || c.mint.slice(0, 6)} (${mc}, ${c.age_minutes ?? '?'}m old, firewall: ${fw})`;
			}).join('; ');
			lines.push(`RIGHT NOW ${matches.length} live launch${matches.length === 1 ? '' : 'es'} match the rule: ${top}.`);
			lines.push(action === 'ask-brain'
				? 'Think it through out loud, then tell the user whether to snipe any of these and at what size — but do NOT claim to have traded; the user confirms each snipe in the Money studio.'
				: 'Propose a concrete action (which coin, what size, why) within the guardrails. The user confirms the snipe; you never execute it yourself.');
			studio.emitMarket?.({ type: 'alert', mint: matches[0].mint });
		} else if (matches) {
			lines.push('No live launches currently match the rule.');
		}
	}

	return { context: lines.join('\n') };
});
