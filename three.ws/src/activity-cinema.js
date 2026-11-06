// activity-cinema — pure presentation logic for the cinematic activity feed.
//
// The live wall (/agents-live card fallback) and the agent-screen Activity Log
// both narrate an agent's real `agent_actions` rows. This module turns one raw
// entry — `{ ts, activity, type }`, where `type` is the action_type and
// `activity` is the human summary — into the visual grammar both surfaces share:
// an icon, a colour grade, a severity, and a label. It also coalesces a run of
// same-kind actions into a single beat ("Defended floor ×3"), and computes the
// enter/exit timing for the typed reveal.
//
// Everything here is deterministic and DOM-free so it can be unit-tested in
// isolation. Renderers map `colorToken` → a real colour: the canvas path uses
// the exported COLOR_HEX table, the DOM path uses a `data-color` attribute + CSS.
// No network, no globals, no Date.now — callers pass timestamps in.

// ── severity ─────────────────────────────────────────────────────────────────
// Severity is derived from keywords across BOTH the type and the summary so a
// "launch failed" reads as high even though "launch" alone is celebratory. Fail
// always wins over celebration.

const RX_FAIL = /(fail|error|reject|denied|insufficient|disabled|nothing|timeout|unable|cannot|crash|abort|revert|stuck|blocked)/;
const RX_WIN = /(graduat|jackpot|\bwin\b|\bwon\b|launch|deploy|milestone|reward|earn|airdrop|level[\s_-]?up|graduated)/;

/**
 * Classify the emotional severity of an entry.
 * @returns {'high'|'celebratory'|'normal'}
 */
export function severityOf(type, activity) {
	const t = `${type || ''} ${activity || ''}`.toLowerCase();
	if (RX_FAIL.test(t)) return 'high';
	if (RX_WIN.test(t)) return 'celebratory';
	return 'normal';
}

// ── category ─────────────────────────────────────────────────────────────────
// The action_type space is open-ended (buy, sell, defend_buy, recycle_sell,
// graduated, trade_pnl_pct, think, hired, …). We fold it onto a small, stable
// set of categories by keyword. Order matters: the more specific prefixes
// (defend_buy, recycle_sell) must be tested before the generic buy/sell.

/**
 * Fold an action_type onto one of the canonical categories.
 * @returns {string} category key
 */
export function categoryOf(type) {
	const t = (type || '').toLowerCase();
	if (/graduat/.test(t)) return 'graduate';
	if (/launch|deploy|mint\b/.test(t)) return 'launch';
	if (/hir/.test(t)) return 'hire';
	if (/defend|defen[cs]e|protect|floor/.test(t)) return 'defend';
	if (/recycl/.test(t)) return 'recycle';
	if (/memor|think|reflect|note|dream|reason|\bplan\b/.test(t)) return 'memory';
	if (/error|crash|revert/.test(t)) return 'error';
	if (/buyback/.test(t)) return 'trade';
	if (/\bbuy/.test(t)) return 'buy';
	if (/\bsell/.test(t)) return 'sell';
	if (/trade|swap|order|pnl/.test(t)) return 'trade';
	if (/signal|analy|search|scan|research|intel|sentiment/.test(t)) return 'analysis';
	if (/sign/.test(t)) return 'sign';
	return 'default';
}

// Icon glyph + base colour token per category. The base colour is used at
// 'normal' severity; high/celebratory override it (amber/gold) below.
const CATEGORY = {
	graduate: { icon: '🎓', color: 'gold' },
	launch:   { icon: '🚀', color: 'gold' },
	hire:     { icon: '🤝', color: 'violet' },
	defend:   { icon: '🛡', color: 'sky' },
	recycle:  { icon: '♻', color: 'green' },
	memory:   { icon: '🧠', color: 'violet' },
	error:    { icon: '⚠', color: 'amber' },
	buy:      { icon: '▲', color: 'green' },
	sell:     { icon: '▼', color: 'red' },
	trade:    { icon: '⇄', color: 'cyan' },
	analysis: { icon: '🔍', color: 'sky' },
	sign:     { icon: '✎', color: 'neutral' },
	default:  { icon: '›', color: 'neutral' },
};

// Colour token → hex, for the canvas renderer (which can't read CSS variables
// from a pure module). Tuned against the near-black wall field.
export const COLOR_HEX = {
	gold:    '#f5c451',
	amber:   '#f5a524',
	green:   '#5fd08a',
	red:     '#f87171',
	cyan:    '#5fd0c8',
	sky:     '#7aa2ff',
	violet:  '#b78cff',
	neutral: 'rgba(255,255,255,0.62)',
};

/**
 * Humanise an action_type into a short chip label.
 *   'defend_buy' → 'Defend buy'   'trade_pnl_pct' → 'Trade pnl pct'
 */
function labelOf(type, category) {
	const raw = (type || '').replace(/[_-]+/g, ' ').trim();
	if (!raw) return category.charAt(0).toUpperCase() + category.slice(1);
	return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Map one raw entry to its visual grammar.
 * @param {{ts?:number, activity?:string, type?:string}} entry
 * @returns {{ icon:string, colorToken:string, severity:string, label:string, category:string }}
 */
export function classify(entry) {
	const type = entry?.type;
	const activity = entry?.activity;
	const category = categoryOf(type);
	const base = CATEGORY[category] || CATEGORY.default;
	const severity = severityOf(type, activity);
	const colorToken = severity === 'high' ? 'amber'
		: severity === 'celebratory' ? 'gold'
		: base.color;
	return {
		icon: base.icon,
		colorToken,
		severity,
		label: labelOf(type, category),
		category,
	};
}

/**
 * Resolve a colour token (or a classified entry's token) to a hex/rgba string.
 */
export function colorHex(token) {
	return COLOR_HEX[token] || COLOR_HEX.neutral;
}

// ── coalesce ─────────────────────────────────────────────────────────────────

/**
 * Collapse runs of consecutive same-category entries into beats. Input is
 * ordered oldest-first (as the SSE log delivers it); output preserves that
 * order. Each beat carries the LATEST member's content + classification plus a
 * `count` of how many actions it represents and the raw `members`.
 *
 * @param {Array<{ts?:number, activity?:string, type?:string}>} entries
 * @returns {Array<{ key:string, count:number, members:Array, ts?:number,
 *   activity?:string, type?:string, icon:string, colorToken:string,
 *   severity:string, label:string, category:string }>}
 */
export function coalesce(entries) {
	const list = Array.isArray(entries) ? entries : [];
	const beats = [];
	for (const entry of list) {
		const key = categoryOf(entry?.type);
		const last = beats[beats.length - 1];
		if (last && last.key === key) {
			last.members.push(entry);
		} else {
			beats.push({ key, members: [entry] });
		}
	}
	return beats.map((b) => {
		const latest = b.members[b.members.length - 1];
		const c = classify(latest);
		return {
			key: b.key,
			count: b.members.length,
			members: b.members,
			ts: latest?.ts,
			activity: latest?.activity,
			type: latest?.type,
			...c,
		};
	});
}

// ── timeline ─────────────────────────────────────────────────────────────────

/**
 * Compute enter/exit + typed-reveal timing for an entry, deterministically from
 * its text length and severity. High severity types faster (urgency),
 * celebratory lingers (drama). A continuation of the previous category enters
 * quicker so a run of same-kind actions feels like one sweep.
 *
 * @param {{activity?:string, type?:string}} entry
 * @param {{type?:string}} [prev]
 * @returns {{ charMs:number, typeMs:number, enterMs:number, exitMs:number, holdMs:number }}
 */
export function timeline(entry, prev) {
	const text = `${entry?.activity ?? entry?.type ?? ''}`;
	const len = text.length;
	const sev = severityOf(entry?.type, entry?.activity);
	const charMs = sev === 'high' ? 12 : sev === 'celebratory' ? 22 : 16;
	const typeMs = Math.min(len * charMs, 1400);
	const exitMs = 200;
	const holdMs = sev === 'celebratory' ? 2600 : sev === 'high' ? 2200 : 1800;
	const sameAsPrev = !!prev && categoryOf(prev.type) === categoryOf(entry?.type);
	const enterMs = sameAsPrev ? 140 : 220;
	return { charMs, typeMs, enterMs, exitMs, holdMs };
}
