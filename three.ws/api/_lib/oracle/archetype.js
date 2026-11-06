// Oracle — wallet archetypes.
//
// The data brain (wallet_reputation) labels each wallet from its real track
// record: smart_money | sniper | dumper | rugger | fresh | neutral | unproven.
// Oracle surfaces those labels everywhere — in a coin's "who's in" panel, in the
// reputation leaderboard, on a wallet's profile — so a richer, display-ready
// description lives here once and is shared by the API and the UI.
//
// Pure module: no I/O, no DB. Safe to import in a worker, an API route, or a
// vitest. The UI mirrors the `tone` values as CSS classes (oracle-arch--good etc).

/**
 * @typedef {'smart_money'|'sniper'|'dumper'|'rugger'|'fresh'|'neutral'|'unproven'} WalletLabel
 */

const ARCHETYPES = {
	smart_money: {
		label: 'smart_money',
		title: 'Smart Money',
		glyph: '◆',
		tone: 'good',
		blurb: 'Repeatedly early into coins that went on to graduate. Following them is the edge.',
	},
	kol: {
		label: 'kol',
		title: 'KOL',
		glyph: '★',
		tone: 'good',
		blurb: 'A known influencer / caller wallet. Their entries move attention — and price — fast.',
	},
	top_dev: {
		label: 'top_dev',
		title: 'Top Dev',
		glyph: '✦',
		tone: 'warn',
		blurb: 'A creator wallet with a notable launch history. Read alongside the structure signals.',
	},
	sniper: {
		label: 'sniper',
		title: 'Sniper',
		glyph: '⊚',
		tone: 'warn',
		blurb: 'Buys in the first seconds of a launch. Fast, but not always right — weight by win rate.',
	},
	dumper: {
		label: 'dumper',
		title: 'Dumper',
		glyph: '▾',
		tone: 'bad',
		blurb: 'Sells at least half its position inside the early window. Exit liquidity for followers.',
	},
	rugger: {
		label: 'rugger',
		title: 'Rugger',
		glyph: '☠',
		tone: 'bad',
		blurb: 'Created coins that died. Their presence on a launch is a red flag.',
	},
	fresh: {
		label: 'fresh',
		title: 'Fresh Wallet',
		glyph: '○',
		tone: 'neutral',
		blurb: 'Brand-new wallet with no history. Often a funded burner — neither proof nor poison.',
	},
	neutral: {
		label: 'neutral',
		title: 'Neutral',
		glyph: '◇',
		tone: 'neutral',
		blurb: 'Trades both ways with no decisive edge. Background liquidity.',
	},
	unproven: {
		label: 'unproven',
		title: 'Unproven',
		glyph: '·',
		tone: 'neutral',
		blurb: 'Too few judged trades to earn a verdict yet. Reputation builds as outcomes land.',
	},
};

const UNKNOWN = {
	label: 'unproven',
	title: 'Unproven',
	glyph: '·',
	tone: 'neutral',
	blurb: 'No reputation on file.',
};

/**
 * Resolve a wallet_reputation label to its display archetype. Tolerant of
 * null / unknown values so callers never have to guard.
 * @param {string|null|undefined} label
 * @returns {{label:WalletLabel,title:string,glyph:string,tone:'good'|'bad'|'warn'|'neutral',blurb:string}}
 */
export function archetypeFor(label) {
	if (!label) return UNKNOWN;
	return ARCHETYPES[String(label).toLowerCase()] || UNKNOWN;
}

/** All archetypes, for legends / filter chips. */
export function allArchetypes() {
	return Object.values(ARCHETYPES);
}

/**
 * Is this label one Oracle treats as proven-positive pedigree? Used by the
 * conviction engine and the "smart wallets in" counters.
 * @param {string|null|undefined} label
 */
export function isProven(label, score = 0) {
	const l = String(label).toLowerCase();
	return l === 'smart_money' || l === 'kol' || Number(score) >= 70;
}

/**
 * Is this label one Oracle treats as a warning flag on a launch?
 * @param {string|null|undefined} label
 */
export function isFlagged(label) {
	const l = String(label).toLowerCase();
	return l === 'rugger' || l === 'dumper';
}
