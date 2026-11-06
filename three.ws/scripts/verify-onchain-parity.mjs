#!/usr/bin/env node
/**
 * ERC-8004 registry address-parity + on-chain provenance guard.
 *
 * The same registry addresses are hand-duplicated across three sources that can
 * silently drift apart:
 *
 *   1. src/erc8004/abi.js        — REGISTRY_DEPLOYMENTS (browser/client)
 *   2. sdk/src/erc8004/abi.js    — REGISTRY_DEPLOYMENTS (published SDK)
 *   3. api/_lib/erc8004-chains.js — CHAINS[].registry (serverless crawler;
 *      carries the IdentityRegistry address only)
 *
 * A drift here is never benign: a stale address sends registrations, reputation,
 * or validation writes to the wrong (or zero) contract. This guard asserts the
 * three agree and that the addresses actually host bytecode on-chain.
 *
 * Two failure classes, two severities:
 *   - Address mismatch / drift trap — ALWAYS a real config bug → hard fail (exit 1).
 *   - Live bytecode — empty code at a declared address is a hard fail, but a
 *     network error reaching the RPC degrades to a warning so CI without egress
 *     (or a flaky public RPC) never blocks a deploy on transport noise.
 *
 * Runs standalone (`npm run verify:onchain`), in scripts/build-vercel.mjs phase 1
 * alongside audit-deploy-artifacts.mjs, and via tests/onchain-parity.test.js.
 *
 * Live-bytecode chain subset is configurable:
 *   VERIFY_ONCHAIN_CHAINS=8453,84532   (default — Base mainnet + Base Sepolia)
 *   VERIFY_ONCHAIN_CHAINS=all          (sweep every known chain)
 *   VERIFY_ONCHAIN_CHAINS=none         (skip the live check entirely)
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KINDS = ['identityRegistry', 'reputationRegistry', 'validationRegistry'];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** A value counts as a real address only if it is a well-formed 0x40-hex string. */
function normalizeAddr(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return ADDR_RE.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Load the three sources
// ---------------------------------------------------------------------------

/**
 * Imports REGISTRY_DEPLOYMENTS from src/ and sdk/, and derives an equivalent
 * per-chain map from the api/ CHAINS array (which carries the IdentityRegistry
 * address only). Returns { sources, chains } where sources is keyed by label.
 */
export async function loadSources({ root = ROOT } = {}) {
	const imp = async (rel) => import(pathToFileURL(resolve(root, rel)).href);

	// The SDK source ships as a separate package and is excluded from the Vercel
	// deploy bundle (`sdk` is in .vercelignore). When the file is absent we drop
	// it from the comparison with a warning rather than hard-failing the build —
	// the same degrade-don't-block stance the live RPC check takes. The full
	// three-way parity still runs in local/CI and tests/onchain-parity.test.js,
	// where the SDK source is present, so drift can never slip through unseen.
	const impOptional = async (rel) => {
		try {
			return await imp(rel);
		} catch (err) {
			if (err?.code === 'ERR_MODULE_NOT_FOUND') {
				console.warn(`[verify:onchain] skip ${rel} — not present in this build context`);
				return null;
			}
			throw err;
		}
	};

	const [srcMod, sdkMod, apiMod] = await Promise.all([
		imp('src/erc8004/abi.js'),
		impOptional('sdk/src/erc8004/abi.js'),
		imp('api/_lib/erc8004-chains.js'),
	]);

	const apiDeployments = {};
	for (const c of apiMod.CHAINS) {
		// The api source only knows the IdentityRegistry per chain. Leaving the
		// other kinds absent (not null-equal) means the parity check compares
		// them across src/sdk only and never treats api silence as a drift.
		apiDeployments[c.id] = { identityRegistry: c.registry };
	}

	const sources = {
		'src/erc8004/abi.js': srcMod.REGISTRY_DEPLOYMENTS,
		'api/_lib/erc8004-chains.js': apiDeployments,
	};
	// Only compare the SDK source when it is actually present in this context.
	if (sdkMod) sources['sdk/src/erc8004/abi.js'] = sdkMod.REGISTRY_DEPLOYMENTS;

	// CHAINS also feeds the live-bytecode check its RPC endpoints.
	return { sources, chains: apiMod.CHAINS };
}

// ---------------------------------------------------------------------------
// Parity check (deterministic — always runs, always hard-fails on mismatch)
// ---------------------------------------------------------------------------

/**
 * Cross-checks the three sources. Returns { problems, merged } where problems is
 * an array of precise mismatch descriptors and merged is the canonical
 * { chainId: { kind: address } } map (real addresses only) for the live check.
 *
 * Three problem classes, all hard failures:
 *   - chain-set   : a chainId present in one source is missing from another.
 *   - mismatch    : two sources declare different real addresses for a slot.
 *   - drift-trap  : one source has a real address, another has it null/empty
 *                   for the SAME (chain, kind) — the ValidationRegistry trap.
 */
export function checkParity(sources) {
	const labels = Object.keys(sources);
	const problems = [];

	// --- chain-set parity --------------------------------------------------
	const chainSets = labels.map((l) => new Set(Object.keys(sources[l]).map(Number)));
	const allChains = new Set(chainSets.flatMap((s) => [...s]));
	for (const chainId of [...allChains].sort((a, b) => a - b)) {
		const missingIn = labels.filter((l, i) => !chainSets[i].has(chainId));
		if (missingIn.length) {
			problems.push({
				type: 'chain-set',
				chainId,
				detail: `chain ${chainId} present in [${labels
					.filter((l, i) => chainSets[i].has(chainId))
					.join(', ')}] but missing in [${missingIn.join(', ')}]`,
			});
		}
	}

	// --- per-(chain, kind) address parity ---------------------------------
	const merged = {};
	for (const chainId of [...allChains].sort((a, b) => a - b)) {
		merged[chainId] = {};
		for (const kind of KINDS) {
			// Collect what each source says for this slot. A source that omits the
			// kind entirely (the api source for reputation/validation) is recorded
			// as `undefined` and excluded from the comparison — silence is not drift.
			const declared = [];
			for (const label of labels) {
				const entry = sources[label][chainId];
				if (!entry || !(kind in entry)) continue; // kind not carried by this source
				declared.push({ label, raw: entry[kind], addr: normalizeAddr(entry[kind]) });
			}
			if (!declared.length) continue;

			const real = declared.filter((d) => d.addr);
			const absent = declared.filter((d) => !d.addr);

			// drift trap: some sources have a real address, others null/empty.
			if (real.length && absent.length) {
				problems.push({
					type: 'drift-trap',
					chainId,
					kind,
					detail: `${kind} on chain ${chainId}: ${real
						.map((d) => `${d.label}=${d.addr}`)
						.join(', ')} vs absent in ${absent.map((d) => `${d.label}=${JSON.stringify(d.raw)}`).join(', ')}`,
				});
			}

			// mismatch: real addresses that disagree (case-insensitive — checksum
			// casing differences are not drift, a different address is).
			const distinct = [...new Set(real.map((d) => d.addr.toLowerCase()))];
			if (distinct.length > 1) {
				problems.push({
					type: 'mismatch',
					chainId,
					kind,
					detail: `${kind} on chain ${chainId}: ${real.map((d) => `${d.label}=${d.addr}`).join(', ')}`,
				});
			}

			if (real.length) merged[chainId][kind] = real[0].addr;
		}
	}

	return { problems, merged };
}

// ---------------------------------------------------------------------------
// Live bytecode check (best-effort — warns on transport error, fails on
// confirmed-empty code at a declared address)
// ---------------------------------------------------------------------------

async function ethGetCode(rpcUrls, address) {
	let lastError;
	for (const url of rpcUrls) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'eth_getCode',
					params: [address, 'latest'],
				}),
				signal: AbortSignal.timeout(12_000),
			});
			if (!res.ok) {
				lastError = new Error(`HTTP ${res.status}`);
				continue;
			}
			const json = await res.json();
			if (json.error) {
				lastError = new Error(json.error.message || 'rpc error');
				continue;
			}
			// Success: a definitive on-chain answer. "0x" / "0x0" means no code.
			const code = typeof json.result === 'string' ? json.result : '0x';
			return { ok: true, hasCode: code !== '0x' && code !== '0x0' && code.length > 2 };
		} catch (err) {
			lastError = err;
		}
	}
	return { ok: false, error: lastError?.message || 'all RPCs unreachable' };
}

/** Parse VERIFY_ONCHAIN_CHAINS into the set of chainIds to probe. */
export function resolveLiveChains(env, allChainIds) {
	const raw = (env.VERIFY_ONCHAIN_CHAINS || '8453,84532').trim().toLowerCase();
	if (raw === 'none') return [];
	if (raw === 'all') return [...allChainIds];
	return raw
		.split(',')
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n));
}

/**
 * For the configured chain subset, eth_getCode every declared (non-null) address
 * and classify each as live / empty / unreachable. Empty is a hard failure;
 * unreachable is a warning.
 */
export async function checkLiveBytecode({ merged, chains, chainIds }) {
	const rpcByChain = Object.fromEntries(chains.map((c) => [c.id, c.rpcUrls]));
	const nameByChain = Object.fromEntries(chains.map((c) => [c.id, c.name]));
	const empty = [];
	const unreachable = [];
	const live = [];

	for (const chainId of chainIds) {
		const slots = merged[chainId];
		const rpcUrls = rpcByChain[chainId];
		if (!slots || !rpcUrls) continue;
		for (const kind of KINDS) {
			const addr = slots[kind];
			if (!addr) continue;
			const result = await ethGetCode(rpcUrls, addr);
			const ctx = { chainId, name: nameByChain[chainId], kind, address: addr };
			if (!result.ok) unreachable.push({ ...ctx, error: result.error });
			else if (!result.hasCode) empty.push(ctx);
			else live.push(ctx);
		}
	}
	return { empty, unreachable, live };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const start = Date.now();
	const sweep = process.argv.includes('--sweep'); // print full live matrix
	if (sweep) process.env.VERIFY_ONCHAIN_CHAINS = 'all';

	const { sources, chains } = await loadSources();
	const { problems, merged } = checkParity(sources);

	let failed = false;

	if (problems.length) {
		failed = true;
		console.error(`[verify:onchain] FAIL — ${problems.length} address-parity problem(s):`);
		for (const p of problems) console.error(`  [${p.type}] ${p.detail}`);
	} else {
		const slotCount = Object.values(merged).reduce((n, s) => n + Object.keys(s).length, 0);
		console.log(
			`[verify:onchain] parity OK — ${Object.keys(sources).length} sources agree across ${Object.keys(merged).length} chains / ${slotCount} address slots`,
		);
	}

	const allChainIds = chains.map((c) => c.id);
	const liveChainIds = resolveLiveChains(process.env, allChainIds);
	if (liveChainIds.length) {
		const { empty, unreachable, live } = await checkLiveBytecode({ merged, chains, chainIds: liveChainIds });

		for (const e of live) {
			console.log(`[verify:onchain] live  ${e.name} (${e.chainId}) ${e.kind} ${e.address}`);
		}
		if (unreachable.length) {
			console.warn(`[verify:onchain] WARN — ${unreachable.length} address(es) unreachable (network — not failing the build):`);
			for (const u of unreachable) console.warn(`  ${u.name} (${u.chainId}) ${u.kind} ${u.address} — ${u.error}`);
		}
		if (empty.length) {
			failed = true;
			console.error(`[verify:onchain] FAIL — ${empty.length} declared address(es) have NO bytecode on-chain:`);
			for (const e of empty) console.error(`  ${e.name} (${e.chainId}) ${e.kind} ${e.address} — eth_getCode returned 0x`);
		}
		console.log(
			`[verify:onchain] live check — ${live.length} live, ${empty.length} empty, ${unreachable.length} unreachable across ${liveChainIds.length} chain(s)`,
		);
	} else {
		console.log('[verify:onchain] live bytecode check skipped (VERIFY_ONCHAIN_CHAINS=none)');
	}

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	if (failed) {
		console.error(`\n[verify:onchain] failed in ${elapsed}s`);
		process.exit(1);
	}
	console.log(`[verify:onchain] clean in ${elapsed}s`);
}
