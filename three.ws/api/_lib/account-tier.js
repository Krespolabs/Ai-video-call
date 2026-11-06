// Account tiers — a member's "mode" on three.ws.
//
// These are coarse membership modes shown on the dashboard membership card:
// the badge that says who you are on the platform. They are deliberately
// DISTINCT from the $THREE holder-VALUE ladder (api/_lib/three-tier.js:
// Member→Bronze→Silver→Gold→Genesis), which grades how much $THREE a wallet
// holds. A user can wear several modes at once, so a mode is really a badge;
// the highest-ranked active badge is the member's "primary" tier for display.
//
// Where each mode comes from (`source`):
//   • default  — 'user', everyone. The floor.
//   • grant    — assigned by an admin and stored on users.account_tier
//                ('beta', 'pro', 'three-dimensional').
//   • holder   — derived live from on-chain $THREE; never stored. Holding any
//                $THREE earns the badge and unlocks the holder-value ladder.
//   • plan     — derived from a paid subscription (users.plan in pro/team/
//                enterprise). Granting 'pro' reaches the same badge without a
//                plan, so both paths converge on one Pro badge.
//
// The resolver is a pure function over (user, { holder }) so it unit-tests
// without a wallet RPC; detectHolder() does the (fail-closed) on-chain read.

import { holderUsd } from './three-tier.js';

/**
 * The mode ladder, ordered low→high by `rank`. `rank` only decides which badge
 * is "primary" when a member wears several — it is not a spend threshold.
 */
export const ACCOUNT_TIERS = Object.freeze([
	Object.freeze({
		id: 'user',
		label: 'User',
		rank: 0,
		source: 'default',
		color: '#94a3b8',
		tagline: 'Free forever',
		description:
			'Everyone on three.ws. Full free-forever access to create avatars and agents, discover, embed, and earn referral commission.',
		perks: Object.freeze([
			'Create avatars & agents',
			'Discover, embed & share',
			'Earn 5% referral commission in USDC',
		]),
	}),
	Object.freeze({
		id: 'beta',
		label: 'Beta',
		rank: 10,
		source: 'grant',
		color: '#38bdf8',
		tagline: 'Early access',
		description:
			'Early-access program member. Try new surfaces before they ship and help shape what gets built next.',
		perks: Object.freeze([
			'Early access to new features',
			'Beta-only experiments',
			'A direct line into the roadmap',
		]),
	}),
	Object.freeze({
		id: 'pro',
		label: 'Pro',
		rank: 20,
		source: 'plan',
		color: '#f59e0b',
		tagline: 'Paid plan',
		description:
			'On a paid plan. Higher limits and priority routing across the platform.',
		perks: Object.freeze([
			'Higher storage & generation quotas',
			'Priority MCP & render routing',
			'Pro profile badge',
		]),
	}),
	Object.freeze({
		id: 'holder',
		label: 'Holder',
		rank: 30,
		source: 'holder',
		color: '#a78bfa',
		tagline: 'Holds $THREE',
		description:
			'Holds $THREE. Unlocks the hold-to-access ladder — fee discounts on compute, higher free quotas, and private/branded worlds. The more you hold, the higher your Bronze→Genesis tier.',
		perks: Object.freeze([
			'Fee discounts on $THREE compute',
			'Higher free generation quotas',
			'Private & branded worlds',
			'Holder profile badge',
		]),
	}),
	Object.freeze({
		id: 'three-dimensional',
		label: 'Three Dimensional',
		rank: 40,
		source: 'grant',
		color: '#f472b6',
		tagline: 'Top tier',
		description:
			'The top tier — founders, partners, and standout builders. Everything on the platform, unlocked, with a direct line to the team.',
		perks: Object.freeze([
			'Everything in Pro & Holder',
			'Founder profile badge',
			'Direct line to the team',
			'First dibs on rare names & drops',
		]),
	}),
]);

const BY_ID = new Map(ACCOUNT_TIERS.map((t) => [t.id, t]));

/** The default mode every member starts with. */
export const DEFAULT_TIER_ID = 'user';

/** Modes an admin can grant on users.account_tier. Derived modes are excluded. */
export const GRANTABLE_TIER_IDS = Object.freeze(
	ACCOUNT_TIERS.filter((t) => t.source === 'grant' || t.id === 'pro').map((t) => t.id),
);

/** Look up a mode definition by id, or null. */
export function tierById(id) {
	return BY_ID.get(String(id || '')) || null;
}

/** True if `id` is a mode an admin is allowed to grant. */
export function isGrantableTier(id) {
	return GRANTABLE_TIER_IDS.includes(String(id || '').toLowerCase());
}

/**
 * Normalize a stored/admin-supplied grant to a valid grantable id, or null.
 * Empty string and the sentinel 'none' both clear the grant (→ null).
 */
export function normalizeTierGrant(input) {
	if (input == null) return null;
	const id = String(input).trim().toLowerCase();
	if (id === '' || id === 'none' || id === 'user') return null;
	return isGrantableTier(id) ? id : null;
}

/**
 * Read whether any of a set of wallets holds $THREE. Fail-closed: a wallet that
 * can't be read (RPC hiccup, non-Solana address) counts as 0, so a hiccup shows
 * "not a holder" rather than falsely awarding the badge. Returns the best
 * (largest) holding found across the wallets.
 *
 * @param {string[]} walletAddresses
 * @returns {Promise<{ isHolder: boolean, amount: number, usd: number }>}
 */
export async function detectHolder(walletAddresses = []) {
	const unique = [...new Set(walletAddresses.filter(Boolean))];
	if (unique.length === 0) return { isHolder: false, amount: 0, usd: 0 };
	const results = await Promise.all(unique.map((w) => holderUsd(w)));
	let amount = 0;
	let usd = 0;
	for (const held of results) {
		if (held.amount > amount) amount = held.amount;
		if (held.usd > usd) usd = held.usd;
	}
	return { isHolder: amount > 0, amount, usd };
}

/**
 * Resolve a member's active modes from their record plus a (precomputed) holder
 * read. Pure — no I/O — so it tests without a wallet RPC.
 *
 * @param {{ account_tier?: string|null, plan?: string|null }} user
 * @param {{ holder?: { isHolder: boolean, amount: number, usd: number } }} [opts]
 * @returns {{
 *   primary: object,
 *   badges: object[],
 *   granted: string|null,
 *   holder: { isHolder: boolean, amount: number, usd: number },
 *   plan: string,
 *   next: object|null,
 *   tiers: object[],
 * }}
 */
export function resolveAccountTier(user, { holder = { isHolder: false, amount: 0, usd: 0 } } = {}) {
	const active = new Map();
	const add = (id) => {
		const t = BY_ID.get(id);
		if (t) active.set(id, t);
	};

	add('user'); // floor — always present

	const granted = normalizeTierGrant(user?.account_tier);
	if (granted) add(granted);

	if (holder.isHolder) add('holder');

	const plan = String(user?.plan || 'free').toLowerCase();
	if (plan === 'pro' || plan === 'team' || plan === 'enterprise') add('pro');

	const badges = [...active.values()].sort((a, b) => a.rank - b.rank);
	const primary = badges[badges.length - 1];

	// The lowest mode the member hasn't reached yet — the natural "what's next".
	const next = ACCOUNT_TIERS.find((t) => t.rank > primary.rank && !active.has(t.id)) || null;

	return { primary, badges, granted, holder, plan, next, tiers: ACCOUNT_TIERS };
}
