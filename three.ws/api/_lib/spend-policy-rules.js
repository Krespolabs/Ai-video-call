// Natural-language spend policies — the deterministic, code-enforced core.
//
// Owners describe how their agent's custodial wallet may spend in plain English.
// A Claude call (api/_lib/spend-policy-compiler.js) COMPILES that English into the
// structured, versioned rule document defined here. From that point on the LLM is
// out of the loop entirely: every runtime decision is made by `evaluatePolicy()`
// below — a pure, total function with no network, no clock dependence beyond an
// injected context, and no throw path. The model authors and explains; this file
// enforces. That separation is the whole trust model.
//
// The document lives at agent_identities.meta.policy_rules (jsonb, versioned). It
// is ADDITIVE to the numeric caps in agent-trade-guards.js (per_tx_usd, daily_usd,
// withdraw_allowlist, frozen) — those hard floors always apply; policy rules layer
// richer, conditional intent on top. A policy rule can tighten ("block payments to
// services you haven't used before") but the numeric caps and the freeze switch are
// never weakened by it.
//
// Evaluation is an ordered, first-match firewall — the same mental model the owner
// sees in the numbered readback. The first rule whose conditions all match decides;
// if none match, the spend is allowed (and still subject to the numeric caps). This
// is auditable by construction: "rule N caught it" is always answerable.
//
// Everything here is pure + synchronous + total. Malformed input never throws — it
// normalizes away or fails safe. Unit-tested in tests/spend-policy-rules.test.js.

// ── shape + bounds ──────────────────────────────────────────────────────────────
// Small, total, auditable: a policy can't grow into an unbounded eval or a DoS.
export const POLICY_VERSION = 1;
export const MAX_RULES = 40;
export const MAX_CLAUSES_PER_RULE = 8;
const MAX_LABEL = 220;
const MAX_STR_VALUE = 80;
const MAX_IN_LIST = 60;

// The actions a rule can take. `allow` is an explicit carve-out that short-circuits
// later policy rules (a whitelist); `block` denies; `require_step_up` denies an
// autonomous spend that would need a human present (treated as a block on the
// autonomous paths, with an honest "needs your approval" message); `freeze` denies
// AND trips the wallet kill-switch so everything else stops too.
export const ACTIONS = Object.freeze(['allow', 'block', 'require_step_up', 'freeze']);

// Every field the evaluator understands, with its value type. A clause may only
// reference a field listed here; anything else is dropped at normalization. The
// type drives which operators are legal and how the value is coerced.
//
//   amount_usd                USD-equivalent of THIS spend
//   daily_spent_usd           rolling-24h USD already spent BEFORE this one
//   daily_total_usd           daily_spent_usd + amount_usd (for "up to $X/day")
//   token_age_hours           age of the token being bought (trade/snipe only)
//   sol_reserve_after         SOL the wallet would hold AFTER this spend
//   trade_pnl_pct             realized P&L % of the trade (sells; negative = loss)
//   time_of_day_utc           hour 0–23 (UTC) the spend is happening
//   asset                     'SOL' | 'USDC' | mint base58
//   counterparty              destination / payTo address (base58)
//   category                  'trade' | 'snipe' | 'x402' | 'withdraw' | …
//   destination_allowlisted   is the destination on the withdraw allowlist
//   counterparty_seen_before  has this wallet ever paid this counterparty before
export const FIELD_TYPES = Object.freeze({
	amount_usd: 'number',
	daily_spent_usd: 'number',
	daily_total_usd: 'number',
	token_age_hours: 'number',
	sol_reserve_after: 'number',
	trade_pnl_pct: 'number',
	time_of_day_utc: 'number',
	asset: 'string',
	counterparty: 'string',
	category: 'string',
	destination_allowlisted: 'boolean',
	counterparty_seen_before: 'boolean',
});

const NUMERIC_OPS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);
const STRING_OPS = Object.freeze(['eq', 'neq', 'in', 'not_in']);
const BOOLEAN_OPS = Object.freeze(['is']);

function opsForType(type) {
	if (type === 'number') return NUMERIC_OPS;
	if (type === 'string') return STRING_OPS;
	if (type === 'boolean') return BOOLEAN_OPS;
	return [];
}

// Fields that need an async lookup before the evaluator can see them — the enforce
// layer only does the lookup when a live policy actually references the field.
export const ASYNC_CONTEXT_FIELDS = Object.freeze([
	'daily_spent_usd',
	'daily_total_usd',
	'counterparty_seen_before',
]);

// ── normalization (total) ───────────────────────────────────────────────────────

function isFiniteNum(n) {
	return typeof n === 'number' && Number.isFinite(n);
}

function slug(s, fallback) {
	const out = String(s == null ? '' : s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return out || fallback;
}

function clampStr(v, max = MAX_STR_VALUE) {
	return String(v).trim().slice(0, max);
}

// Coerce one raw clause into a clean clause, or null if it can't be made valid.
function normalizeClause(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const field = typeof raw.field === 'string' ? raw.field.trim() : '';
	const type = FIELD_TYPES[field];
	if (!type) return null;
	const op = typeof raw.op === 'string' ? raw.op.trim() : '';
	if (!opsForType(type).includes(op)) return null;

	if (type === 'number') {
		const value = Number(raw.value);
		if (!Number.isFinite(value)) return null;
		return { field, op, value };
	}
	if (type === 'boolean') {
		// Only 'is' — value is the boolean to test against.
		const value = raw.value === true || raw.value === 'true' ? true : raw.value === false || raw.value === 'false' ? false : null;
		if (value === null) return null;
		return { field, op, value };
	}
	// string
	if (op === 'in' || op === 'not_in') {
		const list = Array.isArray(raw.value) ? raw.value : [raw.value];
		const vals = [...new Set(list.map((x) => clampStr(x)).filter(Boolean))].slice(0, MAX_IN_LIST);
		if (!vals.length) return null;
		return { field, op, value: vals };
	}
	const value = clampStr(raw.value);
	if (!value) return null;
	return { field, op, value };
}

// Coerce one raw rule into a clean rule, or null if it can't be enforced.
function normalizeRule(raw, index) {
	if (!raw || typeof raw !== 'object') return null;
	const action = ACTIONS.includes(raw.action) ? raw.action : null;
	if (!action) return null;
	const rawWhen = Array.isArray(raw.when) ? raw.when : [];
	const when = [];
	for (const c of rawWhen) {
		const nc = normalizeClause(c);
		if (nc) when.push(nc);
		if (when.length >= MAX_CLAUSES_PER_RULE) break;
	}
	// A rule with no surviving conditions would match every spend — a catch-all
	// "block everything" that belongs to the freeze switch, not a typo'd rule. Drop
	// it so a malformed/over-broad clause can never silently brick all spending.
	if (!when.length) return null;
	const id = slug(raw.id, `r${index + 1}`);
	const label = typeof raw.label === 'string' && raw.label.trim() ? clampStr(raw.label, MAX_LABEL) : describeRule({ action, when });
	return { id, action, when, label };
}

/**
 * Coerce arbitrary input (the LLM's output, a stored blob, a hand-crafted PUT body)
 * into a clean, bounded policy document. Never throws. Invalid clauses and rules are
 * dropped; the result is always enforceable as-is.
 * @returns {{ version: number, rules: object[], updated_at: string|null, source_text: string|null }}
 */
export function normalizePolicyRules(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const rawRules = Array.isArray(r.rules) ? r.rules : Array.isArray(r) ? r : [];
	const rules = [];
	const seenIds = new Set();
	for (let i = 0; i < rawRules.length; i++) {
		if (rules.length >= MAX_RULES) break;
		const nr = normalizeRule(rawRules[i], rules.length);
		if (!nr) continue;
		// Guarantee unique ids so a block can be attributed unambiguously.
		let id = nr.id;
		let n = 2;
		while (seenIds.has(id)) id = `${nr.id}-${n++}`;
		seenIds.add(id);
		nr.id = id;
		rules.push(nr);
	}
	return {
		version: POLICY_VERSION,
		rules,
		updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
		source_text: typeof r.source_text === 'string' ? r.source_text.slice(0, 4000) : null,
	};
}

/** Read the effective policy document off an agent's meta blob. Always normalized. */
export function getPolicyRules(meta) {
	return normalizePolicyRules(meta?.policy_rules);
}

/** True when the policy actually has at least one enforceable rule. */
export function hasPolicyRules(doc) {
	return !!(doc && Array.isArray(doc.rules) && doc.rules.length);
}

/** The set of context fields any rule in the document references. */
export function referencedFields(doc) {
	const out = new Set();
	for (const rule of doc?.rules || []) {
		for (const c of rule.when || []) out.add(c.field);
	}
	return out;
}

// ── evaluation (pure + total) ────────────────────────────────────────────────────

function clauseMatches(clause, ctx) {
	try {
		const raw = ctx ? ctx[clause.field] : undefined;
		// An unobservable signal (not supplied for this spend) can never match — so a
		// token-age rule is simply inert on an x402 payment, never a false block.
		if (raw === undefined || raw === null) return false;
		const type = FIELD_TYPES[clause.field];

		if (type === 'number') {
			const v = Number(raw);
			const t = Number(clause.value);
			if (!Number.isFinite(v) || !Number.isFinite(t)) return false;
			switch (clause.op) {
				case 'gt': return v > t;
				case 'gte': return v >= t;
				case 'lt': return v < t;
				case 'lte': return v <= t;
				case 'eq': return v === t;
				case 'neq': return v !== t;
				default: return false;
			}
		}
		if (type === 'boolean') {
			const v = raw === true || raw === 'true';
			return clause.op === 'is' ? v === (clause.value === true) : false;
		}
		// string
		const v = String(raw);
		switch (clause.op) {
			case 'eq': return v === clause.value;
			case 'neq': return v !== clause.value;
			case 'in': return Array.isArray(clause.value) && clause.value.includes(v);
			case 'not_in': return Array.isArray(clause.value) && !clause.value.includes(v);
			default: return false;
		}
	} catch {
		return false;
	}
}

function ruleMatches(rule, ctx) {
	// AND across clauses. A rule always has ≥1 clause post-normalization.
	for (const c of rule.when || []) {
		if (!clauseMatches(c, ctx)) return false;
	}
	return true;
}

/**
 * The single runtime decision. Ordered first-match: the first rule whose conditions
 * all match decides the spend. No match → allowed (numeric caps still apply).
 *
 * @param {object} doc  normalized policy document (or anything — it's re-normalized cheaply if raw)
 * @param {object} ctx  the spend context — see FIELD_TYPES for the keys it reads
 * @returns {{ decision: 'allow'|'block'|'step_up'|'freeze', matched: object|null, ruleIndex: number|null, message: string|null }}
 */
export function evaluatePolicy(doc, ctx) {
	const rules = Array.isArray(doc?.rules) ? doc.rules : [];
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		if (!rule || !Array.isArray(rule.when)) continue;
		if (!ruleMatches(rule, ctx)) continue;
		const decision = rule.action === 'allow' ? 'allow' : rule.action === 'require_step_up' ? 'step_up' : rule.action;
		return { decision, matched: rule, ruleIndex: i, message: rule.label || describeRule(rule) };
	}
	return { decision: 'allow', matched: null, ruleIndex: null, message: null };
}

/** True when a decision denies the spend (everything except an allow). */
export function isDenied(decision) {
	return decision === 'block' || decision === 'step_up' || decision === 'freeze';
}

// ── readback (deterministic, golden-tested) ──────────────────────────────────────
// The plain-English the owner confirms is GENERATED from the compiled DSL — never
// the model's free-text — so the readback can never drift from what code enforces.

const FIELD_NOUN = {
	amount_usd: 'the amount',
	daily_spent_usd: 'today’s spend so far',
	daily_total_usd: 'today’s total spend',
	token_age_hours: 'the token’s age',
	sol_reserve_after: 'the SOL left afterward',
	trade_pnl_pct: 'the trade’s profit/loss',
	time_of_day_utc: 'the hour (UTC)',
	asset: 'the asset',
	counterparty: 'the recipient',
	category: 'the spend type',
	destination_allowlisted: 'the destination',
	counterparty_seen_before: 'the recipient',
};

function usd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '$0';
	return `$${v % 1 === 0 ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function describeClause(c) {
	const f = c.field;
	const cmp = { gt: 'over', gte: 'at least', lt: 'under', lte: 'at most', eq: 'exactly', neq: 'not' };
	switch (f) {
		case 'amount_usd': return `the amount is ${cmp[c.op] || c.op} ${usd(c.value)}`;
		case 'daily_spent_usd': return `today’s spend so far is ${cmp[c.op] || c.op} ${usd(c.value)}`;
		case 'daily_total_usd': return `today’s total would be ${cmp[c.op] || c.op} ${usd(c.value)}`;
		case 'token_age_hours': {
			const h = Number(c.value);
			const human = h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`;
			return `the token is ${c.op === 'lt' || c.op === 'lte' ? 'younger than' : c.op === 'gt' || c.op === 'gte' ? 'older than' : cmp[c.op]} ${human}`;
		}
		case 'sol_reserve_after': return `it would leave ${c.op === 'lt' || c.op === 'lte' ? 'less than' : c.op === 'gt' || c.op === 'gte' ? 'more than' : cmp[c.op]} ${Number(c.value)} SOL in the wallet`;
		case 'trade_pnl_pct': {
			const v = Number(c.value);
			if ((c.op === 'lt' || c.op === 'lte') && v < 0) return `the trade is down more than ${Math.abs(v)}%`;
			if ((c.op === 'gt' || c.op === 'gte') && v > 0) return `the trade is up more than ${v}%`;
			return `the trade’s P&L is ${cmp[c.op] || c.op} ${v}%`;
		}
		case 'time_of_day_utc': return `the hour (UTC) is ${cmp[c.op] || c.op} ${Number(c.value)}:00`;
		case 'asset':
			if (c.op === 'in') return `the asset is one of ${c.value.join(', ')}`;
			if (c.op === 'not_in') return `the asset is not ${c.value.join(', ')}`;
			return `the asset is ${c.op === 'neq' ? 'not ' : ''}${c.value}`;
		case 'category': {
			const noun = { trade: 'trade', snipe: 'snipe', x402: 'x402 payment', withdraw: 'withdrawal' };
			// "an x402" — the leading letter is sounded (ex-four-oh-two), so treat an
			// initial vowel OR an x-followed-by-digit as taking "an".
			const article = (w) => (/^[aeiou]/i.test(w) || /^x\d/i.test(w) ? 'an' : 'a');
			const phrase = (v) => `${article(noun[v] || v)} ${noun[v] || v}`;
			if (c.op === 'in') return `it is ${c.value.map(phrase).join(' or ')}`;
			if (c.op === 'not_in') return `it is not ${c.value.map(phrase).join(' or ')}`;
			return `it is ${c.op === 'neq' ? 'not ' : ''}${phrase(c.value)}`;
		}
		case 'counterparty':
			if (c.op === 'in') return `the recipient is a known address`;
			if (c.op === 'not_in') return `the recipient is not an approved address`;
			return `the recipient is ${c.op === 'neq' ? 'not ' : ''}${c.value}`;
		case 'destination_allowlisted':
			return c.value === true ? 'the destination is on your allowlist' : 'the destination is not on your allowlist';
		case 'counterparty_seen_before':
			return c.value === true ? 'you have paid this recipient before' : 'you have never paid this recipient before';
		default: {
			const noun = FIELD_NOUN[f] || f;
			return `${noun} ${cmp[c.op] || c.op} ${c.value}`;
		}
	}
}

const ACTION_VERB = {
	allow: 'Always allow',
	block: 'Block',
	require_step_up: 'Require your approval for',
	freeze: 'Freeze the wallet and block',
};

/** One numbered, human sentence for a single rule, built purely from the DSL. */
export function describeRule(rule) {
	if (!rule || !Array.isArray(rule.when) || !rule.when.length) return '';
	const verb = ACTION_VERB[rule.action] || 'Block';
	const conds = rule.when.map(describeClause);
	const when = conds.length === 1 ? conds[0] : conds.slice(0, -1).join(', ') + ' and ' + conds.slice(-1);
	// "Block a spend when the amount is over $50." reads naturally for every action.
	const object = rule.action === 'freeze' ? 'all spending' : 'the spend';
	return `${verb} ${object} when ${when}.`;
}

/** The numbered plain-English readback of an entire policy. */
export function describePolicyRules(doc) {
	const rules = Array.isArray(doc?.rules) ? doc.rules : [];
	return rules.map((r, i) => ({ n: i + 1, id: r.id, action: r.action, text: r.label || describeRule(r) }));
}

// ── policy diff (for the audit trail + loosening warnings) ────────────────────────

function ruleKey(r) {
	// Order-insensitive signature of a rule's enforced effect.
	const clauses = (r.when || [])
		.map((c) => `${c.field}:${c.op}:${Array.isArray(c.value) ? [...c.value].sort().join('|') : c.value}`)
		.sort()
		.join(';');
	return `${r.action}#${clauses}`;
}

// Actions ranked by how much protection they provide. Replacing a stronger action
// with a weaker one on the same conditions is a loosening the owner must confirm.
const PROTECTION_RANK = { freeze: 4, block: 3, require_step_up: 2, allow: 1 };

/**
 * Diff two policy documents for the audit trail and the "this loosens protection"
 * confirmation. Returns added/removed rules plus an explicit `loosened` flag set
 * when a rule was removed or downgraded (so we never weaken protection silently).
 */
export function diffPolicies(prevDoc, nextDoc) {
	const prev = Array.isArray(prevDoc?.rules) ? prevDoc.rules : [];
	const next = Array.isArray(nextDoc?.rules) ? nextDoc.rules : [];
	const prevKeys = new Map(prev.map((r) => [ruleKey(r), r]));
	const nextKeys = new Map(next.map((r) => [ruleKey(r), r]));

	const added = next.filter((r) => !prevKeys.has(ruleKey(r)));
	const removed = prev.filter((r) => !nextKeys.has(ruleKey(r)));

	// Loosening: a protective rule disappeared, or the overall strongest protection
	// dropped. Removing a `block`/`freeze` is the clearest case.
	const removedProtective = removed.filter((r) => PROTECTION_RANK[r.action] >= 3);
	const loosened = removedProtective.length > 0 || (prev.length > 0 && next.length === 0);

	return {
		added: added.map((r) => ({ id: r.id, action: r.action, text: r.label || describeRule(r) })),
		removed: removed.map((r) => ({ id: r.id, action: r.action, text: r.label || describeRule(r) })),
		loosened,
		loosening_notes: removedProtective.map((r) => `Removes: “${r.label || describeRule(r)}”`),
	};
}

// ── backtest engine ──────────────────────────────────────────────────────────────

function hourOf(ts) {
	const d = ts instanceof Date ? ts : new Date(ts);
	const h = d.getUTCHours();
	return Number.isFinite(h) ? h : null;
}

/**
 * Build the evaluation context for one historical custody 'spend' row. `extra`
 * carries signals that live in the row's meta (token age, P&L) so a backtest is
 * exactly as informed as the live path would have been.
 */
export function contextFromEvent(event, { allowlist = [], dailySpentUsd = null, seenCounterparties = null } = {}) {
	const usdVal = event?.usd != null ? Number(event.usd) : null;
	const m = event?.meta && typeof event.meta === 'object' ? event.meta : {};
	const dest = event?.destination || m.counterparty || null;
	const ctx = {
		amount_usd: usdVal != null && Number.isFinite(usdVal) ? usdVal : undefined,
		category: event?.category || undefined,
		asset: event?.asset || undefined,
		counterparty: dest || undefined,
		time_of_day_utc: event?.created_at ? hourOf(event.created_at) ?? undefined : undefined,
		destination_allowlisted: dest ? allowlist.includes(dest) : undefined,
	};
	if (dailySpentUsd != null && Number.isFinite(dailySpentUsd)) {
		ctx.daily_spent_usd = dailySpentUsd;
		if (ctx.amount_usd != null) ctx.daily_total_usd = dailySpentUsd + ctx.amount_usd;
	}
	if (seenCounterparties && dest) ctx.counterparty_seen_before = seenCounterparties.has(dest);
	// Signals that the meta may carry for trade/snipe rows.
	if (isFiniteNum(Number(m.token_age_hours))) ctx.token_age_hours = Number(m.token_age_hours);
	if (m.trade_pnl_pct != null && Number.isFinite(Number(m.trade_pnl_pct))) ctx.trade_pnl_pct = Number(m.trade_pnl_pct);
	if (m.sol_reserve_after != null && Number.isFinite(Number(m.sol_reserve_after))) ctx.sol_reserve_after = Number(m.sol_reserve_after);
	return ctx;
}

/**
 * Replay an agent's real custody history against a proposed policy and report what
 * it would have done — computed by the SAME `evaluatePolicy` that runs in
 * production, so the preview is honest. Events should be 'spend' rows; they are
 * replayed oldest→newest so the rolling daily total a rule sees is the one the
 * policy itself would have produced.
 *
 * @param {object} doc        normalized policy document
 * @param {object[]} events   custody events (any order; non-spend rows ignored)
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist]   withdraw allowlist for destination_allowlisted
 * @returns {{ total, allowed, blocked, blocked_usd, allowed_usd, items, by_rule }}
 */
export function backtestPolicy(doc, events, { allowlist = [] } = {}) {
	const spends = (Array.isArray(events) ? events : [])
		.filter((e) => e && e.event_type === 'spend')
		.slice()
		.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

	const refs = referencedFields(doc);
	const needsDaily = refs.has('daily_spent_usd') || refs.has('daily_total_usd');
	const needsSeen = refs.has('counterparty_seen_before');

	// Rolling 24h window of ALLOWED priced spends — the faithful daily total the
	// policy would have observed (a blocked spend never adds to the day's tally).
	const window = []; // [{ t: epochMs, usd }]
	const seen = needsSeen ? new Set() : null;

	const items = [];
	const byRule = new Map();
	let allowed = 0;
	let blocked = 0;
	let blockedUsd = 0;
	let allowedUsd = 0;

	for (const e of spends) {
		const tMs = new Date(e.created_at).getTime();
		let dailySpent = null;
		if (needsDaily) {
			const cutoff = tMs - 24 * 3600 * 1000;
			while (window.length && window[0].t <= cutoff) window.shift();
			dailySpent = window.reduce((s, w) => s + w.usd, 0);
		}
		const ctx = contextFromEvent(e, { allowlist, dailySpentUsd: dailySpent, seenCounterparties: seen });
		const verdict = evaluatePolicy(doc, ctx);
		const denied = isDenied(verdict.decision);
		const usdVal = e.usd != null ? Number(e.usd) : 0;

		if (denied) {
			blocked++;
			blockedUsd += Number.isFinite(usdVal) ? usdVal : 0;
			const idx = verdict.ruleIndex;
			const key = idx;
			const agg = byRule.get(key) || { ruleIndex: idx, id: verdict.matched?.id, action: verdict.matched?.action, label: verdict.message, count: 0, usd: 0 };
			agg.count++;
			agg.usd += Number.isFinite(usdVal) ? usdVal : 0;
			byRule.set(key, agg);
		} else {
			allowed++;
			allowedUsd += Number.isFinite(usdVal) ? usdVal : 0;
			// Only allowed priced spends accumulate toward the rolling daily total.
			if (needsDaily && Number.isFinite(usdVal) && usdVal > 0) window.push({ t: tMs, usd: usdVal });
		}
		if (needsSeen && (e.destination || ctx.counterparty)) seen.add(e.destination || ctx.counterparty);

		items.push({
			id: e.id != null ? String(e.id) : null,
			created_at: e.created_at,
			category: e.category || null,
			asset: e.asset || null,
			usd: e.usd != null ? Number(e.usd) : null,
			destination: e.destination || null,
			decision: verdict.decision,
			denied,
			rule_index: verdict.ruleIndex,
			rule_id: verdict.matched?.id || null,
			rule_text: verdict.message || null,
		});
	}

	// Newest-first for display; rolling math above already used chronological order.
	items.reverse();

	return {
		total: spends.length,
		allowed,
		blocked,
		blocked_usd: Number(blockedUsd.toFixed(2)),
		allowed_usd: Number(allowedUsd.toFixed(2)),
		items,
		by_rule: [...byRule.values()].sort((a, b) => b.count - a.count),
	};
}

// ── synthetic probes ─────────────────────────────────────────────────────────────
// A handful of hypothetical spends, derived from the policy's own thresholds, run
// through the same evaluator. Lets the owner see "a $60 payment → blocked" even with
// zero history. Clearly labelled as hypothetical in the UI — never mixed into the
// real backtest counts.

/** Build a small, honest set of "what would happen if…" probes for a policy. */
export function syntheticProbes(doc) {
	const refs = referencedFields(doc);
	const probes = [];
	const add = (label, ctx) => {
		const v = evaluatePolicy(doc, ctx);
		probes.push({ label, decision: v.decision, denied: isDenied(v.decision), rule_index: v.ruleIndex, rule_text: v.message || null });
	};
	const base = { category: 'trade', asset: 'SOL', amount_usd: 10, daily_spent_usd: 0, daily_total_usd: 10 };

	if (refs.has('amount_usd') || refs.has('per_tx')) {
		add('A $5 payment', { ...base, category: 'x402', asset: 'USDC', amount_usd: 5, daily_total_usd: 5 });
		add('A $250 payment', { ...base, category: 'x402', asset: 'USDC', amount_usd: 250, daily_total_usd: 250 });
	}
	if (refs.has('token_age_hours')) {
		add('Buying a 30-minute-old token', { ...base, token_age_hours: 0.5 });
		add('Buying a 3-day-old token', { ...base, token_age_hours: 72 });
	}
	if (refs.has('sol_reserve_after')) {
		add('A trade leaving 0.4 SOL', { ...base, sol_reserve_after: 0.4 });
		add('A trade leaving 5 SOL', { ...base, sol_reserve_after: 5 });
	}
	if (refs.has('trade_pnl_pct')) {
		add('A trade down 40%', { ...base, trade_pnl_pct: -40 });
		add('A trade up 20%', { ...base, trade_pnl_pct: 20 });
	}
	if (refs.has('counterparty_seen_before')) {
		add('Paying a brand-new service', { ...base, category: 'x402', asset: 'USDC', counterparty_seen_before: false });
		add('Paying a service used before', { ...base, category: 'x402', asset: 'USDC', counterparty_seen_before: true });
	}
	if (refs.has('daily_total_usd') || refs.has('daily_spent_usd')) {
		add('A $30 trade after $40 spent today', { ...base, daily_spent_usd: 40, amount_usd: 30, daily_total_usd: 70 });
	}
	// Always include a plain small spend so the owner sees the default-allow baseline.
	if (!probes.length) add('A typical small spend', base);
	return probes.slice(0, 8);
}
