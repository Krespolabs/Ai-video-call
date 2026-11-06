/**
 * GET /api/users/me/purchased-skills
 * Returns the authenticated caller's confirmed skill purchases.
 */

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const purchases = await sql`
		SELECT
			sp.id,
			sp.agent_id,
			sp.skill,
			sp.status,
			sp.kind,
			sp.amount,
			sp.currency_mint,
			sp.chain,
			sp.tx_signature,
			sp.skill_nft_mint,
			sp.skill_nft_network,
			sp.skill_nft_minted_at,
			sp.confirmed_at,
			sp.valid_until,
			sp.trial_remaining,
			sp.created_at,
			ai.name AS agent_name,
			ai.profile_image_url AS agent_thumbnail,
			ai.meta->>'solana_address' AS agent_solana_address,
			ai.meta->>'solana_vanity_prefix' AS agent_solana_vanity_prefix,
			ai.meta->>'solana_vanity_suffix' AS agent_solana_vanity_suffix
		FROM skill_purchases sp
		LEFT JOIN agent_identities ai ON ai.id = sp.agent_id
		WHERE sp.user_id = ${userId} AND sp.status IN ('confirmed', 'trial')
		ORDER BY sp.confirmed_at DESC NULLS LAST, sp.created_at DESC
	`;

	return json(res, 200, { data: { purchases } });
});
