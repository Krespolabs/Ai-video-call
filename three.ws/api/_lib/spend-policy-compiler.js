// Natural-language → validated spend-policy compiler.
//
// The owner writes how their agent wallet may spend in plain English ("let it trade
// up to $50/day on tokens at least a day old, never spend my last 1 SOL, stop
// everything if a single trade drops more than 30%, and only ever pay services I've
// used before"). We compile that to the structured rule DSL in
// spend-policy-rules.js, HARD-validate it (normalizePolicyRules drops anything that
// wouldn't enforce), and hand back a numbered plain-English readback so the owner
// confirms intent before saving.
//
// The model AUTHORS; it never enforces. Its JSON is parsed, normalized, and only
// the normalized result is ever stored or run — anything it emits that doesn't
// validate is discarded, never enforced. Prefers the platform free-first LLM chain
// (llm.js); falls back to a real deterministic intent parser so the feature always
// compiles, model or not.

import { llmComplete, llmConfigured } from './llm.js';
import { normalizePolicyRules, describePolicyRules } from './spend-policy-rules.js';

const COMPILE_SYSTEM = `You convert an agent-wallet owner's plain-English spending rules into ONE JSON object describing a deterministic policy. Output ONLY the JSON — no prose, no markdown fence.

The wallet belongs to an autonomous AI agent that spends on its own (trades tokens, snipes launches, pays other services via x402, and the owner can withdraw). The owner is setting safety rules. Your job is ONLY to translate intent into structured rules — you never make spending decisions.

Output shape:
{
  "rules": [
    { "action": "block" | "allow" | "require_step_up" | "freeze",
      "when": [ { "field": "...", "op": "...", "value": ... }, ... ] }   // ALL clauses must be true (AND) for the rule to fire
  ],
  "refusal": string|null,        // set ONLY if the request is too ambiguous or unsafe to compile; explain what you need
  "assumptions": [string]        // anything you defaulted, inferred, or could not capture
}

Rules are evaluated top-to-bottom, first match wins (like a firewall). Put "allow" carve-outs BEFORE the "block" they should override.

Fields (use the exact name; pick the operator that fits):
- amount_usd            number   USD value of a single spend           ops: gt,gte,lt,lte,eq,neq
- daily_total_usd       number   today's running total INCLUDING this spend (use for "up to $X per day")
- daily_spent_usd       number   today's total BEFORE this spend
- token_age_hours       number   age of the token being bought (trade/snipe). "at least a day old" => gte 24
- sol_reserve_after     number   SOL left in the wallet AFTER the spend. "never spend my last 1 SOL" => lt 1
- trade_pnl_pct         number   a trade's profit/loss %. A 30% drop => lt -30 (loss is negative)
- time_of_day_utc       number   hour 0-23 UTC
- asset                 string   "SOL" | "USDC" | a mint        ops: eq,neq,in,not_in
- category              string   "trade" | "snipe" | "x402" | "withdraw"   ops: eq,neq,in,not_in
- counterparty          string   a destination address          ops: eq,neq,in,not_in
- destination_allowlisted  boolean   on the withdraw allowlist   op: is
- counterparty_seen_before boolean   the wallet has paid this recipient before   op: is

Encoding intents (think in terms of what to BLOCK):
- "up to $50/day" => block when daily_total_usd gt 50.
- "no payment over $X" => block when amount_usd gt X.
- "only trade tokens at least a day old" => block trades on young tokens: action block, when [{category eq trade},{token_age_hours lt 24}]. (Also covers "snipe" with category in ["trade","snipe"].)
- "never spend my last 1 SOL" => block when sol_reserve_after lt 1.
- "stop everything if a trade drops more than 30%" => action freeze, when [{trade_pnl_pct lt -30}].
- "only ever pay services I've used before" => block when [{category eq x402},{counterparty_seen_before is false}].
- "pause all payments at night" / time windows => block with time_of_day_utc.
- "always allow withdrawals to my own wallet ADDRESS" => action allow, when [{category eq withdraw},{counterparty eq "ADDRESS"}].

Rules:
- Prefer the smallest set of rules that captures the intent. Never invent limits the owner didn't ask for.
- A rule MUST have at least one clause. Never emit an empty "when".
- If you genuinely cannot map the request to these fields, set "refusal" and leave "rules" empty.
- Never reference any coin or token other than $THREE.`;

function str(v, max = 300) {
	if (typeof v !== 'string') return '';
	return v.trim().slice(0, max);
}

function safeJsonExtract(text) {
	if (typeof text !== 'string') return null;
	const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
	const start = t.indexOf('{');
	const end = t.lastIndexOf('}');
	if (start < 0 || end < start) return null;
	try {
		return JSON.parse(t.slice(start, end + 1));
	} catch {
		return null;
	}
}

/**
 * Compile NL → validated policy document.
 * @param {string} text                 the owner's plain-English description
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist]   known destinations (lets "addresses I've used" map to a counterparty allowlist)
 * @param {object} [opts.track]         llm spend attribution
 * @returns {Promise<{ ok: boolean, error?: string, message?: string, refusal?: string|null,
 *   via?: string, source_text?: string, policy?: object, readback?: object[],
 *   assumptions?: string[] }>}
 */
export async function compilePolicyFromText(text, { allowlist = [], track = null } = {}) {
	const source = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
	if (source.length < 3) {
		return { ok: false, error: 'empty', message: 'Describe how your agent should spend, in a sentence or two.' };
	}

	let parsed = null;
	let via = 'heuristic';
	let refusal = null;
	if (llmConfigured()) {
		try {
			const out = await llmComplete({
				system: COMPILE_SYSTEM,
				user: source,
				maxTokens: 900,
				timeoutMs: 25_000,
				track: track ? { ...track, tool: 'spend-policy-compile' } : { tool: 'spend-policy-compile' },
			});
			parsed = safeJsonExtract(out.text);
			if (parsed) {
				via = 'model';
				if (typeof parsed.refusal === 'string' && parsed.refusal.trim()) refusal = str(parsed.refusal, 400);
			}
		} catch (e) {
			console.warn('[spend-policy-compiler] LLM compile failed, using heuristic:', e?.message);
		}
	}
	if (!parsed) parsed = heuristicCompile(source, allowlist);

	const assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions.map((w) => str(w)).filter(Boolean) : [];

	// HARD validation: only the normalized document is ever returned/stored/run.
	const policy = normalizePolicyRules({ rules: parsed.rules, source_text: source });

	// Nothing enforceable came out. Honour an explicit model refusal, else explain.
	if (!policy.rules.length) {
		const heur = via === 'model' ? heuristicCompile(source, allowlist) : null;
		const fallback = heur ? normalizePolicyRules({ rules: heur.rules, source_text: source }) : null;
		if (fallback && fallback.rules.length) {
			return finalize(fallback, 'heuristic', source, Array.isArray(heur.assumptions) ? heur.assumptions.map((w) => str(w)).filter(Boolean) : [], null);
		}
		return {
			ok: false,
			error: 'unparseable',
			via,
			source_text: source,
			refusal: refusal || null,
			message:
				refusal ||
				'I couldn’t turn that into a concrete spending rule. Try something like “block any payment over $50”, “only trade tokens at least a day old”, or “never let SOL drop below 1”.',
		};
	}

	return finalize(policy, via, source, assumptions, refusal);
}

function finalize(policy, via, source, assumptions, refusal) {
	return {
		ok: true,
		via,
		source_text: source,
		policy,
		readback: describePolicyRules(policy),
		assumptions: [...new Set(assumptions)],
		refusal: refusal || null,
	};
}

// ── deterministic intent parser — real implementation, not a mock ──────────────────
// Covers the phrasings the README's worked example uses plus the common variants, so
// the feature compiles even with no model configured. Each matched intent becomes a
// real rule; the same normalizer validates the output.
function heuristicCompile(text, allowlist = []) {
	const WORDS = { a: '1', one: '1', two: '2', three: '3', four: '4', five: '5', ten: '10' };
	let lowered = text.toLowerCase();
	const t = ` ${lowered} `;
	const rules = [];
	const assumptions = [];

	const money = (m) => {
		if (!m) return null;
		let v = parseFloat(String(m).replace(/[$,\s]/g, ''));
		if (/k\b/i.test(m)) v *= 1_000;
		if (/m(?:m|illion)?\b/i.test(m)) v *= 1_000_000;
		return Number.isFinite(v) ? v : null;
	};
	const numWord = (w) => (WORDS[w] != null ? Number(WORDS[w]) : Number(w));

	// "up to $50/day", "$50 per day", "max $50 a day"
	const daily = t.match(/(?:up to|max(?:imum)?|under|below|no more than)\s*\$?\s*([\d.,]+\s*[km]?)\s*(?:\/|per|a)\s*day/) ||
		t.match(/\$?\s*([\d.,]+\s*[km]?)\s*(?:\/|per|a)\s*day/);
	if (daily) {
		const v = money(daily[1]);
		if (v != null) rules.push({ action: 'block', when: [{ field: 'daily_total_usd', op: 'gt', value: v }] });
	}

	// "never spend over $X", "no payment over $X", "block payments above $X" (single tx)
	const perTx = t.match(/(?:over|above|more than|exceed(?:ing|s)?|bigger than)\s*\$?\s*([\d.,]+\s*[km]?)/);
	if (perTx && !/\bday\b/.test(perTx[0])) {
		const v = money(perTx[1]);
		if (v != null) rules.push({ action: 'block', when: [{ field: 'amount_usd', op: 'gt', value: v }] });
	}

	// "tokens at least a day old" / "older than N hours/days"
	const ageDay = t.match(/(?:at least|older than|more than)\s*(a|one|two|three|\d+)\s*day/);
	const ageHr = t.match(/(?:at least|older than|more than)\s*(\d+)\s*hour/);
	if (ageDay || ageHr) {
		const hours = ageHr ? Number(ageHr[1]) : numWord(ageDay[1]) * 24;
		if (Number.isFinite(hours) && hours > 0) {
			const cat = /snipe/.test(t) ? { field: 'category', op: 'in', value: ['trade', 'snipe'] } : { field: 'category', op: 'eq', value: 'trade' };
			rules.push({ action: 'block', when: [cat, { field: 'token_age_hours', op: 'lt', value: hours }] });
		}
	}

	// "never spend my last 1 SOL" / "keep at least 1 SOL" / "don't let SOL drop below 1"
	const reserve = t.match(/(?:last|keep|reserve|leave|below|under|drop below)\s*(?:at least\s*)?(\d+(?:\.\d+)?)\s*sol/) ||
		t.match(/(\d+(?:\.\d+)?)\s*sol\s*(?:reserve|floor|minimum|min)/);
	if (reserve) {
		const v = parseFloat(reserve[1]);
		if (Number.isFinite(v) && v > 0) rules.push({ action: 'block', when: [{ field: 'sol_reserve_after', op: 'lt', value: v }] });
	}

	// "stop everything if a trade drops more than 30%" => freeze
	const drop = t.match(/(?:drops?|down|loses?|lose|loss|falls?)\D{0,18}?(\d+(?:\.\d+)?)\s*%/);
	if (drop && /(stop everything|freeze|halt|kill|stop trading|shut)/.test(t)) {
		const v = parseFloat(drop[1]);
		if (Number.isFinite(v) && v > 0) rules.push({ action: 'freeze', when: [{ field: 'trade_pnl_pct', op: 'lt', value: -Math.abs(v) }] });
	} else if (drop && /(stop loss|stop-loss|sell if|exit if)/.test(t)) {
		const v = parseFloat(drop[1]);
		if (Number.isFinite(v) && v > 0) rules.push({ action: 'freeze', when: [{ field: 'trade_pnl_pct', op: 'lt', value: -Math.abs(v) }] });
	}

	// "only ever pay services I've used before" / "only pay known services"
	if (/(only|just).{0,30}(pay|services?).{0,30}(used before|i'?ve used|known|familiar|trusted)/.test(t) ||
		/(services?|people|addresses?).{0,20}(i'?ve|i have)\s*(used|paid)\s*before/.test(t) ||
		/no new (services?|payees?|recipients?)/.test(t)) {
		rules.push({ action: 'block', when: [{ field: 'category', op: 'eq', value: 'x402' }, { field: 'counterparty_seen_before', op: 'is', value: false }] });
		assumptions.push('Read "only pay services you’ve used before" as: block first-time x402 payees. The agent can still pay any recipient it has paid before.');
	}

	// "only withdraw to my allowlist" — leans on the existing withdraw allowlist signal.
	if (/(only|just).{0,30}withdraw.{0,30}(allowlist|approved|my own|trusted)/.test(t) || /withdraw.{0,20}only.{0,20}(allowlist|approved)/.test(t)) {
		rules.push({ action: 'block', when: [{ field: 'category', op: 'eq', value: 'withdraw' }, { field: 'destination_allowlisted', op: 'is', value: false }] });
	}

	return { rules, assumptions };
}
