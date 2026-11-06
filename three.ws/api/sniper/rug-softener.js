// @ts-check
// /api/sniper/rug-softener: the first-rug softener, for the signed-in account
// (docs/growth-programs.md).
//
//   GET   eligibility for the caller's first-ever live trade: every criterion
//         met or unmet with a plain reason, the amount it would pay, and any
//         claim already on file. Always answers, armed or not.
//   POST  record a claim. Refused with 403 program_not_open unless the owner
//         has armed the program (RUG_SOFTENER_ENABLED). An accepted claim lands
//         in the payout ledger as 'claimed' and is paid by
//         /api/cron/growth-payouts within the program's daily cap.
//
// Auth: session (with CSRF on POST) or a bearer token. The response only ever
// describes the caller's own account.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { programConfig } from '../_lib/growth-programs/config.js';
import { rugSoftenerStatus, submitRugClaim } from '../_lib/growth-programs/rug-softener.js';
import { solPriceUsd } from '../_lib/sol-price.js';

async function requireUser(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) {
		error(res, 401, 'unauthorized', 'sign in required');
		return null;
	}
	return { userId: session?.id ?? bearer.userId, viaSession: !!session };
}

async function existingClaim(userId) {
	const rows = await sql`
		select id, status, usd_value::float as usd_value, amount_atomics::text as amount_atomics,
		       tx_signature, recipient_wallet, created_at, sent_at
		from growth_program_payouts
		where program = 'rug_softener' and user_id = ${userId}
		limit 1
	`.catch(() => []);
	return rows[0] || null;
}

function programView(cfg) {
	return {
		armed: cfg.enabled,
		reimburse_pct: cfg.reimbursePct,
		max_per_claim_usd: cfg.maxPerClaimUsd,
		claim_window_days: cfg.claimWindowDays,
		min_loss_sol: cfg.minLossSol,
		min_entry_sol: cfg.minEntrySol,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await requireUser(req, res);
	if (!auth) return;
	const cfg = programConfig().rugSoftener;
	const solUsd = (await solPriceUsd().catch(() => 0)) || null;

	if (req.method === 'GET') {
		const [{ verdict, evidence }, claim] = await Promise.all([
			rugSoftenerStatus(auth.userId, cfg, { solUsd }),
			existingClaim(auth.userId),
		]);
		return json(res, 200, {
			program: programView(cfg),
			eligible: verdict.eligible && !claim,
			unmet: verdict.unmet,
			amount: verdict.amount,
			position: evidence,
			claim,
		}, { 'cache-control': 'no-store' });
	}

	if (auth.viaSession && !(await requireCsrf(req, res, auth.userId))) return;
	if (!cfg.enabled) {
		return error(res, 403, 'program_not_open', 'The first-rug softener is not open for claims yet.');
	}
	const result = await submitRugClaim(auth.userId, cfg, { solUsd });
	if (!result.ok) {
		if (result.code === 'already_claimed') return error(res, 409, 'already_claimed', 'A claim is already on file for this account or wallet.');
		return error(res, 422, 'not_eligible', 'This account is not eligible for the first-rug softener.', { unmet: result.verdict?.unmet || [] });
	}
	return json(res, 201, { ok: true, claim: result.claim });
});
