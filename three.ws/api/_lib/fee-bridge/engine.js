// @ts-check
// The Fee Bridge engine. One tick (api/cron/fee-bridge.js) runs, in order:
//
//   1. settle   : resolve every crank and payout sent by an earlier tick.
//   2. crank    : distribute each registered coin's accrued creator fees into the
//                 bridge wallet, recording what landed per coin.
//   3. convert  : advance one batch claimed -> swapped (SOL to USDC on Jupiter)
//                 -> bought ($THREE with the buyback share) -> swept (the $THREE
//                 to the treasury) -> credited (USDC credited to each handle).
//   4. payout   : send USDC to every linked recipient past the auto-payout floor.
//
// Every broadcast is persisted first (see chain.js), so each step is resumable
// and nothing is ever sent twice. $THREE bought here goes to the treasury; the
// platform never burns supply (api/_lib/token/config.js economy policy).

import { sql } from '../db.js';
import { logger } from '../usage.js';
import { jupiterQuote, jupiterSwapTx } from '../token/jupiter.js';
import { treasuryWallet } from '../token/config.js';
import { TOKEN_DECIMALS } from '../token/config.js';
import {
	NATIVE_SOL_MINT,
	USDC_MINT,
	THREE_MINT,
	isEnabled,
	recipientBps,
	autoPayoutAtomics,
	withdrawMinAtomics,
	minBatchAtomics,
	slippageBps,
	gasReserveLamports,
	crankIntervalMinutes,
	crankPerTick,
	payoutsPerTick,
	bridgeAddress,
	loadBridgeSigner,
} from './config.js';
import {
	broadcast,
	buildSigned,
	landedMeta,
	lamports,
	planDistribution,
	readSharingState,
	resolveTracked,
	routesOnlyTo,
	signPrebuilt,
	splBalance,
	splTransferInstructions,
} from './chain.js';
import { computeBatchCredits, lamportDelta, netOfGas, parseXHandle, payoutDecision, tokenDelta } from './math.js';
import { handleBalance, handlesAtOrAbove, resolveClaimant, solanaWallets } from './ledger.js';

const log = logger('fee-bridge');
const USDC_DECIMALS = 6;
const big = (v) => BigInt(v ?? 0);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// ── registration ────────────────────────────────────────────────────────────

/**
 * Register a coin whose creator fees already route 100% to the bridge. The route is
 * read from chain, never trusted from the caller, and the caller must control the
 * coin: either it launched it through a three.ws agent, or the fee-sharing admin
 * wallet is one of its linked wallets.
 *
 * @param {{ userId: string, mint: string, handle: string }} args
 */
export async function registerCoin({ userId, mint, handle }) {
	const bridge = await bridgeAddress();
	if (!bridge) throw fail(503, 'fee_bridge_unconfigured', 'The Fee Bridge is not configured on this deployment.');
	const clean = parseXHandle(handle);
	if (!clean) throw fail(400, 'invalid_handle', 'Enter a valid X handle (letters, digits, underscore; up to 15 characters).');

	const state = await readSharingState(mint);
	if (!state.exists) throw fail(404, 'coin_not_found', 'No pump.fun coin exists at that mint.');
	if (!state.supportedQuote) throw fail(422, 'unsupported_quote', 'The Fee Bridge supports coins quoted in SOL or USDC.');
	if (!routesOnlyTo(state, bridge)) {
		throw fail(
			409,
			'not_routed',
			`This coin's creator fees do not route 100% to the Fee Bridge wallet (${bridge}) yet. Save that split on chain first.`,
		);
	}

	const [launched] = await sql`
		select agent_id from pump_agent_mints
		where mint = ${mint} and network = 'mainnet' and user_id = ${userId}
		limit 1
	`;
	const [adminLinked] = state.admin
		? await sql`select 1 as ok from user_wallets where user_id = ${userId} and address = ${state.admin} limit 1`
		: [];
	if (!launched && !adminLinked) {
		throw fail(403, 'not_coin_owner', 'Only the account that launched this coin, or that holds its fee-sharing admin wallet, can register it.');
	}

	const [existing] = await sql`select handle, handle_lc from fee_bridge_coins where mint = ${mint}`;
	if (existing && existing.handle_lc !== clean.toLowerCase()) {
		throw fail(409, 'handle_locked', `This coin already pays @${existing.handle}. A coin's recipient cannot be changed once fees are credited to it.`);
	}

	const [row] = await sql`
		insert into fee_bridge_coins (mint, handle, handle_lc, quote_mint, registered_by, agent_id, admin_wallet, status)
		values (${mint}, ${clean}, ${clean.toLowerCase()}, ${state.quoteMint}, ${userId}, ${launched?.agent_id ?? null}, ${state.admin}, 'active')
		on conflict (mint) do update set status = 'active', admin_wallet = excluded.admin_wallet, updated_at = now()
		returning mint, handle, quote_mint, created_at, (xmax = 0) as inserted
	`;
	log.info('coin registered', { mint, handle: clean, inserted: row.inserted });
	return {
		mint: row.mint,
		handle: row.handle,
		quote: row.quote_mint === NATIVE_SOL_MINT ? 'SOL' : 'USDC',
		registered_at: row.created_at,
		created: !!row.inserted,
		admin_revoked: state.adminRevoked,
	};
}

// ── settle ──────────────────────────────────────────────────────────────────

async function settleInflows(bridge) {
	const rows = await sql`
		select id, mint, quote_mint, signature, blockhash from fee_bridge_inflows
		where status = 'sent' order by created_at limit 25
	`;
	let landed = 0;
	for (const r of rows) {
		const outcome = await resolveTracked(r.signature, r.blockhash);
		if (outcome === 'pending') continue;
		if (outcome === 'dropped' || outcome === 'reverted') {
			await sql`update fee_bridge_inflows set status = 'dropped' where id = ${r.id} and status = 'sent'`;
			continue;
		}
		const { meta, accountKeys } = await landedMeta(r.signature);
		const idx = accountKeys.indexOf(bridge);
		const fee = big(meta.fee);
		let amount;
		let gas;
		if (r.quote_mint === NATIVE_SOL_MINT) {
			amount = lamportDelta(meta, idx, idx === 0);
			gas = fee;
		} else {
			amount = tokenDelta(meta, bridge, r.quote_mint);
			gas = -lamportDelta(meta, idx, false);
		}
		await sql`
			update fee_bridge_inflows
			set status = 'landed', amount_raw = ${(amount > 0n ? amount : 0n).toString()},
				gas_lamports = ${(gas > 0n ? gas : 0n).toString()}, landed_at = now()
			where id = ${r.id} and status = 'sent'
		`;
		landed++;
	}
	return { checked: rows.length, landed };
}

async function settlePayouts() {
	const rows = await sql`
		select id, signature, blockhash from fee_bridge_payouts
		where status = 'pending' and signature is not null order by created_at limit 25
	`;
	let confirmed = 0;
	for (const r of rows) {
		const outcome = await resolveTracked(r.signature, r.blockhash);
		if (outcome === 'landed') {
			await sql`update fee_bridge_payouts set status = 'confirmed', confirmed_at = now() where id = ${r.id} and status = 'pending'`;
			confirmed++;
		} else if (outcome === 'dropped' || outcome === 'reverted') {
			await sql`update fee_bridge_payouts set status = 'failed', error = ${`transaction ${outcome}`} where id = ${r.id} and status = 'pending'`;
		}
	}
	// A payout row that never got as far as a signature died before broadcast.
	await sql`
		update fee_bridge_payouts set status = 'failed', error = 'interrupted before broadcast'
		where status = 'pending' and signature is null and created_at < now() - interval '5 minutes'
	`;
	return { checked: rows.length, confirmed };
}

// ── crank ───────────────────────────────────────────────────────────────────

async function crankCoins(signer, bridge, { dryRun, deadline }) {
	const due = await sql`
		select mint, quote_mint from fee_bridge_coins
		where status = 'active'
		  and (last_crank_at is null or last_crank_at < now() - make_interval(mins => ${crankIntervalMinutes()}))
		  and not exists (select 1 from fee_bridge_inflows i where i.mint = fee_bridge_coins.mint and i.status = 'sent')
		order by last_crank_at nulls first
		limit ${crankPerTick()}
	`;
	const results = [];
	for (const coin of due) {
		if (Date.now() > deadline) break;
		try {
			const state = await readSharingState(coin.mint);
			if (!routesOnlyTo(state, bridge)) {
				if (!dryRun) {
					await sql`update fee_bridge_coins set status = 'unrouted', last_error = 'fees no longer route 100% to the bridge', updated_at = now() where mint = ${coin.mint}`;
				}
				results.push({ mint: coin.mint, outcome: 'unrouted' });
				continue;
			}
			const plan = await planDistribution(coin.mint, coin.quote_mint, signer.publicKey);
			if (!plan.canDistribute || dryRun) {
				if (!dryRun) await sql`update fee_bridge_coins set last_crank_at = now(), last_error = null where mint = ${coin.mint}`;
				results.push({ mint: coin.mint, outcome: plan.canDistribute ? 'would_distribute' : 'below_minimum', distributable: plan.distributable.toString() });
				continue;
			}
			const { tx, signature, blockhash } = await buildSigned(signer, plan.instructions);
			await sql`
				insert into fee_bridge_inflows (mint, quote_mint, signature, blockhash)
				values (${coin.mint}, ${coin.quote_mint}, ${signature}, ${blockhash})
			`;
			await sql`update fee_bridge_coins set last_crank_at = now(), last_error = null where mint = ${coin.mint}`;
			await broadcast(tx, signature).catch((e) => log.warn('crank broadcast unresolved', { mint: coin.mint, signature, err: e?.message }));
			results.push({ mint: coin.mint, outcome: 'sent', signature });
		} catch (e) {
			log.warn('crank failed', { mint: coin.mint, err: e?.message });
			if (!dryRun) {
				await sql`update fee_bridge_coins set last_crank_at = now(), last_error = ${String(e?.message || e).slice(0, 500)} where mint = ${coin.mint}`;
			}
			results.push({ mint: coin.mint, outcome: 'error', error: e?.message });
		}
	}
	return results;
}

// ── convert ─────────────────────────────────────────────────────────────────

/** Per-coin inputs of a batch, deterministic from its rows (so a resumed credit recomputes identically). */
async function batchCoins(batchId, usdcFromSol, solNet) {
	const rows = await sql`
		select i.mint, c.handle_lc, i.quote_mint,
			sum(i.amount_raw)::text as amount, sum(i.gas_lamports)::text as gas
		from fee_bridge_inflows i join fee_bridge_coins c on c.mint = i.mint
		where i.batch_id = ${batchId}
		group by i.mint, c.handle_lc, i.quote_mint
		order by i.mint
	`;
	return rows.map((r) => {
		const amount = big(r.amount);
		const gas = big(r.gas);
		if (r.quote_mint === NATIVE_SOL_MINT) {
			return { mint: r.mint, handle_lc: r.handle_lc, sol_net: netOfGas(amount, gas), usdc_in: 0n };
		}
		// A USDC-quoted coin's gas was paid in SOL: charge it back at this batch's own
		// SOL->USDC rate when the batch swapped SOL, otherwise the bridge absorbs it.
		const gasUsdc = solNet > 0n ? (gas * usdcFromSol) / solNet : 0n;
		return { mint: r.mint, handle_lc: r.handle_lc, sol_net: 0n, usdc_in: netOfGas(amount, gasUsdc) };
	});
}

async function openBatch(signer, { dryRun }) {
	const pending = await sql`
		select i.id, i.quote_mint, i.amount_raw::text as amount, i.gas_lamports::text as gas
		from fee_bridge_inflows i
		where i.status = 'landed' and i.batch_id is null
		order by i.created_at limit 500
	`;
	if (!pending.length) return { outcome: 'nothing_pending' };

	let solNet = 0n;
	let usdcIn = 0n;
	for (const p of pending) {
		if (p.quote_mint === NATIVE_SOL_MINT) solNet += netOfGas(big(p.amount), big(p.gas));
		else usdcIn += big(p.amount);
	}

	let quotedUsdc = 0n;
	if (solNet > 0n) {
		const q = await jupiterQuote({ inputMint: NATIVE_SOL_MINT, outputMint: USDC_MINT, amount: solNet, slippageBps: slippageBps() });
		quotedUsdc = big(q.outAmount);
	}
	const worth = quotedUsdc + usdcIn;
	if (worth < minBatchAtomics()) {
		return { outcome: 'below_batch_floor', worth_usdc_atomics: worth.toString(), floor_usdc_atomics: minBatchAtomics().toString() };
	}

	const bridge = signer.publicKey.toBase58();
	const [sol, usdc] = await Promise.all([lamports(bridge), splBalance(bridge, USDC_MINT)]);
	if (sol < solNet + gasReserveLamports()) {
		return { outcome: 'awaiting_gas', sol_lamports: sol.toString(), need_lamports: (solNet + gasReserveLamports()).toString() };
	}
	if (usdc < usdcIn) {
		log.error('bridge USDC below recorded USDC inflows', { usdc: usdc.toString(), usdcIn: usdcIn.toString() });
		return { outcome: 'usdc_mismatch' };
	}
	if (dryRun) return { outcome: 'would_convert', inflows: pending.length, sol_net_lamports: solNet.toString(), usdc_in_atomics: usdcIn.toString(), quoted_usdc_atomics: quotedUsdc.toString() };

	let batch;
	try {
		[batch] = await sql`
			insert into fee_bridge_batches (stage, sol_net_lamports, usdc_in_atomics)
			values ('claimed', ${solNet.toString()}, ${usdcIn.toString()})
			returning *
		`;
	} catch (e) {
		if (String(e?.code) === '23505') return { outcome: 'batch_in_flight' };
		throw e;
	}
	const ids = pending.map((p) => p.id);
	await sql`update fee_bridge_inflows set batch_id = ${batch.id} where id = any(${ids}::uuid[]) and batch_id is null`;
	return { outcome: 'opened', batch };
}

async function swapSolToUsdc(signer, batch) {
	const solNet = big(batch.sol_net_lamports);
	if (solNet === 0n) {
		const [b] = await sql`update fee_bridge_batches set stage = 'swapped', updated_at = now() where id = ${batch.id} and stage = 'claimed' returning *`;
		return b;
	}
	if (batch.swap_sig) {
		const outcome = await resolveTracked(batch.swap_sig, batch.swap_blockhash);
		if (outcome === 'pending') return null;
		if (outcome === 'landed') {
			const { meta } = await landedMeta(batch.swap_sig);
			const got = tokenDelta(meta, signer.publicKey.toBase58(), USDC_MINT);
			const [b] = await sql`
				update fee_bridge_batches set stage = 'swapped', usdc_from_sol_atomics = ${(got > 0n ? got : 0n).toString()}, updated_at = now()
				where id = ${batch.id} and stage = 'claimed' returning *
			`;
			return b;
		}
		await sql`update fee_bridge_batches set swap_sig = null, swap_blockhash = null, error = ${`swap ${outcome}, retrying`}, updated_at = now() where id = ${batch.id}`;
		return null;
	}
	const quote = await jupiterQuote({ inputMint: NATIVE_SOL_MINT, outputMint: USDC_MINT, amount: solNet, slippageBps: slippageBps() });
	const b64 = await jupiterSwapTx({ quote, userPublicKey: signer.publicKey.toBase58(), wrapAndUnwrapSol: true });
	const { tx, signature, blockhash } = signPrebuilt(signer, b64);
	await sql`update fee_bridge_batches set swap_sig = ${signature}, swap_blockhash = ${blockhash}, updated_at = now() where id = ${batch.id}`;
	await broadcast(tx, signature);
	const [fresh] = await sql`select * from fee_bridge_batches where id = ${batch.id}`;
	return swapSolToUsdc(signer, fresh);
}

async function buyThree(signer, batch) {
	// Fix the split the first time this stage runs, from the batch's own rows.
	if (big(batch.recipient_usdc_atomics) === 0n && big(batch.buyback_usdc_atomics) === 0n) {
		const coins = await batchCoins(batch.id, big(batch.usdc_from_sol_atomics), big(batch.sol_net_lamports));
		const { recipientTotal, buybackTotal } = computeBatchCredits({ coins, usdcFromSol: big(batch.usdc_from_sol_atomics), recipientBps: recipientBps() });
		[batch] = await sql`
			update fee_bridge_batches set recipient_usdc_atomics = ${recipientTotal.toString()}, buyback_usdc_atomics = ${buybackTotal.toString()}, updated_at = now()
			where id = ${batch.id} returning *
		`;
	}
	const spend = big(batch.buyback_usdc_atomics);
	if (spend === 0n) {
		const [b] = await sql`update fee_bridge_batches set stage = 'swept', updated_at = now() where id = ${batch.id} and stage = 'swapped' returning *`;
		return b;
	}
	if (batch.buy_sig) {
		const outcome = await resolveTracked(batch.buy_sig, batch.buy_blockhash);
		if (outcome === 'pending') return null;
		if (outcome === 'landed') {
			const { meta } = await landedMeta(batch.buy_sig);
			const got = tokenDelta(meta, signer.publicKey.toBase58(), THREE_MINT);
			const [b] = await sql`
				update fee_bridge_batches set stage = 'bought', three_bought_atomics = ${(got > 0n ? got : 0n).toString()}, updated_at = now()
				where id = ${batch.id} and stage = 'swapped' returning *
			`;
			return b;
		}
		await sql`update fee_bridge_batches set buy_sig = null, buy_blockhash = null, error = ${`buyback ${outcome}, retrying`}, updated_at = now() where id = ${batch.id}`;
		return null;
	}
	const quote = await jupiterQuote({ inputMint: USDC_MINT, outputMint: THREE_MINT, amount: spend, slippageBps: slippageBps() });
	const b64 = await jupiterSwapTx({ quote, userPublicKey: signer.publicKey.toBase58() });
	const { tx, signature, blockhash } = signPrebuilt(signer, b64);
	await sql`update fee_bridge_batches set buy_sig = ${signature}, buy_blockhash = ${blockhash}, updated_at = now() where id = ${batch.id}`;
	await broadcast(tx, signature);
	const [fresh] = await sql`select * from fee_bridge_batches where id = ${batch.id}`;
	return buyThree(signer, fresh);
}

async function sweepThree(signer, batch) {
	const amount = big(batch.three_bought_atomics);
	const treasury = treasuryWallet();
	if (amount === 0n || treasury === signer.publicKey.toBase58()) {
		const [b] = await sql`update fee_bridge_batches set stage = 'swept', updated_at = now() where id = ${batch.id} and stage = 'bought' returning *`;
		return b;
	}
	if (batch.sweep_sig) {
		const outcome = await resolveTracked(batch.sweep_sig, batch.sweep_blockhash);
		if (outcome === 'pending') return null;
		if (outcome === 'landed') {
			const [b] = await sql`update fee_bridge_batches set stage = 'swept', updated_at = now() where id = ${batch.id} and stage = 'bought' returning *`;
			return b;
		}
		await sql`update fee_bridge_batches set sweep_sig = null, sweep_blockhash = null, error = ${`sweep ${outcome}, retrying`}, updated_at = now() where id = ${batch.id}`;
		return null;
	}
	const ixs = await splTransferInstructions({
		from: signer.publicKey,
		to: treasury,
		mint: THREE_MINT,
		decimals: TOKEN_DECIMALS,
		amount,
		memo: `three.ws fee bridge buyback to treasury (batch ${batch.id})`,
	});
	const { tx, signature, blockhash } = await buildSigned(signer, ixs);
	await sql`update fee_bridge_batches set sweep_sig = ${signature}, sweep_blockhash = ${blockhash}, updated_at = now() where id = ${batch.id}`;
	await broadcast(tx, signature);
	const [fresh] = await sql`select * from fee_bridge_batches where id = ${batch.id}`;
	return sweepThree(signer, fresh);
}

async function creditBatch(batch) {
	const usdcFromSol = big(batch.usdc_from_sol_atomics);
	const coins = await batchCoins(batch.id, usdcFromSol, big(batch.sol_net_lamports));
	const { credits } = computeBatchCredits({ coins, usdcFromSol, recipientBps: recipientBps() });
	for (const c of credits) {
		await sql`
			insert into fee_bridge_credits (batch_id, mint, handle_lc, usdc_atomics)
			values (${batch.id}, ${c.mint}, ${c.handle_lc}, ${c.usdc_atomics.toString()})
			on conflict (batch_id, mint) do nothing
		`;
	}
	const [b] = await sql`
		update fee_bridge_batches set stage = 'credited', error = null, completed_at = now(), updated_at = now()
		where id = ${batch.id} and stage = 'swept' returning *
	`;
	return b;
}

async function convert(signer, { dryRun, deadline }) {
	let [batch] = await sql`
		select * from fee_bridge_batches where stage in ('claimed', 'swapped', 'bought', 'swept') order by created_at limit 1
	`;
	if (!batch) {
		const opened = await openBatch(signer, { dryRun });
		if (opened.outcome !== 'opened') return opened;
		batch = opened.batch;
	} else if (dryRun) {
		return { outcome: 'would_resume', batch_id: batch.id, stage: batch.stage };
	}

	const steps = { claimed: swapSolToUsdc, swapped: buyThree, bought: sweepThree, swept: (_s, b) => creditBatch(b) };
	while (batch && batch.stage !== 'credited' && Date.now() < deadline) {
		const step = steps[batch.stage];
		try {
			const next = await step(signer, batch);
			if (!next) return { outcome: 'waiting', batch_id: batch.id, stage: batch.stage };
			batch = next;
		} catch (e) {
			await sql`update fee_bridge_batches set error = ${String(e?.message || e).slice(0, 500)}, updated_at = now() where id = ${batch.id}`;
			log.warn('conversion step failed', { batch: batch.id, stage: batch.stage, err: e?.message });
			return { outcome: 'step_error', batch_id: batch.id, stage: batch.stage, error: e?.message };
		}
	}
	return { outcome: batch?.stage === 'credited' ? 'credited' : 'paused', batch_id: batch?.id, stage: batch?.stage };
}

// ── payout ──────────────────────────────────────────────────────────────────

/**
 * Pay a handle's unpaid USDC to its owner's wallet.
 * @param {object} args
 * @param {import('@solana/web3.js').Keypair} args.signer
 * @param {{ handleLc: string, handle: string, xUserId: string, userId: string }} args.claimant
 * @param {'auto'|'withdraw'} args.trigger
 * @param {string} [args.wallet]  a specific linked wallet; defaults to the primary
 */
export async function payClaimant({ signer, claimant, trigger, wallet }) {
	const wallets = await solanaWallets(claimant.userId);
	if (!wallets.length) throw fail(409, 'no_wallet', 'Link a Solana wallet to your three.ws account to receive payouts.');
	const dest = wallet ? wallets.find((w) => w.address === wallet)?.address : wallets[0].address;
	if (!dest) throw fail(400, 'wallet_not_linked', 'That wallet is not linked to your account.');

	const { unpaid } = await handleBalance(claimant.handleLc);
	const decision = payoutDecision({ balance: unpaid, trigger, autoFloor: autoPayoutAtomics(), withdrawFloor: withdrawMinAtomics() });
	if (!decision.pay) {
		throw fail(409, decision.reason, decision.reason === 'no_balance' ? 'There is nothing to withdraw yet.' : `Withdrawals start at $${(Number(decision.floor) / 1e6).toFixed(2)}.`);
	}
	const amount = /** @type {bigint} */ (decision.amount);
	const float = await splBalance(signer.publicKey.toBase58(), USDC_MINT);
	if (float < amount) {
		log.error('bridge USDC float below a credited balance', { handle: claimant.handleLc, amount: amount.toString(), float: float.toString() });
		throw fail(503, 'float_short', 'Payouts are briefly paused while the bridge settles. Try again shortly.');
	}

	// Bind the handle to this X account on its first payout.
	await sql`
		insert into fee_bridge_recipients (handle_lc, handle, x_user_id, user_id)
		values (${claimant.handleLc}, ${claimant.handle}, ${claimant.xUserId}, ${claimant.userId})
		on conflict (handle_lc) do nothing
	`;

	// The balance check and the insert are one statement, and the partial unique
	// index allows one pending payout per handle, so concurrent requests cannot
	// both spend the same balance.
	let payout;
	try {
		[payout] = await sql`
			insert into fee_bridge_payouts (handle_lc, user_id, wallet, usdc_atomics, trigger)
			select ${claimant.handleLc}, ${claimant.userId}, ${dest}, ${amount.toString()}::numeric, ${trigger}
			where (
				(select coalesce(sum(usdc_atomics), 0) from fee_bridge_credits where handle_lc = ${claimant.handleLc})
				- (select coalesce(sum(usdc_atomics), 0) from fee_bridge_payouts where handle_lc = ${claimant.handleLc} and status in ('pending', 'confirmed'))
			) >= ${amount.toString()}::numeric
			returning id
		`;
	} catch (e) {
		if (String(e?.code) === '23505') throw fail(409, 'payout_in_flight', 'A payout for this account is already on its way.');
		throw e;
	}
	if (!payout) throw fail(409, 'balance_changed', 'Your balance changed. Refresh and try again.');

	try {
		const ixs = await splTransferInstructions({
			from: signer.publicKey,
			to: dest,
			mint: USDC_MINT,
			decimals: USDC_DECIMALS,
			amount,
			memo: `three.ws fee bridge payout to @${claimant.handle}`,
		});
		const { tx, signature, blockhash } = await buildSigned(signer, ixs);
		await sql`update fee_bridge_payouts set signature = ${signature}, blockhash = ${blockhash} where id = ${payout.id}`;
		try {
			await broadcast(tx, signature);
			await sql`update fee_bridge_payouts set status = 'confirmed', confirmed_at = now() where id = ${payout.id} and status = 'pending'`;
			return { id: payout.id, status: 'confirmed', signature, wallet: dest, usdc_atomics: amount.toString() };
		} catch (e) {
			// Sent but unconfirmed: the settle step resolves it from chain.
			log.warn('payout unconfirmed', { id: payout.id, signature, err: e?.message });
			if (e?.code === 'tx_reverted') {
				await sql`update fee_bridge_payouts set status = 'failed', error = ${String(e.message).slice(0, 500)} where id = ${payout.id} and status = 'pending'`;
				throw fail(502, 'payout_reverted', 'The payout transaction failed on chain. Your balance is unchanged; try again.');
			}
			return { id: payout.id, status: 'pending', signature, wallet: dest, usdc_atomics: amount.toString() };
		}
	} catch (e) {
		if (e?.status) throw e;
		await sql`update fee_bridge_payouts set status = 'failed', error = ${String(e?.message || e).slice(0, 500)} where id = ${payout.id} and status = 'pending' and signature is null`;
		throw fail(502, 'payout_failed', 'The payout could not be sent. Your balance is unchanged; try again.');
	}
}

async function autoPayouts(signer, { dryRun, deadline }) {
	const due = await handlesAtOrAbove(autoPayoutAtomics(), payoutsPerTick());
	const results = [];
	for (const d of due) {
		if (Date.now() > deadline) break;
		const claimant = await resolveClaimant({ handleLc: d.handleLc });
		if (!claimant) {
			results.push({ handle: d.handleLc, outcome: 'unclaimed' });
			continue;
		}
		const wallets = await solanaWallets(claimant.userId);
		if (!wallets.length) {
			results.push({ handle: d.handleLc, outcome: 'no_wallet' });
			continue;
		}
		if (dryRun) {
			results.push({ handle: d.handleLc, outcome: 'would_pay', usdc_atomics: d.unpaid.toString(), wallet: wallets[0].address });
			continue;
		}
		try {
			const r = await payClaimant({ signer, claimant, trigger: 'auto' });
			results.push({ handle: d.handleLc, outcome: r.status, signature: r.signature, usdc_atomics: r.usdc_atomics });
		} catch (e) {
			results.push({ handle: d.handleLc, outcome: 'error', error: e?.code || e?.message });
		}
	}
	return results;
}

// ── tick ────────────────────────────────────────────────────────────────────

/**
 * One full engine pass. `dryRun` reads chain and DB and reports what it would do
 * without signing anything.
 * @param {{ dryRun?: boolean, budgetMs?: number }} [opts]
 */
export async function runTick({ dryRun = false, budgetMs = 50_000 } = {}) {
	const deadline = Date.now() + budgetMs;
	if (!isEnabled() && !dryRun) return { ok: true, skipped: 'disabled' };
	const bridge = await bridgeAddress();
	if (!bridge) return { ok: true, skipped: 'signer_unconfigured' };
	const signer = dryRun ? { publicKey: new (await import('@solana/web3.js')).PublicKey(bridge) } : await loadBridgeSigner();

	const out = { ok: true, dry_run: dryRun, bridge };
	if (!dryRun) {
		out.settled_inflows = await settleInflows(bridge);
		out.settled_payouts = await settlePayouts();
	}
	out.cranks = await crankCoins(signer, bridge, { dryRun, deadline });
	out.conversion = Date.now() < deadline ? await convert(signer, { dryRun, deadline }) : { outcome: 'out_of_time' };
	out.payouts = Date.now() < deadline ? await autoPayouts(signer, { dryRun, deadline }) : [];
	return out;
}
