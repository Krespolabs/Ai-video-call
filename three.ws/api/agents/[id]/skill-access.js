/**
 * GET /api/agents/:id/skill-access
 *
 * Public, non-marketplace-gated read of an agent's paid-skill catalog plus the
 * caller's purchased state. The <agent-3d> embed calls this on boot (and after a
 * purchase) to build its skill-access gate. Unlike /api/marketplace/agents/:id,
 * this works for ANY non-deleted agent regardless of marketplace publication —
 * an owner can monetize skills without ever listing the agent publicly, and a
 * valid-but-unlisted agent should not 404 here.
 *
 * Auth is optional: anonymous viewers get an empty purchased_skills list; a
 * signed-in (session or bearer) caller gets their confirmed purchases.
 *
 * Response: { data: { skill_prices, purchased_skills } }
 *   skill_prices:    Record<skill, { amount, currency_mint, chain, mint_decimals,
 *                                    trial_uses, time_pass_hours, time_pass_amount }>
 *   purchased_skills: string[]
 */

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { embedReadCors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { getSkillPrices, skillPriceMap } from '../../_lib/skill-price-cache.js';
import { viewerNftGatedSkills } from '../../_lib/nft-gate.js';
import { isUuid } from '../../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (embedReadCors(req, res)) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean)[2];
	if (!id || !isUuid(id)) return error(res, 404, 'not_found', 'agent not found');

	const [agent] = await sql`
		SELECT id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);

	const [priceRows, purchasedRows] = await Promise.all([
		getSkillPrices(id),
		auth
			? sql`
				SELECT skill FROM skill_purchases
				WHERE user_id = ${auth.userId} AND agent_id = ${id} AND status = 'confirmed'
			`
			: Promise.resolve([]),
	]);

	const skill_prices = skillPriceMap(priceRows);
	const purchased_skills = purchasedRows.map((r) => r.skill);

	// NFT-gated skills the viewer currently holds access to count as "owned" for
	// display — there is no purchase row for them. Fail-soft (display only).
	if (auth) {
		const nftSkills = await viewerNftGatedSkills(priceRows, auth.userId).catch(() => []);
		for (const s of nftSkills) if (!purchased_skills.includes(s)) purchased_skills.push(s);
	}

	return json(
		res,
		200,
		{ data: { skill_prices, purchased_skills } },
		{ 'cache-control': 'private, max-age=15' },
	);
});
