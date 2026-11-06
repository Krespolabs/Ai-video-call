// $THREE reward for a daily quest clear. SHIPS DISARMED.
// ---------------------------------------------------------------------------
// Paying a reward moves $THREE out of a platform wallet, which is an owner-gated
// spend. So this module is complete (config, eligibility, idempotent ledger,
// daily budget, the on-chain Token-2022 transfer) and inert: until the owner arms
// it, claimDailyClearReward returns `rewards_disarmed` before it reads a row,
// writes a row, loads a key, or opens an RPC connection.
//
// Arming it takes all three of:
//   TRADING_QUEST_THREE_REWARDS=on                  the switch (default off)
//   TRADING_QUEST_THREE_REWARD_AMOUNT=<whole $THREE> paid per daily clear, > 0
//   TRADING_QUEST_THREE_REWARD_SECRET_KEY_B64=<64-byte secret, base64>
//                                                   the funded payout wallet
// and optionally
//   TRADING_QUEST_THREE_REWARD_DAILY_BUDGET=<whole $THREE>  total paid per UTC day
//                                                   (default 20x the amount)
//
// One reward per user per UTC day, only for a day the user actually cleared
// (trading_quest_completions holds the proof), only to a Solana wallet linked to
// the account, only for today or yesterday. The ledger row is claimed before the
// transfer and marked sent or failed after, so a double click never pays twice
// and a failed payout can be retried.

import { sql as defaultSql } from './db.js';

export const THREE_MINT_DEFAULT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
export const THREE_DECIMALS = 6;
const ARM_VALUES = new Set(['on', '1', 'true', 'yes']);
const DAY_MS = 86_400_000;

const utcDay = (at) => new Date(at).toISOString().slice(0, 10);
const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, extra });

/**
 * Read the reward switch and its parameters. PURE over the env object passed in.
 * `armed` is true only when the flag is on AND an amount AND a signer are set, so
 * a half-configured deploy stays disarmed rather than failing at payout time.
 */
export function questRewardConfig(env = process.env) {
	const flag = ARM_VALUES.has(String(env.TRADING_QUEST_THREE_REWARDS || '').trim().toLowerCase());
	const amountWhole = Number(env.TRADING_QUEST_THREE_REWARD_AMOUNT);
	const amountOk = Number.isFinite(amountWhole) && amountWhole > 0;
	const budgetRaw = Number(env.TRADING_QUEST_THREE_REWARD_DAILY_BUDGET);
	const budgetWhole = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : amountOk ? amountWhole * 20 : 0;
	const secretB64 = String(env.TRADING_QUEST_THREE_REWARD_SECRET_KEY_B64 || '').trim();
	const hasSigner = secretB64.length > 0;

	let reason = null;
	if (!flag) reason = 'TRADING_QUEST_THREE_REWARDS is off';
	else if (!amountOk) reason = 'TRADING_QUEST_THREE_REWARD_AMOUNT is not set';
	else if (!hasSigner) reason = 'TRADING_QUEST_THREE_REWARD_SECRET_KEY_B64 is not set';

	return {
		armed: reason === null,
		reason,
		amount_whole: amountOk ? amountWhole : 0,
		amount_atomic: amountOk ? toAtomic(amountWhole) : 0n,
		daily_budget_whole: budgetWhole,
		daily_budget_atomic: budgetWhole > 0 ? toAtomic(budgetWhole) : 0n,
		mint: String(env.THREE_TOKEN_MINT || THREE_MINT_DEFAULT).trim(),
		secret_b64: hasSigner ? secretB64 : null,
	};
}

/** Whole $THREE to atomic units (6 decimals), exact for up to 6 decimal places. PURE. */
export function toAtomic(whole) {
	const [i, f = ''] = String(Number(whole).toFixed(THREE_DECIMALS)).split('.');
	return BigInt(i) * 10n ** BigInt(THREE_DECIMALS) + BigInt((f + '000000').slice(0, THREE_DECIMALS));
}

/** What the public quest board may show about rewards: never a key, never a reason string. PURE. */
export function publicRewardInfo(cfg) {
	return cfg.armed ? { armed: true, amount_three: cfg.amount_whole } : { armed: false };
}

/**
 * Send `amountAtomic` $THREE from the configured payout wallet to `wallet`. The
 * mint's owning program is resolved (Token-2022 for $THREE) so the derived ATAs
 * and the transfer instruction target the program that actually owns the mint.
 */
export async function sendThreeOnChain({ wallet, amountAtomic, cfg }) {
	const { Keypair, PublicKey } = await import('@solana/web3.js');
	const {
		getAssociatedTokenAddressSync,
		createAssociatedTokenAccountIdempotentInstruction,
		createTransferCheckedInstruction,
	} = await import('@solana/spl-token');
	const { solanaConnection } = await import('./agent-pumpfun.js');
	const { submitProtected } = await import('./execution-engine.js');
	const { tokenProgramForMint } = await import('./solana-token-program.js');

	const secret = Buffer.from(cfg.secret_b64, 'base64');
	if (secret.length !== 64) throw Object.assign(new Error('payout key is not a 64-byte secret'), { code: 'bad_signer' });
	const payer = Keypair.fromSecretKey(new Uint8Array(secret));
	const mint = new PublicKey(cfg.mint);
	const to = new PublicKey(wallet);
	const connection = solanaConnection('mainnet');
	const programId = await tokenProgramForMint(connection, mint);

	const fromAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, programId);
	const toAta = getAssociatedTokenAddressSync(mint, to, false, programId);
	const instructions = [
		createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, to, mint, programId),
		createTransferCheckedInstruction(fromAta, mint, toAta, payer.publicKey, amountAtomic, THREE_DECIMALS, [], programId),
	];
	const result = await submitProtected({
		network: 'mainnet',
		connection,
		payer,
		instructions,
		opts: { tipMode: 'off', confirmTimeoutMs: 45_000 },
	});
	return result.signature;
}

/**
 * Claim the $THREE reward for a cleared day.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.day      YYYY-MM-DD, today or yesterday (UTC).
 * @param {number} [p.now]
 * @param {object} [p.env]    defaults to process.env.
 * @param {object} [p.deps]   { sql, sendThree } for tests; production uses the real ones.
 */
export async function claimDailyClearReward({ userId, day, now = Date.now(), env = process.env, deps = {} }) {
	const cfg = questRewardConfig(env);
	// The gate. Nothing below this line runs while the switch is off.
	if (!cfg.armed) {
		return fail(409, 'rewards_disarmed', '$THREE quest rewards are not switched on. XP and badges still count.');
	}
	const sql = deps.sql || defaultSql;
	const sendThree = deps.sendThree || sendThreeOnChain;

	const today = utcDay(now);
	const yesterday = utcDay(Date.parse(`${today}T00:00:00.000Z`) - DAY_MS);
	if (day !== today && day !== yesterday) return fail(400, 'invalid_day', 'Rewards can be claimed for today or yesterday only.');

	const [cleared] = await sql`
		select 1 as ok from trading_quest_completions
		where user_id = ${userId} and day = ${day}::date and code = 'daily_clear'
		limit 1
	`;
	if (!cleared) return fail(409, 'not_cleared', 'Clear the daily quests first.');

	const [linked] = await sql`
		select address from user_wallets
		where user_id = ${userId} and chain_type = 'solana'
		order by is_primary desc, created_at asc
		limit 1
	`;
	if (!linked?.address) return fail(409, 'no_wallet', 'Link a Solana wallet to your account to receive $THREE.');

	const [existing] = await sql`
		select status, tx_signature from trading_quest_three_rewards
		where user_id = ${userId} and day = ${day}::date
		limit 1
	`;
	if (existing?.status === 'sent') return { ok: true, status: 'sent', tx_signature: existing.tx_signature, amount_three: cfg.amount_whole };
	if (existing?.status === 'pending') return fail(409, 'in_flight', 'This reward is already being sent.');

	const [{ spent = '0' } = {}] = await sql`
		select coalesce(sum(amount_atomic), 0)::text as spent from trading_quest_three_rewards
		where day = ${day}::date and status in ('pending', 'sent')
	`;
	if (BigInt(String(spent).split('.')[0]) + cfg.amount_atomic > cfg.daily_budget_atomic) {
		return fail(409, 'budget_exhausted', "Today's $THREE reward pool is used up. Your clear and XP still count.");
	}

	// Claim the ledger row before anything moves on-chain.
	const claimed = existing?.status === 'failed'
		? await sql`
			update trading_quest_three_rewards
			set status = 'pending', wallet = ${linked.address}, amount_atomic = ${cfg.amount_atomic.toString()}, error = null, updated_at = now()
			where user_id = ${userId} and day = ${day}::date and status = 'failed'
			returning user_id
		`
		: await sql`
			insert into trading_quest_three_rewards (user_id, day, amount_atomic, wallet, status)
			values (${userId}, ${day}::date, ${cfg.amount_atomic.toString()}, ${linked.address}, 'pending')
			on conflict do nothing
			returning user_id
		`;
	if (!claimed.length) return fail(409, 'in_flight', 'This reward is already being sent.');

	try {
		const signature = await sendThree({ wallet: linked.address, amountAtomic: cfg.amount_atomic, cfg });
		await sql`
			update trading_quest_three_rewards
			set status = 'sent', tx_signature = ${signature}, updated_at = now()
			where user_id = ${userId} and day = ${day}::date
		`;
		return { ok: true, status: 'sent', tx_signature: signature, amount_three: cfg.amount_whole };
	} catch (err) {
		const message = String(err?.message || 'transfer failed').slice(0, 300);
		await sql`
			update trading_quest_three_rewards
			set status = 'failed', error = ${message}, updated_at = now()
			where user_id = ${userId} and day = ${day}::date
		`;
		return fail(502, 'payout_failed', 'The $THREE transfer did not go through. Try again in a minute.');
	}
}
