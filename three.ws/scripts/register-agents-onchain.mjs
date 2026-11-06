#!/usr/bin/env node
/**
 * Register already-minted three.ws agents into the Metaplex Agent Registry — CLI.
 * ---------------------------------------------------------------------------
 * Minting a Core asset (scripts/deploy-agents-onchain.mjs) creates the NFT but
 * does NOT enrol the agent in Metaplex's Agent Registry. This runner back-fills
 * that step for every agent that already has a Core asset but no Agent Identity
 * PDA, via api/_lib/agent-registry.js — the same code new mints auto-run.
 *
 * The three.ws collection authority signs (it is the asset update authority), so
 * agent owners never sign and need no SOL — identical custody to the mint.
 *
 * Usage (env comes from .env via Node's --env-file):
 *   # preview which agents would be registered — no SOL, no writes:
 *   node --env-file=.env scripts/register-agents-onchain.mjs --limit 5 --dry-run
 *
 *   # real devnet run:
 *   node --env-file=.env scripts/register-agents-onchain.mjs --network devnet --limit 5 --confirm
 *
 *   # real mainnet run (spends SOL — requires --confirm):
 *   node --env-file=.env scripts/register-agents-onchain.mjs --limit 5 --confirm
 *
 * Re-runs are safe: already-registered agents are skipped automatically.
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	authoritySecret,
	buildAuthorityUmi,
	funderLamports,
	fetchUnregisteredAgents,
	registerAgentOnce,
	explorerUrl,
	EST_REGISTER_LAMPORTS,
} from '../api/_lib/onchain-deploy.js';

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
	return process.argv.includes(name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
	const network = arg('--network', 'mainnet') === 'devnet' ? 'devnet' : 'mainnet';
	const limit = Math.min(500, Math.max(1, Number(arg('--limit', '5'))));
	const dryRun = flag('--dry-run');
	const confirmed = flag('--confirm');

	console.log('\nthree.ws — Metaplex Agent Registry back-fill');
	console.log(`  network: ${network}   limit: ${limit}   ${dryRun ? 'DRY RUN' : 'LIVE'}`);

	if (!authoritySecret()) {
		console.error('\n✗ Set SOLANA_AGENT_COLLECTION_AUTHORITY_KEY (or LAUNCH_FUNDER_SECRET) in .env.');
		process.exit(1);
	}

	const { umi, authoritySigner } = buildAuthorityUmi(network);
	const authorityPk = authoritySigner.publicKey;
	const balance = await funderLamports(umi, authorityPk);
	console.log(`  authority: ${authorityPk.toString()}  (${sol(balance)} SOL)\n`);

	const agents = await fetchUnregisteredAgents(network, limit);
	console.log(`Found ${agents.length} minted agent(s) not yet in the registry on ${network}:`);
	for (const a of agents) {
		const net = network === 'mainnet' ? a.meta : a.meta?.devnet || {};
		console.log(`  • ${a.name || 'Agent'}  (${String(a.id).slice(0, 8)})  asset ${String(net.sol_mint_address || '?').slice(0, 8)}…`);
	}

	if (agents.length === 0) {
		console.log('\nNothing to do — every minted agent is already in the registry.');
		return;
	}

	if (dryRun) {
		console.log('\nDry run — no SOL spent, no writes. Re-run with --confirm to register.');
		return;
	}

	if (!confirmed) {
		console.error('\n✗ Refusing a live run without --confirm (it spends real SOL). Add --confirm to proceed.');
		process.exit(1);
	}

	let registered = 0, already = 0, errors = 0;
	for (const agent of agents) {
		const name = agent.name || 'Agent';
		const bal = await funderLamports(umi, authorityPk);
		if (bal < EST_REGISTER_LAMPORTS + 5000) {
			console.log(`\n⏸ Paused — authority low on SOL (${sol(bal)}). Top up and re-run.`);
			break;
		}
		process.stdout.write(`[${registered + already + errors + 1}/${agents.length}] ${name} … `);
		try {
			const r = await registerAgentOnce({ umi, authoritySigner, agent, network });
			if (r.alreadyRegistered) {
				already++;
				console.log(`• already registered (${r.identityPda})`);
			} else {
				registered++;
				console.log(`✓ ${r.identityPda}`);
				console.log(`        ${explorerUrl(r.identityPda, network)}`);
			}
		} catch (err) {
			errors++;
			console.log(`✗ ${err.message}`);
		}
		await sleep(400);
	}

	console.log(`\nDone — registered: ${registered}, already: ${already}, errors: ${errors}.`);
}

main().catch((err) => {
	console.error('\n✗ Fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
