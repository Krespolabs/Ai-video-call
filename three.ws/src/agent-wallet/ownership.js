/**
 * Ownership resolution for the agent-wallet affordance.
 *
 * One agent, one owner. A surface that lists agents/avatars (a marketplace grid,
 * a leaderboard, a world inspect panel) needs to know, per record, whether the
 * signed-in viewer owns it — that's the only thing that decides whether the
 * affordance renders the owner hub (vanity/withdraw) or the visitor view
 * (tip/pay/fork).
 *
 * Server-rendered detail endpoints already carry an authoritative `is_owner`
 * (api/agents/:id and the marketplace detail). But the cacheable public list
 * (GET /api/marketplace/agents) is shared across viewers, so it cannot embed a
 * per-viewer flag — it ships `author_id` instead. This module fetches the
 * current user id ONCE per page and lets a surface stamp `is_owner` onto those
 * records client-side.
 *
 * Security note: this flag only chooses which buttons render. Every owner-only
 * action (withdraw, vanity grind/assign, limit changes) is re-authorized
 * server-side against the session, so a tampered flag grants nothing.
 */

let mePromise = null;

/**
 * The signed-in viewer's user id, or null when anonymous. Cached for the page
 * lifetime — the first card that needs it pays the request, the rest are free.
 * A transient failure resolves to null (treated as anonymous) and is retried on
 * the next call.
 */
export async function currentUserId() {
	if (mePromise) return mePromise;
	mePromise = (async () => {
		try {
			const r = await fetch('/api/auth/me', { credentials: 'include' });
			if (!r.ok) return null;
			const body = await r.json().catch(() => null);
			return body?.user?.id || null;
		} catch {
			mePromise = null; // allow a later retry after a transient failure
			return null;
		}
	})();
	return mePromise;
}

/** Forget the cached viewer (call after sign-in / sign-out). */
export function resetOwnershipCache() {
	mePromise = null;
}

/** The owner id carried by any supported record shape, or null. */
function ownerIdOf(record) {
	if (!record || typeof record !== 'object') return null;
	return (
		record.author_id ??
		record.owner_id ??
		record.user_id ??
		record.meta?.user_id ??
		null
	);
}

/**
 * Resolve ownership for one record. Trusts an explicit server `is_owner` /
 * `isOwner` when present; otherwise compares the record's owner id to the
 * signed-in viewer. Returns the boolean (and does not mutate).
 */
export async function isOwnedByViewer(record) {
	if (record == null) return false;
	if (typeof record.is_owner === 'boolean') return record.is_owner;
	if (typeof record.isOwner === 'boolean') return record.isOwner;
	const owner = ownerIdOf(record);
	if (!owner) return false;
	const me = await currentUserId();
	return !!me && owner === me;
}

/**
 * Stamp `is_owner` onto every record in a list in place (one /auth/me fetch for
 * the whole list) and return the same array. The one-liner a card grid calls
 * before mounting the affordance:
 *
 *   await markOwnership(agents);
 *   for (const a of agents) mountAgentWallet({ mount: cardWalletEl(a), agent: a, tier: 'compact' });
 */
export async function markOwnership(records) {
	if (!Array.isArray(records) || records.length === 0) return records || [];
	// Records that already carry a server flag don't need the viewer at all.
	const needsViewer = records.some(
		(r) => r && typeof r.is_owner !== 'boolean' && typeof r.isOwner !== 'boolean' && ownerIdOf(r),
	);
	const me = needsViewer ? await currentUserId() : null;
	for (const r of records) {
		if (!r || typeof r !== 'object') continue;
		if (typeof r.is_owner === 'boolean') continue;
		if (typeof r.isOwner === 'boolean') {
			r.is_owner = r.isOwner;
			continue;
		}
		const owner = ownerIdOf(r);
		r.is_owner = !!me && !!owner && owner === me;
	}
	return records;
}
