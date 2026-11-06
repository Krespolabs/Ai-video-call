/**
 * GET /api/cosmetics/owned?account=<accountId> — the premium cosmetics an
 * account has purchased over the x402 rail (R22 ownership ledger).
 *
 * Returns the owned ids plus their resolved catalog rows, so the owned-inventory
 * (R23) can render "My Cosmetics" from one call. Base-pack items are owned by
 * every avatar implicitly and are NOT listed here — this is only the purchased
 * (premium) set. Degrades to an empty list if the account owns nothing or the
 * store is unreachable.
 *
 * Query params:
 *   account (required) — a Solana wallet address or a guest id (g_…).
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getCosmetic, priceOf, priceUsdcAtomicsOf, priceUsdcDisplayOf } from '../_lib/cosmetics.js';
import { readOwnedCosmetics, normalizeAccountId } from '../_lib/cosmetics-ownership.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const account = normalizeAccountId(url.searchParams.get('account'));
	if (!account) {
		return error(res, 400, 'account_required',
			'query parameter "account" is required (a Solana wallet or guest id)');
	}

	const ownedIds = await readOwnedCosmetics(account);
	// Resolve to catalog rows, dropping ids that no longer exist in the catalog
	// (a cosmetic retired after purchase) so the inventory never renders a ghost.
	const items = ownedIds
		.map((id) => {
			const c = getCosmetic(id);
			if (!c) return null;
			return {
				id: c.id,
				name: c.name,
				slot: c.slot,
				kind: c.kind,
				rarity: c.rarity,
				price: priceOf(c),
				currency: 'THREE',
				priceUsdcAtomics: priceUsdcAtomicsOf(c),
				priceUsdc: priceUsdcDisplayOf(c),
				owned: true,
				previewImage: c.previewImage || null,
				...(c.glbUrl ? { glbUrl: c.glbUrl, attachBone: c.attachBone } : {}),
				...(c.morphBinding ? { morphBinding: c.morphBinding } : {}),
				...(c.colors ? { colors: c.colors } : {}),
				...(c.emote ? { emote: c.emote } : {}),
			};
		})
		.filter(Boolean);

	// Per-account, fast-changing — never cache at the edge.
	return json(res, 200, { account, ownedIds, items }, { 'cache-control': 'no-store' });
});
