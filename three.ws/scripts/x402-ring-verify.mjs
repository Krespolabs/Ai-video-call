#!/usr/bin/env node
// scripts/x402-ring-verify.mjs
//
// Verify the three x402 ring wallets (payer / treasury / sponsor) are in a
// coherent, registered, fundable state. Read-only by default; idempotent.
//
// Checks, per role:
//   env       — the role's env vars are set (secret presence only, never printed)
//   decode    — the secret is valid base58 of a 64-byte keypair
//   pubkey    — the secret's derived pubkey equals the declared public env var
//               (treasury secret must derive X402_PAY_TO_SOLANA; sponsor secret
//               must derive X402_FEE_PAYER_SOLANA; payer has no declared pub —
//               its pubkey IS the derivation)
//   registry  — x402_ring_wallets has EXACTLY ONE enabled row for the role and
//               its pubkey matches the env-resolved one
//   balances  — live SOL + USDC (informational; RPC failure prints "?" and does
//               not fail the run)
//
// Also checks the treasury is inside payToAllowlist() — the facilitator's
// settlement gate — so no settlement can ever pay a wallet outside the ring.
//
// Exit code: 0 = every check passed, 1 = any mismatch/missing (balances exempt).
//
// Usage:
//   node scripts/x402-ring-verify.mjs            # verify only
//   node scripts/x402-ring-verify.mjs --fix      # reconcile the DB registry to
//                                                # env: upsert the env pubkey per
//                                                # role, disable stray enabled
//                                                # rows of that role
//   node scripts/x402-ring-verify.mjs --json     # machine-readable output
//
// NEVER prints a secret. NEVER moves funds. --fix touches only x402_ring_wallets
// (pubkeys + flags — the table holds no secrets by design).

import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';

import { env } from '../api/_lib/env.js';
import { solanaConnection } from '../api/_lib/solana/connection.js';

// The facilitator settlement gate. Prefer the real payToAllowlist() so this
// script can never drift from production; fall back to the identical inline
// derivation if the module fails to load (e.g. a broken spl-token install its
// top-level import pulls in) — the logic is stable and small.
async function resolvePayToAllowlist() {
	try {
		const mod = await import('../api/_lib/x402/self-facilitator.js');
		if (typeof mod.payToAllowlist === 'function') return mod.payToAllowlist();
	} catch { /* fall through to inline */ }
	const out = new Set();
	if (env.X402_PAY_TO_SOLANA) out.add(env.X402_PAY_TO_SOLANA);
	for (const a of String(process.env.X402_SELF_FACILITATOR_PAYTO_ALLOWLIST || '')
		.split(',').map((s) => s.trim()).filter(Boolean)) {
		out.add(a);
	}
	return out;
}

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

// Role → env wiring. Mirrors the production loaders exactly:
// payer: loadSeedKeypair() (api/_lib/x402/pay.js) — seed var, agent-var fallback.
// sponsor: loadFeePayerKeypair() (api/_lib/x402/self-facilitator.js).
const ROLES = [
	{
		role: 'payer',
		secretEnv: 'X402_SEED_SOLANA_SECRET_BASE58',
		secretFallbackEnv: 'X402_AGENT_SOLANA_SECRET_BASE58',
		pubEnv: null, // derived from the secret; nothing declared to compare against
	},
	{
		role: 'treasury',
		secretEnv: 'X402_TREASURY_SECRET_BASE58',
		secretFallbackEnv: null,
		pubEnv: 'X402_PAY_TO_SOLANA',
	},
	{
		role: 'sponsor',
		secretEnv: 'X402_FEE_PAYER_SECRET_BASE58',
		secretFallbackEnv: null,
		pubEnv: 'X402_FEE_PAYER_SOLANA',
	},
];

// Decode a base58 64-byte secret to its pubkey. Same strictness as the
// production loaders (64 bytes only — a 32-byte seed is rejected there too).
function derivePubkey(secretB58) {
	try {
		const raw = bs58.decode(String(secretB58).trim());
		if (raw.length !== 64) return { pubkey: null, error: `expected 64 bytes, got ${raw.length}` };
		return { pubkey: Keypair.fromSecretKey(raw).publicKey.toBase58(), error: null };
	} catch (e) {
		return { pubkey: null, error: `base58 decode failed` };
	}
}

function resolveRole(spec) {
	const out = {
		role: spec.role,
		secretVar: null, // which env var supplied the secret (name only)
		secretSet: false,
		secretDecodes: false,
		declaredPub: spec.pubEnv ? (env[spec.pubEnv] || process.env[spec.pubEnv] || null) : null,
		derivedPub: null,
		pubkeyMatch: null, // null = nothing declared to compare
		problems: [],
	};

	let secret = process.env[spec.secretEnv];
	if (secret) out.secretVar = spec.secretEnv;
	else if (spec.secretFallbackEnv && process.env[spec.secretFallbackEnv]) {
		secret = process.env[spec.secretFallbackEnv];
		out.secretVar = spec.secretFallbackEnv;
	}

	if (!secret) {
		out.problems.push(`secret unset (${spec.secretEnv}${spec.secretFallbackEnv ? ` / ${spec.secretFallbackEnv}` : ''})`);
	} else {
		out.secretSet = true;
		const { pubkey, error } = derivePubkey(secret);
		if (!pubkey) out.problems.push(`secret invalid: ${error}`);
		else {
			out.secretDecodes = true;
			out.derivedPub = pubkey;
		}
	}

	if (spec.pubEnv) {
		if (!out.declaredPub) out.problems.push(`${spec.pubEnv} unset`);
		else if (out.derivedPub) {
			out.pubkeyMatch = out.derivedPub === out.declaredPub;
			if (!out.pubkeyMatch) {
				out.problems.push(`secret derives ${out.derivedPub} but ${spec.pubEnv}=${out.declaredPub}`);
			}
		}
	}

	// The address the ring actually uses: declared pub when set, else derivation.
	out.address = out.declaredPub || out.derivedPub || null;
	return out;
}

// ── Registry (x402_ring_wallets) parity ─────────────────────────────────────
async function checkRegistry(resolved) {
	let sql;
	try {
		({ sql } = await import('../api/_lib/db.js'));
		await sql`SELECT 1`;
	} catch (e) {
		return { available: false, error: e.message, rows: [] };
	}

	const rows = await sql`SELECT pubkey, label, role, enabled FROM x402_ring_wallets`;

	if (FIX) {
		for (const r of resolved) {
			if (!r.address) continue; // can't register what env can't resolve
			await sql`
				INSERT INTO x402_ring_wallets (pubkey, label, role, enabled)
				VALUES (${r.address}, ${`ring-${r.role}`}, ${r.role}, true)
				ON CONFLICT (pubkey) DO UPDATE SET role = EXCLUDED.role, enabled = true
			`;
			await sql`
				UPDATE x402_ring_wallets SET enabled = false
				WHERE role = ${r.role} AND enabled = true AND pubkey <> ${r.address}
			`;
		}
		const after = await sql`SELECT pubkey, label, role, enabled FROM x402_ring_wallets`;
		return { available: true, rows: after, fixed: true };
	}

	return { available: true, rows };
}

function registryVerdict(r, registry) {
	if (!registry.available) return { ok: false, note: 'db unreachable' };
	if (!r.address) return { ok: false, note: 'no env pubkey to match' };
	const enabledForRole = registry.rows.filter((w) => w.role === r.role && w.enabled);
	const match = enabledForRole.find((w) => w.pubkey === r.address);
	if (!match) return { ok: false, note: `no enabled ${r.role} row for ${short(r.address)}` };
	if (enabledForRole.length > 1) {
		return { ok: false, note: `${enabledForRole.length} enabled ${r.role} rows (want exactly 1)` };
	}
	return { ok: true, note: 'exactly 1 enabled row, pubkey matches' };
}

// ── Live balances (informational — never fails the run) ─────────────────────
async function readBalances(addresses) {
	const out = new Map();
	let conn;
	try {
		conn = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	} catch {
		return out;
	}
	// spl-token is only needed for the USDC read; import it lazily so a missing
	// or broken install still lets the core verification (env/decode/registry)
	// run, with USDC degrading to "?" rather than crashing the script.
	let spl = null;
	const mintB58 = env.X402_ASSET_MINT_SOLANA || null;
	if (mintB58) {
		try {
			spl = await import('@solana/spl-token');
		} catch { /* USDC reads unavailable — SOL still reported */ }
	}
	const mint = mintB58 && spl ? new PublicKey(mintB58) : null;
	for (const addr of addresses) {
		if (!addr) continue;
		const bal = { sol: null, usdc: null };
		try {
			bal.sol = (await conn.getBalance(new PublicKey(addr), 'confirmed')) / 1e9;
		} catch { /* informational */ }
		if (mint) {
			try {
				const ata = spl.getAssociatedTokenAddressSync(
					mint, new PublicKey(addr), false, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID,
				);
				bal.usdc = Number((await spl.getAccount(conn, ata)).amount) / 1e6;
			} catch {
				bal.usdc = 0; // no ATA yet = zero balance, a real state
			}
		}
		out.set(addr, bal);
	}
	return out;
}

function short(pk) {
	return pk && pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : String(pk);
}

function fmt(n, digits) {
	return n == null ? '?' : n.toFixed(digits);
}

// ── Run ──────────────────────────────────────────────────────────────────────
const resolved = ROLES.map(resolveRole);
const registry = await checkRegistry(resolved);
const balances = await readBalances(resolved.map((r) => r.address));

// Facilitator settlement gate: the treasury must be an allowlisted payTo, or
// ring settlements to it would be refused (and any other recipient must not
// slip in via a stale allowlist entry we don't control here — report the set).
const allowlist = await resolvePayToAllowlist();
const treasury = resolved.find((r) => r.role === 'treasury');
const treasuryAllowlisted = treasury.address ? allowlist.has(treasury.address) : false;
if (treasury.address && !treasuryAllowlisted) {
	treasury.problems.push('treasury not in payToAllowlist() — settlements to it would be refused');
}

let failed = false;
const report = resolved.map((r) => {
	const reg = registryVerdict(r, registry);
	const bal = balances.get(r.address) || { sol: null, usdc: null };
	const ok = r.problems.length === 0 && reg.ok;
	if (!ok) failed = true;
	return {
		role: r.role,
		pubkey: r.address,
		secret_var: r.secretVar,
		secret_decodes: r.secretDecodes,
		pubkey_match: r.pubkeyMatch,
		registry_ok: reg.ok,
		registry_note: reg.note,
		sol: bal.sol,
		usdc: bal.usdc,
		problems: r.problems,
		ok,
	};
});

// ── Roster agents (Task 09) ────────────────────────────────────────────────────
// The custodial agent-buyer wallets (role='agent') are provisioned at runtime, not
// declared in env, so they don't gate the exit code — but they ARE inside
// ringAllowedAddresses() and every one of them must be a real controlled wallet.
// List them for the operator, with live balances, so the roster is auditable next
// to the three core roles.
const rosterRows = (registry.rows || []).filter((w) => w.role === 'agent');
const rosterBalances = await readBalances(rosterRows.map((w) => w.pubkey));
const roster = rosterRows.map((w) => {
	const bal = rosterBalances.get(w.pubkey) || { sol: null, usdc: null };
	return { pubkey: w.pubkey, label: w.label, enabled: w.enabled, sol: bal.sol, usdc: bal.usdc };
});

if (JSON_OUT) {
	console.log(JSON.stringify({
		ok: !failed,
		fixed: registry.fixed === true,
		db_available: registry.available,
		treasury_allowlisted: treasuryAllowlisted,
		allowlist_size: allowlist.size,
		wallets: report,
		roster_agents: roster,
	}, null, 2));
} else {
	console.log('\n=== three.ws x402 ring — wallet verification ===\n');
	const head = ['role', 'pubkey', 'registry', 'secret', 'SOL', 'USDC'];
	const rows = report.map((w) => [
		w.role,
		w.pubkey || '(unresolved)',
		w.registry_ok ? '✓' : '✗',
		w.secret_decodes ? (w.pubkey_match === false ? '✗ mismatch' : '✓') : '✗',
		fmt(w.sol, 4),
		fmt(w.usdc, 2),
	]);
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
	const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
	console.log(line(head));
	console.log(line(widths.map((w) => '─'.repeat(w))));
	for (const r of rows) console.log(line(r));
	console.log('');
	console.log(`  registry: ${registry.available ? (registry.fixed ? 'reconciled to env (--fix)' : 'read') : `UNREACHABLE (${registry.error})`}`);
	console.log(`  treasury in payTo allowlist: ${treasuryAllowlisted ? '✓' : '✗'} (allowlist size ${allowlist.size})`);
	if (registry.available) {
		console.log(`\n  roster agents (role='agent', inside ringAllowedAddresses): ${roster.length}`);
		for (const a of roster) {
			console.log(`    ${a.enabled ? '✓' : '·'} ${a.label || 'agent'}  ${short(a.pubkey)}  SOL ${fmt(a.sol, 4)}  USDC ${fmt(a.usdc, 2)}`);
		}
	}
	for (const w of report) {
		for (const p of w.problems) console.log(`  ✗ ${w.role}: ${p}`);
		if (!w.registry_ok) console.log(`  ✗ ${w.role}: registry — ${w.registry_note}`);
	}
	console.log(failed
		? '\n  RESULT: FAIL — fix the issues above (re-run with --fix to reconcile the DB registry to env).\n'
		: '\n  RESULT: OK — all ring wallets verified.\n');
}

process.exit(failed ? 1 : 0);
