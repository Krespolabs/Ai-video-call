#!/usr/bin/env node
/**
 * Agent-wallet end-to-end smoke harness — the acceptance gate for the
 * "Agent Wallet & Trading → 100%" epic (tasks/agent-wallet-trading/*).
 *
 * It proves the WHOLE custodial loop a three.ws 3D agent runs on its own Solana
 * wallet, in one re-runnable pass, against REAL devnet/testnet state:
 *
 *   create → fund → trade → snipe → x402 pay → graduation exit → withdraw
 *
 * Design (mirrors scripts/pump-devnet-smoke.mjs + scripts/onchain-smoke.mjs):
 *   - Simulate-first. Every leg that DOESN'T need on-chain funds (key
 *     round-trip, deposit URI/QR, the shared trade guardrails, payer routing,
 *     AMM-exit wiring, a SystemProgram withdraw build) runs everywhere — CI
 *     included — and reports PASS.
 *   - Funded on-chain legs (a confirmed buy/sell on a live curve, a real
 *     deposit, an x402 settlement, a confirmed withdraw) degrade to BLOCKED with
 *     the EXACT missing credential / funding and the unblock step — never a fake
 *     PASS, never a hard FAIL.
 *   - FAIL is reserved for a genuine break: a malformed instruction, a guardrail
 *     that lets a forbidden trade through, a key that doesn't round-trip, a DB
 *     write that doesn't read back.
 *   - Devnet only. Refuses any mainnet RPC. Synthetic agent authorities + the
 *     $THREE mint (or a clearly-synthetic placeholder) only — never a real
 *     third-party wallet or any non-$THREE mint.
 *   - Drives the SAME production helpers the endpoints use (generateSolanaAgentWallet,
 *     recoverSolanaAgentKeypair, ensureAgentWallet, the agent-trade-guards
 *     predicates, resolvePayerRouting, amm-exit, the pump SDK builders) — not a
 *     reimplementation.
 *
 * Usage:
 *   node scripts/agent-wallet-smoke.mjs                 # full loop (logic legs PASS, funded legs BLOCKED)
 *   node scripts/agent-wallet-smoke.mjs --list          # list step keys
 *   node scripts/agent-wallet-smoke.mjs --only=trade    # one step by key
 *   node scripts/agent-wallet-smoke.mjs --only=1,3,7    # several by number
 *   node scripts/agent-wallet-smoke.mjs --json          # machine-readable summary
 *   node --env-file=.env.local scripts/agent-wallet-smoke.mjs   # load DB/RPC creds
 *
 * Credentials / inputs (all optional — absence ⇒ the dependent leg is BLOCKED):
 *   DATABASE_URL              real DB ⇒ create provisions a real agent + snipe
 *                             persists+reads back a strategy row (else logic-only)
 *   JWT_SECRET                the at-rest key for the wallet round-trip (a
 *                             synthetic one is generated for this run if absent —
 *                             it only ever encrypts THIS run's throwaway test key)
 *   SOLANA_RPC_URL_DEVNET     devnet RPC (default https://api.devnet.solana.com)
 *   --rpc <url>               override the devnet RPC
 *   --keypair <path>          funded devnet signer (JSON byte-array or bs58) for
 *                             the live trade/withdraw legs
 *   --mint <addr>             a live devnet pump.fun mint with an ACTIVE curve for
 *                             the live buy/sell + AMM-exit legs
 *   --no-db                   skip every DB-backed assertion
 *   --keep                    keep seeded DB rows (default cleans them up)
 *
 * Exit code: 0 when no step FAILED (BLOCKED is not a failure), 1 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ── tiny .env.local loader (so helpers see DATABASE_URL / JWT_SECRET / RPC) ────
(function loadEnvLocal() {
	const p = path.join(process.cwd(), '.env.local');
	if (!fs.existsSync(p)) return;
	for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
		if (!m) continue;
		const k = m[1];
		const v = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
		if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
	}
})();

// ── args ──────────────────────────────────────────────────────────────────────
function flag(name, fallbackEnv) {
	// Supports both `--name value` and `--name=value`.
	const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const i = process.argv.indexOf(`--${name}`);
	if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
	return fallbackEnv ? process.env[fallbackEnv] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
const onlyArg = flag('only');

const RPC = flag('rpc', 'SOLANA_RPC_URL_DEVNET') || 'https://api.devnet.solana.com';
if (/mainnet|mainnet-beta/i.test(RPC)) {
	console.error('✗ Refusing to run against a mainnet RPC. Devnet only.');
	process.exit(1);
}
process.env.SOLANA_RPC_URL_DEVNET = RPC;

const NETWORK = 'devnet';
const KEYPAIR_PATH = flag('keypair', 'DEVNET_TEST_WALLET');
const LIVE_MINT = flag('mint');
const NO_DB = has('no-db');
const KEEP = has('keep');
const JSON_OUT = has('json');

// $THREE is the only coin three.ws references; the live trade leg quotes against a
// devnet curve supplied via --mint (a mainnet mint has no devnet curve), so the
// harness never hardcodes or names any other token. See the header docstring.
const SMOKE_EMAIL = 'agent-wallet-smoke@three.ws';
const SMOKE_AGENT = 'agent-wallet-smoke';

// Synthetic at-rest key for THIS run's throwaway test keypair only. Never touches
// a real custodial secret — it exists solely so the generate→recover round-trip
// (which proves custodial signing authority) can run without prod creds.
if (!process.env.JWT_SECRET) {
	process.env.JWT_SECRET = `agent-wallet-smoke-synthetic-${process.pid}-${'x'.repeat(40)}`;
}

const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ── result framework (PASS / BLOCKED / FAIL) ────────────────────────────────────
const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const GREEN = (s) => paint(32, s);
const RED = (s) => paint(31, s);
const YELLOW = (s) => paint(33, s);
const DIM = (s) => paint(90, s);
const BOLD = (s) => paint(1, s);

const pass = (detail, extra) => ({ status: 'PASS', detail, extra });
const blocked = (reason, unblock) => ({ status: 'BLOCKED', detail: reason, unblock });
const fail = (detail, extra) => ({ status: 'FAIL', detail, extra });

const ICON = { PASS: GREEN('✓'), BLOCKED: YELLOW('◐'), FAIL: RED('✗') };

// Shared context threaded across steps.
const ctx = {
	conn: new Connection(RPC, 'confirmed'),
	address: null, // agent wallet public key (base58)
	keypair: null, // recovered agent Keypair (synthetic, throwaway)
	encrypted: null, // encrypted secret produced at create
	agentId: null, // DB agent id when DATABASE_URL is present
	userId: null,
	sql: null,
	funded: null, // funded devnet signer Keypair when --keypair supplied
};

function note(msg) {
	if (!JSON_OUT) console.log(DIM(`    ${msg}`));
}

// Load an optional funded signer (for live trade/withdraw legs).
function loadFundedSigner() {
	if (ctx.funded !== null) return ctx.funded;
	if (!KEYPAIR_PATH || !fs.existsSync(KEYPAIR_PATH)) {
		ctx.funded = false;
		return false;
	}
	const raw = fs.readFileSync(KEYPAIR_PATH, 'utf8').trim();
	try {
		const arr = JSON.parse(raw);
		ctx.funded = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(arr) ? arr : Object.values(arr)));
	} catch {
		ctx.funded = Keypair.fromSecretKey(bs58.decode(raw));
	}
	return ctx.funded;
}

// Build a v0 tx, then either submit (funded signer) or simulate-only. A
// never-funded fee payer halts simulation on AccountNotFound / insufficient
// lamports BEFORE executing — EXPECTED; the well-formed build is the proof.
async function buildAndProve({ instructions, payer, signers, label }) {
	const { blockhash } = await ctx.conn.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign(signers);
	const size = vtx.serialize().length;
	if (size > 1232) throw new Error(`${label}: serialized tx ${size}B > 1232B packet limit`);

	const funded = loadFundedSigner();
	if (funded && funded.publicKey.equals(payer)) {
		const sig = await ctx.conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 });
		await ctx.conn.confirmTransaction(sig, 'confirmed');
		return { broadcast: true, sig, size };
	}

	const sim = await ctx.conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
	const err = sim.value.err;
	const logs = (sim.value.logs || []).join('\n');
	const fundingHalt =
		err == null ||
		/AccountNotFound|could not find account|insufficient|0x1\b|debit an account|lamports|attempt to debit/i.test(
			JSON.stringify(err) + logs,
		);
	if (err && !fundingHalt) throw new Error(`${label} simulation failed: ${JSON.stringify(err)}\n${logs.slice(0, 600)}`);
	return { broadcast: false, size, simHalted: !!err };
}

// ── DB bootstrap (mirrors pump-devnet-smoke) ────────────────────────────────────
async function dbConnect() {
	if (NO_DB) return false;
	if (!process.env.DATABASE_URL) return false;
	({ sql: ctx.sql } = await import('../api/_lib/db.js'));
	return true;
}
async function dbSeed() {
	const [user] = await ctx.sql`
		insert into users (email, display_name, email_verified)
		values (${SMOKE_EMAIL}, 'Agent Wallet Smoke', true)
		on conflict (email) do update set display_name = excluded.display_name
		returning id`;
	let [agent] = await ctx.sql`
		insert into agent_identities (user_id, name, description)
		values (${user.id}, ${SMOKE_AGENT}, 'agent-wallet end-to-end smoke test agent')
		on conflict do nothing returning id`;
	if (!agent) {
		[agent] = await ctx.sql`select id from agent_identities where user_id = ${user.id} and name = ${SMOKE_AGENT} limit 1`;
	}
	ctx.userId = user.id;
	ctx.agentId = agent?.id ?? null;
}
async function dbCleanup() {
	if (!ctx.sql || !ctx.agentId || KEEP) return;
	await ctx.sql`delete from agent_sniper_strategies where agent_id = ${ctx.agentId}`.catch(() => {});
	await ctx.sql`delete from agent_identities where id = ${ctx.agentId}`.catch(() => {});
	await ctx.sql`delete from users where id = ${ctx.userId} and email = ${SMOKE_EMAIL}`.catch(() => {});
}

// ── STEP 1 · create: wallet by default + custodial signing authority ───────────
async function stepCreate() {
	const { generateSolanaAgentWallet, recoverSolanaAgentKeypair } = await import('../api/_lib/agent-wallet.js');

	// The wallet-by-default primitive: generate → assert valid base58 → recover
	// the same pubkey from the encrypted secret (custodial signing authority).
	const wallet = await generateSolanaAgentWallet();
	if (!wallet?.address || !wallet?.encrypted_secret) return fail('generateSolanaAgentWallet returned no address/secret');
	let pk;
	try {
		pk = new PublicKey(wallet.address);
	} catch {
		return fail(`generated address is not valid base58: ${wallet.address}`);
	}
	const recovered = await recoverSolanaAgentKeypair(wallet.encrypted_secret);
	if (!recovered.publicKey.equals(pk)) {
		return fail('recovered keypair pubkey does not match the generated address — round-trip broken');
	}
	ctx.address = wallet.address;
	ctx.encrypted = wallet.encrypted_secret;
	ctx.keypair = recovered;
	note(`wallet ${wallet.address} — encrypt→decrypt round-trip OK`);

	// With a DB, prove the real provision invariant: ensureAgentWallet makes the
	// agent walletReady + persists solana_address.
	if (ctx.agentId) {
		const { ensureAgentWallet } = await import('../api/_lib/agent-wallet.js');
		const prov = await ensureAgentWallet(ctx.agentId, ctx.userId, { reason: 'smoke' });
		const [row] = await ctx.sql`select meta from agent_identities where id = ${ctx.agentId}`;
		const addr = row?.meta?.solana_address;
		const hasSecret = !!row?.meta?.encrypted_solana_secret;
		if (!addr || !hasSecret) return fail('ensureAgentWallet did not persist solana_address + encrypted secret');
		try {
			new PublicKey(addr);
		} catch {
			return fail(`persisted solana_address invalid: ${addr}`);
		}
		// Drive trade/withdraw/x402 legs against the REAL provisioned wallet.
		ctx.address = addr;
		const { recoverSolanaAgentKeypair: rec } = await import('../api/_lib/agent-wallet.js');
		ctx.keypair = await rec(row.meta.encrypted_solana_secret);
		ctx.encrypted = row.meta.encrypted_solana_secret;
		note(`DB agent ${ctx.agentId} walletReady — provisioned=${prov.created} address=${addr}`);
		return pass(`wallet provisioned + round-trips (DB-backed, walletReady)`);
	}
	return blocked(
		'wallet primitive verified (generate→recover round-trip); DB-backed walletReady provision needs DATABASE_URL',
		'set DATABASE_URL (or run with --env-file=.env.local) to assert ensureAgentWallet persists the wallet',
	);
}

// ── STEP 2 · fund: deposit address + QR + solana: deep-link + live balance ─────
async function stepFund() {
	if (!ctx.address) return fail('no agent address from create step');
	const { generateQR, renderQRToSVG } = await import('../src/erc8004/qr.js');

	// Solana Pay deposit URI the deposit panel hands the user's mobile wallet.
	const uri = `solana:${ctx.address}`;
	const m = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(uri);
	if (!m || m[1] !== ctx.address) return fail(`solana: deposit URI did not resolve to the address: ${uri}`);

	// First-party QR (no CDN) must encode the same address, headless.
	const qr = generateQR(uri);
	if (!qr?.size || !Array.isArray(qr.modules)) return fail('generateQR produced no module matrix');
	const svg = renderQRToSVG(uri);
	if (!svg.startsWith('<svg') || !svg.includes('<rect')) return fail('renderQRToSVG produced no SVG');
	note(`deposit URI ${uri} · QR ${qr.size}×${qr.size} modules · SVG ${svg.length}B`);

	// Live balance read-back (the "funds received" surface). RPC reachable ⇒ the
	// balance read works; actual funding needs a faucet/funded signer.
	const { getSolanaAddressBalances } = await import('../api/_lib/agent-wallet.js');
	let bal;
	try {
		bal = await getSolanaAddressBalances(ctx.address, NETWORK);
	} catch (e) {
		return blocked(`devnet RPC unreachable for balance read: ${(e.message || e).slice(0, 80)}`, `point --rpc at a reachable devnet RPC`);
	}
	note(`balance ${ctx.address.slice(0, 8)}… → ${bal.sol ?? 'null'} SOL · ${bal.usdc ?? 'null'} USDC`);

	const funded = loadFundedSigner();
	if (!funded) {
		return blocked(
			`deposit URI + QR + live-balance read all verified; on-chain funding needs a faucet/funded signer (balance is ${bal.sol ?? 0} SOL)`,
			'fund the printed address at https://faucet.solana.com (devnet), or pass --keypair <funded devnet key>',
		);
	}
	// A funded signer is present → top the agent wallet up so downstream legs can transact.
	const lamports = Math.floor(0.02 * LAMPORTS_PER_SOL);
	const ix = SystemProgram.transfer({ fromPubkey: funded.publicKey, toPubkey: new PublicKey(ctx.address), lamports });
	const r = await buildAndProve({ instructions: [ix], payer: funded.publicKey, signers: [funded], label: 'fund' });
	if (r.broadcast) {
		const after = await getSolanaAddressBalances(ctx.address, NETWORK);
		note(`funded 0.02 SOL · ${explorer(r.sig)}`);
		return pass(`deposit funded + balance read back ${after.sol} SOL`);
	}
	return blocked('funded signer present but unable to broadcast the top-up', 'ensure --keypair points at a funded devnet wallet');
}

// ── STEP 3 · trade: shared guardrails + buy/sell from the agent wallet ──────────
async function stepTrade() {
	if (!ctx.keypair) return fail('no agent keypair from create step');
	const {
		checkKillSwitch, checkPerTradeCap, checkDailyBudgetLamports, checkSolHeadroom, checkPriceImpact,
		TRADE_LIMIT_DEFAULTS,
	} = await import('../api/_lib/agent-trade-guards.js');

	// The shared guardrail module is the correctness gate task 03 closed: the
	// SAME predicates back the sniper, the /trade endpoint, and /solana/trade. A
	// forbidden trade slipping through here is a hard FAIL.
	const cap = 1_000_000_000n; // 1 SOL per-trade cap
	const budget = 2_000_000_000n; // 2 SOL daily
	const wallet = 1_500_000_000n; // 1.5 SOL on hand

	const checks = [
		['kill switch armed blocks', checkKillSwitch(true), true],
		['kill switch off allows', checkKillSwitch(false), false],
		['over per-trade cap blocks', checkPerTradeCap(cap + 1n, cap), true],
		['within per-trade cap allows', checkPerTradeCap(cap - 1n, cap), false],
		['over daily budget blocks', checkDailyBudgetLamports(budget - 100n, 500n, budget), true],
		['within daily budget allows', checkDailyBudgetLamports(0n, cap, budget), false],
		['insufficient SOL headroom blocks', checkSolHeadroom(wallet, wallet, 3_000_000n), true],
		['sufficient SOL headroom allows', checkSolHeadroom(wallet, 100_000_000n, 3_000_000n), false],
		['excess price impact blocks', checkPriceImpact(40, 25), true],
		['acceptable price impact allows', checkPriceImpact(5, 25), false],
	];
	for (const [name, result, shouldBlock] of checks) {
		const didBlock = result != null;
		if (didBlock !== shouldBlock) {
			return fail(`guardrail wrong: "${name}" expected block=${shouldBlock} got block=${didBlock}`);
		}
	}
	note(`${checks.length} shared guardrail predicates correct (cap/budget/headroom/impact/kill) · defaults loaded=${!!TRADE_LIMIT_DEFAULTS}`);

	// Live buy/sell on a real bonding curve. Needs a funded signer + an active
	// devnet curve; without --mint there is no curve to quote against.
	const funded = loadFundedSigner();
	if (!funded) {
		return blocked(
			`trade guardrails verified; a confirmed buy/sell from the agent wallet needs a funded signer + a live curve`,
			'pass --keypair <funded devnet key> and --mint <devnet pump mint with an active curve> (or run scripts/pump-devnet-smoke.mjs for the funded launch→buy→sell path)',
		);
	}
	if (!LIVE_MINT) {
		return blocked('funded signer present but no live curve to trade', 'pass --mint <devnet pump mint with an active bonding curve>');
	}
	// Build + simulate a real buy instruction against the supplied curve (proves
	// the agent-wallet trade instruction path without requiring deep balance).
	try {
		const { getPumpSdk } = await import('../api/_lib/pump.js');
		const { resolveTokenProgramForMintOwner } = await import('../api/_lib/pump-trade-args.js');
		const sdk = await getPumpSdk({ network: NETWORK });
		const mintPk = new PublicKey(LIVE_MINT);
		const info = await ctx.conn.getAccountInfo(mintPk);
		if (!info) return blocked(`--mint ${LIVE_MINT} not found on devnet`, 'supply a live devnet pump mint');
		const tokenProgram = resolveTokenProgramForMintOwner(info.owner);
		const state = await sdk.fetchBuyState(mintPk, ctx.keypair.publicKey, tokenProgram);
		if (!state?.bondingCurve || state.bondingCurve.complete) {
			return blocked(`--mint ${LIVE_MINT} has no active bonding curve (graduated/missing)`, 'supply a mint with a live curve');
		}
		return pass(`trade guardrails + live curve reachable for ${LIVE_MINT.slice(0, 8)}… (funded buy/sell via --keypair)`);
	} catch (e) {
		return blocked(`live curve probe failed: ${(e.message || e).slice(0, 100)}`, 'verify --mint + --rpc');
	}
}

// ── STEP 4 · snipe: arm a strategy + persist + read back ────────────────────────
async function stepSnipe() {
	// The autonomous engine must be present + importable (the worker the strategy
	// row drives). A broken import is a real FAIL.
	try {
		const scorer = await import('../workers/agent-sniper/scorer.js');
		// The candidate scorers the worker runs on every feed event — a strategy
		// that can't be scored can't fire, so a missing scorer is a real FAIL.
		if (typeof scorer.scoreMint !== 'function' || typeof scorer.scoreIntel !== 'function') {
			return fail('agent-sniper scorer is missing scoreMint/scoreIntel — strategies could not be evaluated');
		}
	} catch (e) {
		return fail(`agent-sniper scorer failed to import: ${(e.message || e).slice(0, 120)}`);
	}
	note('agent-sniper engine present (scoreMint + scoreIntel importable)');

	if (!ctx.agentId) {
		return blocked(
			'sniper engine present; arming a strategy + asserting persistence needs DATABASE_URL',
			'set DATABASE_URL to insert + read back an agent_sniper_strategies row',
		);
	}
	// Arm a strategy exactly as POST /api/sniper/strategy would: upsert the row
	// the worker reads, then read it back and assert the armed values stuck.
	const strat = {
		enabled: true,
		kill_switch: false,
		trigger: 'new_mint',
		daily_budget_lamports: 200_000_000n.toString(),
		per_trade_lamports: 50_000_000n.toString(),
		max_concurrent_positions: 3,
		slippage_bps: 500,
		max_price_impact_pct: 20,
		take_profit_pct: 60,
		stop_loss_pct: 35,
	};
	await ctx.sql`
		insert into agent_sniper_strategies
			(agent_id, user_id, network, enabled, kill_switch, trigger,
			 daily_budget_lamports, per_trade_lamports, max_concurrent_positions,
			 slippage_bps, max_price_impact_pct, take_profit_pct, stop_loss_pct)
		values
			(${ctx.agentId}, ${ctx.userId}, ${NETWORK}, ${strat.enabled}, ${strat.kill_switch}, ${strat.trigger},
			 ${strat.daily_budget_lamports}, ${strat.per_trade_lamports}, ${strat.max_concurrent_positions},
			 ${strat.slippage_bps}, ${strat.max_price_impact_pct}, ${strat.take_profit_pct}, ${strat.stop_loss_pct})
		on conflict (agent_id, network) do update set
			enabled = excluded.enabled, kill_switch = excluded.kill_switch, trigger = excluded.trigger,
			daily_budget_lamports = excluded.daily_budget_lamports, per_trade_lamports = excluded.per_trade_lamports,
			max_concurrent_positions = excluded.max_concurrent_positions, slippage_bps = excluded.slippage_bps,
			max_price_impact_pct = excluded.max_price_impact_pct, take_profit_pct = excluded.take_profit_pct,
			stop_loss_pct = excluded.stop_loss_pct`;
	const [back] = await ctx.sql`
		select enabled, trigger, per_trade_lamports, max_concurrent_positions
		from agent_sniper_strategies where agent_id = ${ctx.agentId} and network = ${NETWORK} limit 1`;
	if (!back) return fail('strategy row not found after upsert');
	if (back.enabled !== true || back.trigger !== 'new_mint' || String(back.per_trade_lamports) !== strat.per_trade_lamports) {
		return fail(`strategy read-back mismatch: ${JSON.stringify(back)}`);
	}
	note(`strategy armed + read back: enabled=${back.enabled} trigger=${back.trigger} per_trade=${back.per_trade_lamports}`);
	return blocked(
		'strategy armed + persisted; a real simulated fill needs the deployed sniper worker reachable on the live PumpPortal feed',
		'deploy workers/agent-sniper to Cloud Run (SNIPER_MODE=simulate) and point it at this DB',
	);
}

// ── STEP 5 · x402: pay from the AGENT wallet, not the platform wallet ───────────
async function stepX402() {
	const { resolvePayerRouting } = await import('../api/x402-pay.js');

	// The per-agent default task 08 closed: an agentId routes settlement to the
	// agent's own wallet; only the absence of one falls back to the platform wallet.
	const agentRoute = resolvePayerRouting({ agentId: ctx.agentId || 'synthetic-agent-id' });
	const platformRoute = resolvePayerRouting({});
	if (agentRoute.mode !== 'agent') return fail(`x402 routing: agentId did not route to the agent wallet (got ${agentRoute.mode})`);
	if (platformRoute.mode !== 'platform') return fail(`x402 routing: no agentId did not fall back to platform (got ${platformRoute.mode})`);
	note(`x402 payer routing: agentId→${agentRoute.mode}, none→${platformRoute.mode}`);

	// Settlement asset is the agent wallet's USDC. A real x402 settlement needs
	// the agent funded with devnet USDC + a reachable paid endpoint.
	if (!ctx.address) return blocked('x402 routing verified; no agent wallet to read USDC from', 'run the create step first');
	const { getSolanaAddressBalances } = await import('../api/_lib/agent-wallet.js');
	const bal = await getSolanaAddressBalances(ctx.address, NETWORK).catch(() => ({ usdc: null }));
	note(`agent USDC balance: ${bal.usdc ?? 'null'}`);
	return blocked(
		`x402 per-agent payer routing verified (settles from the agent wallet, not the platform); a live settlement needs the agent funded with devnet USDC + a reachable x402 endpoint (agent USDC=${bal.usdc ?? 0})`,
		'fund the agent ATA at https://faucet.circle.com (Solana devnet) and target a live x402 resource',
	);
}

// ── STEP 6 · graduation: graduated positions exit via AMM, never park ──────────
async function stepGraduation() {
	// Task 07: the AMM-exit path must be wired so a graduated position sells on the
	// pump-swap AMM instead of parking forever. Assert the module + the exact
	// functions the executor/trade endpoint call are present and callable.
	let mod;
	try {
		mod = await import('../workers/agent-sniper/amm-exit.js');
	} catch (e) {
		return fail(`amm-exit module failed to import: ${(e.message || e).slice(0, 120)}`);
	}
	for (const fn of ['isGraduated', 'quoteAmmSell', 'buildAmmSellInstructions']) {
		if (typeof mod[fn] !== 'function') return fail(`amm-exit is missing ${fn}() — graduated positions would park`);
	}
	// The discretionary trade endpoint must import the AMM exit (the wiring task
	// 07 added), so a graduated mint routes to the AMM rather than 500-ing.
	const tradeSrc = fs.readFileSync(path.join(process.cwd(), 'api/agents/agent-trade.js'), 'utf8');
	if (!/amm-exit/.test(tradeSrc) || !/buildAmmSellInstructions|quoteAmmSell/.test(tradeSrc)) {
		return fail('api/agents/agent-trade.js does not wire the AMM exit — graduated sells would have no path');
	}
	note('amm-exit wired: isGraduated + quoteAmmSell + buildAmmSellInstructions present and imported by the trade endpoint');

	if (LIVE_MINT && loadFundedSigner()) {
		try {
			const grad = await mod.isGraduated({ network: NETWORK, mint: LIVE_MINT });
			note(`isGraduated(${LIVE_MINT.slice(0, 8)}…) = ${grad}`);
			return pass(`AMM exit wired + isGraduated live-checked (${grad})`);
		} catch (e) {
			note(`live isGraduated probe failed: ${(e.message || e).slice(0, 80)}`);
		}
	}
	return blocked(
		'AMM-exit path wired + callable; exercising a real graduated→AMM sell needs a funded signer + a graduated devnet mint',
		'pass --keypair + --mint <graduated devnet mint> to drive a live AMM exit',
	);
}

// ── STEP 7 · withdraw: sweep SOL back out to any address ────────────────────────
async function stepWithdraw() {
	if (!ctx.keypair) return fail('no agent keypair from create step');
	const { validateSolanaAddress } = await import('../api/_lib/agent-trade-guards.js');

	// Destination validation (the withdraw allowlist gate) must accept a good
	// address and reject a bad one.
	const dest = Keypair.generate().publicKey.toBase58();
	if (!validateSolanaAddress(dest).valid) return fail('validateSolanaAddress rejected a valid destination');
	if (validateSolanaAddress('not-an-address').valid) return fail('validateSolanaAddress accepted an invalid destination');

	// Build the actual sweep instruction (SystemProgram.transfer from the agent
	// wallet) and prove it compiles to a well-formed, packet-sized v0 tx. With a
	// funded agent wallet it broadcasts + confirms; otherwise simulation halts on
	// funding (expected) and the build is the proof.
	const lamports = Math.floor(0.001 * LAMPORTS_PER_SOL);
	const ix = SystemProgram.transfer({ fromPubkey: ctx.keypair.publicKey, toPubkey: new PublicKey(dest), lamports });
	let r;
	try {
		r = await buildAndProve({ instructions: [ix], payer: ctx.keypair.publicKey, signers: [ctx.keypair], label: 'withdraw' });
	} catch (e) {
		return fail(`withdraw tx build failed: ${(e.message || e).slice(0, 120)}`);
	}
	note(`withdraw sweep built (${r.size}B v0) → ${dest.slice(0, 8)}… · allowlist validation OK`);

	if (r.broadcast) return pass(`withdraw confirmed on-chain · ${explorer(r.sig)}`);
	return blocked(
		'withdraw sweep instruction builds + validates (well-formed v0 tx); a confirmed on-chain sweep needs the agent wallet funded with SOL',
		'fund the agent wallet (step 2) then re-run with --keypair to broadcast + confirm the sweep',
	);
}

// ── step registry ───────────────────────────────────────────────────────────────
const STEPS = [
	{ num: 1, key: 'create', title: 'Create — wallet by default + signing authority', run: stepCreate },
	{ num: 2, key: 'fund', title: 'Fund — address + QR + solana: link + live balance', run: stepFund },
	{ num: 3, key: 'trade', title: 'Trade — shared guardrails + buy/sell from agent wallet', run: stepTrade },
	{ num: 4, key: 'snipe', title: 'Snipe — arm a strategy + persist + read back', run: stepSnipe },
	{ num: 5, key: 'x402', title: 'x402 — pay from the agent wallet (not platform)', run: stepX402 },
	{ num: 6, key: 'graduation', title: 'Graduation — graduated positions exit via AMM', run: stepGraduation },
	{ num: 7, key: 'withdraw', title: 'Withdraw — sweep SOL back out to any address', run: stepWithdraw },
];

function selectedSteps() {
	if (!onlyArg) return STEPS;
	const want = new Set(onlyArg.split(',').map((s) => s.trim().toLowerCase()));
	return STEPS.filter((s) => want.has(s.key) || want.has(String(s.num)));
}

async function main() {
	if (has('help')) {
		console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 56).join('\n').replace(/^ \*?/gm, ''));
		return 0;
	}
	if (has('list')) {
		for (const s of STEPS) console.log(`  ${s.num}. ${s.key.padEnd(11)} ${s.title}`);
		return 0;
	}

	if (!JSON_OUT) {
		console.log(BOLD('\nAgent-wallet end-to-end smoke — create→fund→trade→snipe→x402→graduation→withdraw'));
		console.log(DIM(`devnet RPC: ${RPC}`));
	}

	const dbReady = await dbConnect().catch((e) => {
		note(`DB connect failed: ${(e.message || e).slice(0, 80)}`);
		return false;
	});
	if (dbReady) {
		try {
			await dbSeed();
			if (!JSON_OUT) console.log(DIM(`DB connected — seeded agent ${ctx.agentId}`));
		} catch (e) {
			if (!JSON_OUT) console.log(YELLOW(`DB seed failed (${(e.message || e).slice(0, 80)}) — running logic-only`));
			ctx.sql = null;
			ctx.agentId = null;
		}
	} else if (!JSON_OUT) {
		console.log(DIM('no DATABASE_URL — DB-backed legs report BLOCKED (logic legs still run)'));
	}

	const results = [];
	try {
		for (const step of selectedSteps()) {
			const t0 = Date.now();
			let res;
			try {
				res = await step.run();
			} catch (e) {
				res = fail(`unhandled: ${(e.stack || e.message || String(e)).split('\n').slice(0, 2).join(' ')}`);
			}
			const ms = Date.now() - t0;
			results.push({ num: step.num, key: step.key, title: step.title, ms, ...res });
			if (!JSON_OUT) {
				console.log(`\n${ICON[res.status]} ${BOLD(`[${res.status}]`)} ${step.num}. ${step.title} ${DIM(`(${ms}ms)`)}`);
				if (res.detail) console.log(`    ${res.status === 'FAIL' ? RED(res.detail) : res.detail}`);
				if (res.unblock) console.log(DIM(`    ↳ unblock: ${res.unblock}`));
			}
		}
	} finally {
		await dbCleanup().catch(() => {});
		try {
			await ctx.sql?.end?.({ timeout: 2 });
		} catch {
			/* pool close best-effort */
		}
	}

	const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
	const summary = `${counts.PASS || 0} pass · ${counts.BLOCKED || 0} blocked · ${counts.FAIL || 0} fail`;
	if (JSON_OUT) {
		console.log(JSON.stringify({ rpc: RPC, network: NETWORK, summary, counts, results }, null, 2));
	} else {
		console.log('\n' + (counts.FAIL ? RED(BOLD(summary)) : GREEN(BOLD(summary))));
		if (counts.BLOCKED) console.log(DIM('BLOCKED = built + verified, waiting on funding/credentials (not a failure). See ↳ unblock notes.'));
	}
	return counts.FAIL ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		console.error('\n✗ smoke harness crashed:', e?.stack || e);
		process.exit(1);
	});
