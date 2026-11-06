// Oracle worker — action executor.
//
// Turns an approved decision into a logged action. Simulate mode (the default)
// records a realistic action row — entry market cap, conviction, size — and
// spends nothing, so an owner can watch their agent work risk-free. Live mode
// loads the agent's own custodial keypair, builds a pump.fun buy via the same
// PumpTradeClient the production sniper uses, signs, and broadcasts — guarded by
// a hard per-trade SOL cap and full error capture so a bad fill logs 'failed'
// rather than crashing the loop.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { loadAgentKeypair } from './keys.js';

const LAMPORTS = 1e9;

// Rotating Jito tip accounts (from jito-labs/jito-solana, current as of 2025-Q4).
// One is picked at random per bundle to spread load across validators.
const JITO_TIP_ACCOUNTS = [
	'96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
	'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
	'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
	'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
	'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
	'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
	'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
	'3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/**
 * @param {object} args
 * @param {object} args.cfg     worker config
 * @param {object} args.watch   armed watch row (agent_id, user_id, mode, ...)
 * @param {object} args.coin    scored coin { mint, symbol, score, tier }
 * @param {number} args.size    SOL to commit
 * @param {string} args.reason  decision reason
 * @returns {Promise<{status:string, sig?:string}>}
 */
export async function executeAction({ cfg, watch, coin, size, reason }) {
	const liveRequested = watch.mode === 'live' && cfg.mode === 'live';
	const cappedSize = Math.min(size, cfg.maxTradeSolHardCap);
	const entryMc = await entryMarketCap(coin.mint, cfg.network);

	// Claim the slot first (idempotent-ish): one action row per attempt.
	const base = {
		agent_id: watch.agent_id, user_id: watch.user_id || null, network: cfg.network,
		mint: coin.mint, symbol: coin.symbol || null,
		conviction: coin.score, tier: coin.tier,
		mode: liveRequested ? 'live' : 'simulate', size_sol: cappedSize,
		reason, entry_mc_usd: entryMc,
	};

	if (!liveRequested) {
		await insertAction({ ...base, status: 'filled', tx_signature: null });
		log.info(`SIMULATE buy ${coin.symbol || coin.mint.slice(0, 6)} @ conviction ${coin.score} (${cappedSize} SOL)`);
		return { status: 'filled' };
	}

	// ── live ─────────────────────────────────────────────────────────────────
	try {
		const keys = await loadAgentKeypair(watch.agent_id, watch.user_id, 'oracle_buy');
		if (!keys) {
			await insertAction({ ...base, status: 'skipped', tx_signature: null, reason: 'agent has no Solana wallet' });
			return { status: 'skipped' };
		}
		const sig = await buyOnPump({
			network: cfg.network, mint: coin.mint, solAmount: cappedSize, payer: keys.keypair,
			useJito: cfg.useJito, jitoTipSol: cfg.jitoTipSol, jitoBundleUrl: cfg.jitoBundleUrl,
		});
		await insertAction({ ...base, status: 'filled', tx_signature: sig });
		log.info(`LIVE buy ${coin.symbol || coin.mint.slice(0, 6)} ${sig}`);
		return { status: 'filled', sig };
	} catch (err) {
		await insertAction({ ...base, status: 'failed', tx_signature: null, reason: `${reason} | exec: ${err.message}`.slice(0, 300) });
		log.warn(`LIVE buy failed ${coin.mint}: ${err.message}`);
		return { status: 'failed' };
	}
}

async function insertAction(a) {
	await sql`
		insert into oracle_watch_actions
			(agent_id, user_id, network, mint, symbol, conviction, tier, mode, size_sol, status, reason, entry_mc_usd, tx_signature, outcome)
		values
			(${a.agent_id}, ${a.user_id}, ${a.network}, ${a.mint}, ${a.symbol}, ${a.conviction}, ${a.tier},
			 ${a.mode}, ${a.size_sol}, ${a.status}, ${a.reason || null}, ${a.entry_mc_usd || null}, ${a.tx_signature || null}, 'open')
	`;
}

async function entryMarketCap(mint, network) {
	try {
		const r = await sql`select last_market_cap_usd from pump_coin_outcomes where mint = ${mint} limit 1`;
		if (r[0]?.last_market_cap_usd) return Number(r[0].last_market_cap_usd);
	} catch { /* table may be absent */ }
	return null;
}

/**
 * Build + sign + send a pump.fun buy. Routes via Jito bundle when `useJito`
 * is true (MEV-protected, validator-prioritised), otherwise sends via standard
 * RPC broadcast. Lazy-imports the heavy SDK so the worker boots fast and
 * simulate-only deploys never load it.
 *
 * Returns a transaction signature string. Jito paths prefix the bundle ID with
 * "jito:" so the settle-loop can distinguish bundle IDs from tx sigs.
 */
async function buyOnPump({ network, mint, solAmount, payer, useJito = false, jitoTipSol = 0.002, jitoBundleUrl }) {
	const { getPumpTradeClient } = await import('../../api/_lib/pump.js');
	const { client, connection, BN, web3 } = await getPumpTradeClient({ network });
	const { PublicKey, VersionedTransaction, TransactionMessage, SystemProgram } = web3;

	const user = payer.publicKey;
	const quoteAmount = new BN(Math.round(solAmount * LAMPORTS));
	const ixs = await client.buildBuyInstructions({
		mint: new PublicKey(mint),
		user,
		quoteAmount,
		slippagePct: 10,
	});

	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

	if (useJito) {
		return buyOnPumpJito({
			ixs, user, payer, blockhash, jitoTipSol, jitoBundleUrl,
			web3: { PublicKey, VersionedTransaction, TransactionMessage, SystemProgram },
		});
	}

	const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([payer]);
	const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
	// confirmTransaction can stall indefinitely under cluster congestion — race it
	// against a hard timeout so a stuck confirm never blocks the oracle agent loop.
	const CONFIRM_TIMEOUT_MS = 60_000;
	const conf = await Promise.race([
		connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`oracle tx ${sig} confirm timed out after ${CONFIRM_TIMEOUT_MS}ms`)), CONFIRM_TIMEOUT_MS)),
	]);
	// confirmTransaction resolves for a tx that landed-but-reverted; the on-chain
	// error is in value.err, not a thrown exception. Surface it so the executor
	// never records a reverted oracle execution as a confirmed one.
	if (conf?.value?.err) {
		throw new Error(`oracle tx ${sig} reverted on-chain: ${JSON.stringify(conf.value.err)}`);
	}
	return sig;
}

/**
 * Submit a single-transaction Jito bundle. Prepends a SOL tip transfer to one
 * of the rotating Jito tip accounts so the bundle gets validator priority.
 * Returns `jito:<bundleId>` — the bundle ID is stored as the "signature" in the
 * DB since Jito does not return a tx sig synchronously.
 */
async function buyOnPumpJito({ ixs, user, payer, blockhash, jitoTipSol, jitoBundleUrl, web3 }) {
	const { PublicKey, VersionedTransaction, TransactionMessage, SystemProgram } = web3;
	const bs58 = (await import('bs58')).default;

	const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
	const tipIx = SystemProgram.transfer({
		fromPubkey: user,
		toPubkey: new PublicKey(tipAccount),
		lamports: Math.round(jitoTipSol * LAMPORTS),
	});

	const msg = new TransactionMessage({
		payerKey: user,
		recentBlockhash: blockhash,
		instructions: [tipIx, ...ixs],
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([payer]);

	const url = jitoBundleUrl || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 1, method: 'sendBundle',
			params: [[bs58.encode(tx.serialize())]],
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`Jito HTTP ${res.status}`);
	const json = await res.json();
	if (json.error) throw new Error(`Jito: ${json.error.message || JSON.stringify(json.error)}`);
	const bundleId = json.result;
	log.info(`Jito bundle submitted: ${bundleId} (tip ${jitoTipSol} SOL → ${tipAccount.slice(0, 8)}…)`);
	return `jito:${bundleId}`;
}

/** Open positions + today's committed SOL for an agent — feeds the decision caps. */
export async function agentBudget(agentId, network) {
	const rows = await sql`
		select
			count(*) filter (where outcome = 'open' and status in ('filled','taken'))::int as open_count,
			coalesce(sum(size_sol) filter (where acted_at > now() - interval '24 hours' and status in ('filled','taken')), 0)::numeric as spent_today
		from oracle_watch_actions
		where agent_id = ${agentId} and network = ${network}
	`.catch(() => [{ open_count: 0, spent_today: 0 }]);
	const r = rows[0] || {};
	return { openCount: Number(r.open_count) || 0, spentTodaySol: Number(r.spent_today) || 0 };
}
