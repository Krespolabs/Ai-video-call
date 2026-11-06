#!/usr/bin/env node
/**
 * pump-launch-repos — CLI over scripts/lib/pump-launch-core.mjs.
 *
 * Launch one pump.fun coin per public GitHub repo of a target user, with 100% of
 * creator rewards delegated to that user's GitHub identity (pump.fun social-fee
 * escrow). One master wallet funds N throwaway repo wallets; each repo wallet is
 * the on-chain creator of its coin. Every private key lives only under
 * .pump-launch-wallets/ (gitignored) and is bundled into pump-launch-wallets.zip.
 *
 * Prefer the visual control panel for most work:  npm run pump:launch:ui
 *
 * Commands:  generate | status | verify | preflight | run
 * Key flags: --network mainnet|devnet  --rpc <url>  --github-user <login>
 *            --github-id <id>  --dev-buy <sol>  --fund-per-wallet <sol>
 *            --only <repo>  --limit <n>  --yes
 */

import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import {
	makeConfig,
	resolveGithubUser,
	fetchRepos,
	generate,
	loadState,
	loadJson,
	runLaunch,
	verifyOwnership,
	estimateCost,
	masterPubkey,
	masterBalanceLamports,
	makeConnection,
	makeSdk,
	uploadMetadata,
	buildCreateIxs,
	sol,
	explorerTx,
	ROOT,
} from './lib/pump-launch-core.mjs';
import { feeSharingConfigPda, canonicalPumpPoolPda } from '@pump-fun/pump-sdk';
import { PublicKey } from '@solana/web3.js';
import { join } from 'node:path';

function parseArgs(argv) {
	const a = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const t = argv[i];
		if (t.startsWith('--')) {
			const key = t.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) a[key] = true;
			else (a[key] = next), i++;
		} else a._.push(t);
	}
	return a;
}
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';

function buildCfg() {
	// Resolve the numeric GitHub id if only a username was given.
	let githubId = args['github-id'];
	const user = args['github-user'] || 'nirholas';
	if (!githubId) {
		const existing = loadJson(join(ROOT, '.pump-launch-wallets', 'manifest.json'), null);
		githubId = existing?.github_user === user ? existing.github_id : resolveGithubUser(user).id;
	}
	return makeConfig({
		network: args.network,
		rpcUrl: args.rpc,
		githubUser: user,
		githubId,
		devBuySol: args['dev-buy'] != null ? Number(args['dev-buy']) : 0,
		fundPerWalletSol: args['fund-per-wallet'] != null ? Number(args['fund-per-wallet']) : undefined,
	});
}

const die = (m) => (console.error(`\n✗ ${m}\n`), process.exit(1));
async function confirm(q) {
	if (args.yes) return true;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ans = await new Promise((r) => rl.question(`${q} [y/N] `, r));
	rl.close();
	return /^y(es)?$/i.test(ans.trim());
}

async function doGenerate(cfg) {
	let repos = fetchRepos(cfg);
	if (args.only) repos = repos.filter((r) => r.name === args.only);
	if (args.limit) repos = repos.slice(0, Number(args.limit));
	if (!repos.length) die('no repos matched');
	const manifest = generate(cfg, repos);
	const cost = estimateCost(cfg, manifest.repo_count);
	console.log(`\n✓ ${manifest.repo_count} repo wallets + master for github.com/${cfg.githubUser}`);
	console.log(`  master (fund this):  ${manifest.master_pubkey}`);
	console.log(`  rewards → :          ${cfg.socialPda}  (github.com/${cfg.githubUser}, 100%)`);
	console.log(`  fund per wallet:     ${cfg.fundPerWalletSol} SOL`);
	console.log(`  total to fund:       ~${cost.fundingTotalSol} SOL`);
	console.log(`  bundle:              pump-launch-wallets.zip`);
}

async function doStatus(cfg) {
	const { manifest, rows } = loadState(cfg);
	if (!manifest) die('no manifest — run `generate` first');
	const bal = await masterBalanceLamports(cfg);
	const funded = rows.filter((r) => r.funded).length;
	const launched = rows.filter((r) => r.launched).length;
	const shared = rows.filter((r) => r.feeShared).length;
	console.log(`network:       ${cfg.network} (${cfg.rpcUrl})`);
	console.log(`master:        ${masterPubkey(cfg)}  balance ${sol(bal).toFixed(4)} SOL`);
	console.log(`rewards → :    github.com/${cfg.githubUser}  (${manifest.social_fee_pda})`);
	console.log(`repos:         ${rows.length}`);
	console.log(`funded:        ${funded}/${rows.length}`);
	console.log(`launched:      ${launched}/${rows.length}`);
	console.log(`fee-share set: ${shared}/${rows.length}`);
}

function doVerify(cfg) {
	const v = verifyOwnership(cfg);
	console.log(`owned launch wallets: ${v.ok}/${v.total} (mismatches: ${v.mismatches.length})`);
	console.log(`master matches manifest: ${v.master}`);
	if (v.mismatches.length) console.log(`mismatched: ${v.mismatches.join(', ')}`);
	if (v.ok !== v.total || !v.master) process.exit(1);
}

async function doPreflight(cfg) {
	const { manifest } = loadState(cfg);
	if (!manifest) die('no manifest — run `generate` first');
	const entry = args.only ? manifest.repos.find((r) => r.repo === args.only) : manifest.repos[0];
	if (!entry) die('repo not found');
	console.log(`preflight "${entry.repo}" (${entry.symbol}) on ${cfg.network}`);
	const connection = makeConnection(cfg);
	const { offline, online } = makeSdk(connection);
	const creator = Keypair.fromSecretKey(Uint8Array.from(loadJson(join(ROOT, entry.walletFile)))).publicKey;
	const mint = Keypair.generate();
	console.log('• uploading real metadata to pump.fun IPFS…');
	const uri = await uploadMetadata(cfg, entry);
	console.log(`  uri: ${uri}`);
	console.log('• building create + fee-share instructions…');
	const createIxs = await buildCreateIxs({ cfg, offline, online, mint: mint.publicKey, creator, uri, name: entry.name, symbol: entry.symbol });
	const pool = canonicalPumpPoolPda(mint.publicKey);
	const createCfg = await offline.createFeeSharingConfig({ creator, mint: mint.publicKey, pool });
	const update = await offline.updateFeeShares({
		authority: creator,
		mint: mint.publicKey,
		currentShareholders: [creator],
		newShareholders: [{ address: new PublicKey(cfg.socialPda), shareBps: 10000 }],
	});
	console.log(`  create ixs: ${createIxs.length}, feeConfig keys: ${createCfg.keys.length}, update keys: ${update.keys.length}`);
	console.log(`  config PDA: ${feeSharingConfigPda(mint.publicKey).toBase58()}`);
	console.log(`  shareholder (100%): ${cfg.socialPda} = github.com/${cfg.githubUser}`);
	console.log('\n✓ preflight OK — nothing sent.');
}

async function doRun(cfg) {
	const { manifest } = loadState(cfg);
	if (!manifest) die('no manifest — run `generate` first');
	let repoNames = null;
	if (args.only) repoNames = [args.only];
	else if (args.limit) repoNames = manifest.repos.slice(0, Number(args.limit)).map((r) => r.repo);
	const count = repoNames ? repoNames.length : manifest.repo_count;
	if (!(await confirm(`Launch ${count} coins on ${cfg.network}? Real SOL, irreversible.`))) return console.log('aborted');
	await runLaunch(cfg, {
		repoNames,
		onEvent: (e) => {
			if (e.type === 'info') console.log(`  ${e.message}`);
			else if (e.type === 'repo') console.log(`  … ${e.repo.padEnd(28)} ${e.phase} (${e.index}/${e.total})`);
			else if (e.type === 'done') console.log(`  ✓ ${e.repo.padEnd(28)} ${explorerTx(cfg, e.launchSig)}`);
			else if (e.type === 'error') console.log(`  ✗ ${e.repo.padEnd(28)} ${e.message}`);
			else if (e.type === 'complete') console.log(`✓ done (${e.total})`);
		},
	});
}

function help() {
	console.log(
		[
			'pump-launch-repos — one pump.fun coin per repo, rewards → a GitHub user',
			'',
			'  npm run pump:launch:ui         open the visual control panel (recommended)',
			'',
			'  node scripts/pump-launch-repos.mjs <cmd> [flags]',
			'    generate    create master + per-repo wallets, manifest, csv, zip',
			'    status      funding + launch progress',
			'    verify      prove every launch wallet secret is yours',
			'    preflight   upload metadata + build (not send) ixs for one repo',
			'    run         fund + launch (create coin + 100% fee-share → GitHub)',
			'',
			'  flags: --network --rpc --github-user --github-id --dev-buy',
			'         --fund-per-wallet --only <repo> --limit <n> --yes',
		].join('\n'),
	);
}

async function main() {
	if (cmd === 'help') return help();
	const cfg = buildCfg();
	switch (cmd) {
		case 'generate':
			return doGenerate(cfg);
		case 'status':
			return doStatus(cfg);
		case 'verify':
			return doVerify(cfg);
		case 'preflight':
			return doPreflight(cfg);
		case 'run':
		case 'launch':
		case 'fund':
			return doRun(cfg);
		default:
			return help();
	}
}
main().catch((e) => die(e.stack || e.message));
