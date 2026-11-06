// GET /api/users/me/tier — the signed-in member's account tier ("mode").
//
// Returns the member's primary mode plus every badge they wear (user, beta,
// pro, holder, three-dimensional), the next mode to aim for, and the full
// ladder so the dashboard can render the whole progression. 'holder' is derived
// live from on-chain $THREE across every Solana wallet the user has linked;
// every other mode comes from the user record (granted on account_tier, or
// derived from a paid plan). See api/_lib/account-tier.js.
//
// Auth: session cookie OR Bearer token. Powers the tier panel on
// /dashboard/referrals and the membership-card badge.

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { ACCOUNT_TIERS, detectHolder, resolveAccountTier } from '../../_lib/account-tier.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [user] = await sql`
		select id, plan, account_tier, wallet_address
		from users
		where id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	// Holder status is read across every Solana wallet the user controls — the
	// login wallet plus any linked ones — since they may hold $THREE in any of
	// them. detectHolder() fails closed, so an RPC hiccup never falsely awards
	// the badge.
	const linked = await sql`
		select address from user_wallets
		where user_id = ${userId} and chain_type = 'solana'
	`;
	const wallets = [user.wallet_address, ...linked.map((w) => w.address)].filter(Boolean);
	const holder = await detectHolder(wallets);

	const resolved = resolveAccountTier(user, { holder });

	return json(
		res,
		200,
		{
			tier: resolved.primary,
			badges: resolved.badges,
			granted: resolved.granted,
			holder: resolved.holder,
			plan: resolved.plan,
			next: resolved.next,
			tiers: ACCOUNT_TIERS,
		},
		{ 'cache-control': 'no-store' },
	);
});
