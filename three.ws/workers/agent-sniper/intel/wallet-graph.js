// Smart-Money Wallet Graph — pure scoring + clustering math (no I/O).
//
// The recompute job (recompute-wallet-graph.js) joins pump_coin_wallets ⋈
// pump_coin_outcomes and feeds the rows through here. Everything below is
// deterministic over plain arrays so it pins to fixtures and the live API and the
// worker can never disagree on what a wallet's reputation is.
//
// Honesty (Rule 1): a wallet's realized_score is derived ONLY from real observed
// buys and real outcomes. New wallets are regressed toward neutral until they have
// enough judged launches — we never fabricate confidence. No hand-curated lists,
// no invented "famous trader" names: a wallet is just an on-chain address.

// A coin is a "winner" for a wallet that net-bought it if it graduated or pumped.
// ATH multiple weights HOW good a win was (a 50x graduate beats a 3x pump).
const WINNING_OUTCOMES = new Set(['graduated', 'pumped']);

// Confidence regression — mirrors trader-stats.js. A wallet with few judged
// launches regresses toward NEUTRAL_SCORE so a 1-for-1 fluke can't read as elite.
const CONFIDENCE_FULL_AT = 8;   // judged launches for full statistical confidence
const NEUTRAL_SCORE = 38;       // unproven wallets regress toward this (below mid)

// ATH normalization: a mean ATH multiple of ~ATH_TANH_X across wins maps to a
// strongly positive sub-score. tanh keeps a single moonshot from saturating.
const ATH_TANH_X = 8;

// Label thresholds (applied AFTER confidence regression, so they require a record).
const PROVEN_SCORE = 70;        // smart_money label floor
const STRONG_SCORE = 55;        // strong label floor
const MIN_JUDGED_FOR_LABEL = 3; // need this many judged launches to earn a quality label

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x) => clamp(Number.isFinite(x) ? x : 0, 0, 1);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const tanh = (x) => Math.tanh(x);

/**
 * Score one wallet from its judged launches.
 *
 * @param {Array<{outcome:string, ath_multiple:number|null, net_buy_lamports:number,
 *                first_seen:number|null, last_seen:number|null, is_fresh?:boolean}>} judged
 *   one entry per coin this wallet net-bought that now has a final outcome.
 * @returns {{
 *   trades_seen:number, winners:number, losers:number, win_rate:number,
 *   avg_ath_multiple:number, realized_score:number, confidence:number,
 *   labels:string[], first_seen:number|null, last_seen:number|null
 * }}
 */
export function scoreWallet(judged) {
	const rows = Array.isArray(judged) ? judged : [];
	const tradesSeen = rows.length;

	let winners = 0;
	let losers = 0;
	let athSum = 0;
	let athCount = 0;
	let firstSeen = null;
	let lastSeen = null;
	let freshObserved = 0;

	for (const r of rows) {
		const outcome = String(r.outcome || '');
		if (WINNING_OUTCOMES.has(outcome)) winners++;
		else losers++;

		const ath = num(r.ath_multiple, NaN);
		if (Number.isFinite(ath) && ath > 0) { athSum += ath; athCount++; }

		const fs = num(r.first_seen, NaN);
		const ls = num(r.last_seen, NaN);
		if (Number.isFinite(fs)) firstSeen = firstSeen == null ? fs : Math.min(firstSeen, fs);
		if (Number.isFinite(ls)) lastSeen = lastSeen == null ? ls : Math.max(lastSeen, ls);
		if (r.is_fresh) freshObserved++;
	}

	const winRate = tradesSeen ? winners / tradesSeen : 0;
	const avgAth = athCount ? athSum / athCount : 0;

	// Raw quality (0..1): win-rate is the backbone; ATH magnitude lifts wallets
	// that don't just clip 3x pumps but ride graduations to multiples.
	const winComponent = clamp01(winRate);                 // 0..1
	const athComponent = 0.5 + 0.5 * tanh((avgAth - 1) / ATH_TANH_X); // 0.5..1 for avgAth>=1
	let raw = winComponent * 0.7 + athComponent * 0.3;

	// Confidence regression toward neutral until the wallet has a real sample.
	const confidence = clamp(tradesSeen / CONFIDENCE_FULL_AT, 0, 1);
	const effective = raw * confidence + (NEUTRAL_SCORE / 100) * (1 - confidence);
	const realizedScore = Math.round(clamp(effective * 100, 0, 100));

	const labels = [];
	if (tradesSeen >= MIN_JUDGED_FOR_LABEL) {
		if (realizedScore >= PROVEN_SCORE) labels.push('smart_money');
		else if (realizedScore >= STRONG_SCORE) labels.push('strong');
		if (winRate <= 0.15 && winners === 0) labels.push('rugger');
		else if (realizedScore < NEUTRAL_SCORE) labels.push('weak');
	} else {
		labels.push('fresh');
	}
	// A wallet observed mostly via brand-new (no-history) accounts is flagged fresh
	// even with some sample — it behaves like a throwaway, not a tracked trader.
	if (tradesSeen > 0 && freshObserved / tradesSeen >= 0.8 && !labels.includes('fresh')) labels.push('fresh');

	return {
		trades_seen: tradesSeen,
		winners,
		losers,
		win_rate: Number(winRate.toFixed(4)),
		avg_ath_multiple: Number(avgAth.toFixed(3)),
		realized_score: realizedScore,
		confidence: Number(confidence.toFixed(3)),
		labels,
		first_seen: firstSeen,
		last_seen: lastSeen,
	};
}

// ── Union-Find over shared-funder edges ──────────────────────────────────────
// Two wallets are linked when they share the same on-chain funder. The connected
// components are the sybil/insider clusters: many "different" wallets fed by one
// source. cluster_id is the lexicographically smallest member (deterministic →
// idempotent reruns).

class UnionFind {
	constructor() { this.parent = new Map(); }
	find(x) {
		if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
		let root = x;
		while (this.parent.get(root) !== root) root = this.parent.get(root);
		// Path compression.
		let cur = x;
		while (this.parent.get(cur) !== root) { const next = this.parent.get(cur); this.parent.set(cur, root); cur = next; }
		return root;
	}
	union(a, b) {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra === rb) return;
		// Attach the larger address under the smaller so the root stays the min.
		if (ra < rb) this.parent.set(rb, ra); else this.parent.set(ra, rb);
	}
}

/**
 * Cluster wallets by shared funder.
 *
 * @param {Array<{address:string, funder:string|null}>} walletFunders
 *   one entry per distinct wallet with its (possibly null) funder.
 * @param {Map<string, Set<string>>} [coOccurrence]
 *   optional address → set of mints it bought, used to compute a co-occurrence
 *   confidence: clusters whose members repeatedly buy the SAME launches are higher
 *   confidence sybils than ones that merely share a funder once.
 * @returns {Array<{address:string, cluster_id:string, funder_root:string|null,
 *                  size:number, confidence:number}>}
 *   only members of clusters with size >= 2 (a singleton is not a cluster).
 */
export function clusterByFunder(walletFunders, coOccurrence = null) {
	const uf = new UnionFind();
	const byFunder = new Map(); // funder → [addresses]
	const funderOf = new Map(); // address → funder

	for (const { address, funder } of walletFunders) {
		if (!address) continue;
		uf.find(address); // register even if unfunded so find() is total
		if (!funder) continue;
		funderOf.set(address, funder);
		if (!byFunder.has(funder)) byFunder.set(funder, []);
		byFunder.get(funder).push(address);
	}

	// Link every pair sharing a funder (chain them — linear, not quadratic).
	for (const addrs of byFunder.values()) {
		for (let i = 1; i < addrs.length; i++) uf.union(addrs[0], addrs[i]);
	}

	// Group by component root.
	const components = new Map(); // root → Set(addresses)
	for (const { address } of walletFunders) {
		if (!address) continue;
		const root = uf.find(address);
		if (!components.has(root)) components.set(root, new Set());
		components.get(root).add(address);
	}

	const out = [];
	for (const [root, members] of components) {
		if (members.size < 2) continue; // singletons aren't clusters
		const memberArr = [...members];
		// The funder root: the funder shared by the plurality of members.
		const funderCounts = new Map();
		for (const a of memberArr) {
			const f = funderOf.get(a);
			if (f) funderCounts.set(f, (funderCounts.get(f) || 0) + 1);
		}
		let funderRoot = null;
		let best = 0;
		for (const [f, c] of funderCounts) if (c > best) { best = c; funderRoot = f; }

		const confidence = coOccurrenceConfidence(memberArr, coOccurrence);

		for (const a of memberArr) {
			out.push({
				address: a,
				cluster_id: root,
				funder_root: funderRoot,
				size: members.size,
				confidence,
			});
		}
	}
	return out;
}

// Co-occurrence confidence: share of mints bought by ANY member that were bought
// by ≥2 members. A cluster that always piles into the same launches together is a
// near-certain sybil (1.0); one whose members never overlap is a loose share (low).
function coOccurrenceConfidence(memberArr, coOccurrence) {
	if (!coOccurrence || memberArr.length < 2) return Number((0.5).toFixed(3));
	const mintCount = new Map(); // mint → distinct members that bought it
	for (const a of memberArr) {
		const mints = coOccurrence.get(a);
		if (!mints) continue;
		for (const m of mints) mintCount.set(m, (mintCount.get(m) || 0) + 1);
	}
	if (!mintCount.size) return Number((0.5).toFixed(3));
	let shared = 0;
	for (const c of mintCount.values()) if (c >= 2) shared++;
	const conf = shared / mintCount.size;
	// Floor at 0.4 — sharing a funder is itself evidence; co-occurrence sharpens it.
	return Number(clamp(0.4 + 0.6 * conf, 0, 1).toFixed(3));
}

export const _internals = {
	CONFIDENCE_FULL_AT, NEUTRAL_SCORE, PROVEN_SCORE, STRONG_SCORE,
	MIN_JUDGED_FOR_LABEL, ATH_TANH_X, coOccurrenceConfidence,
};
