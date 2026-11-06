#!/usr/bin/env node
/**
 * Register three.ws itself as an ERC-8004 agent in the canonical IdentityRegistry.
 * ---------------------------------------------------------------------------
 * The platform tells users to register their agents on-chain; this is three.ws
 * eating its own dog food. It mints the platform agent on Base Sepolia (cheap
 * dry-run of the whole flow) and Base mainnet, points each tokenURI at the real
 * 3D Agent Card v1 (public/.well-known/3d-agent-card.json), then writes the
 * resulting { agentId, agentRegistry } entries back into BOTH that card and the
 * discovery doc (public/.well-known/agent-registration.json).
 *
 * The full on-chain sequence per network:
 *   1. Gate: the card MUST be schema-valid and its model.sha256 MUST match the
 *      GLB bytes (spec conformance #3). We refuse to mint an unverified card.
 *   2. (optional) Pin the GLB + an immutable card snapshot to IPFS via Pinata
 *      when PINATA_JWT is set; otherwise the stable first-party https URLs are
 *      used (schema-valid, hash-verifiable, single source of truth).
 *   3. register(cardURI)  → parse the Registered event → agentId
 *   4. setAgentURI(agentId, cardURI)
 *   5. tokenURI(agentId) read-back must equal cardURI
 *
 * Required env (any ONE key name; must hold ETH on the target chain for gas):
 *   ERC8004_SELF_REGISTER_KEY | DEPLOYER_PRIVATE_KEY | EVM_TREASURY_PRIVATE_KEY
 * Optional env:
 *   RPC_URL_8453   Base RPC      (default https://mainnet.base.org)
 *   RPC_URL_84532  Base Sepolia  (default https://sepolia.base.org)
 *   PINATA_JWT     pin GLB + card to IPFS instead of using first-party https
 *   PUBLIC_APP_ORIGIN  card origin (default https://three.ws)
 *
 * Usage (env from .env via --env-file, plus this repo's loadEnv fallback):
 *   # estimate gas only, no broadcast, no writes:
 *   node scripts/erc8004-register-self.mjs --network both --dry-run
 *
 *   # real Base Sepolia mint (testnet ETH):
 *   node scripts/erc8004-register-self.mjs --network sepolia --confirm
 *
 *   # real Base mainnet mint (spends real ETH — requires --confirm):
 *   node scripts/erc8004-register-self.mjs --network base --confirm
 *
 *   # both, in order (sepolia then mainnet):
 *   node scripts/erc8004-register-self.mjs --network both --confirm
 *
 * Re-runs are safe: a network already recorded in the ledger is skipped unless
 * --force is passed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ethers } from 'ethers';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { REGISTRY_DEPLOYMENTS, agentRegistryId } from '../src/erc8004/abi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const CARD_PATH = resolve(REPO_ROOT, 'public/.well-known/3d-agent-card.json');
const REGISTRATION_PATH = resolve(REPO_ROOT, 'public/.well-known/agent-registration.json');
const SCHEMA_PATH = resolve(REPO_ROOT, 'public/.well-known/3d-agent-card.schema.json');
const LEDGER_PATH = resolve(REPO_ROOT, 'data/erc8004-self-register-ledger.json');

const IDENTITY_REGISTRY_ABI = [
	'function register(string agentURI) external returns (uint256 agentId)',
	'function setAgentURI(uint256 agentId, string newURI) external',
	'function tokenURI(uint256 tokenId) external view returns (string)',
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
];

// Base Sepolia first (cheap full-flow rehearsal), then Base mainnet.
const NETWORKS = {
	sepolia: {
		key: 'sepolia',
		chainId: 84532,
		name: 'Base Sepolia',
		rpcEnv: 'RPC_URL_84532',
		rpcDefault: 'https://sepolia.base.org',
		explorer: 'https://sepolia.basescan.org',
	},
	base: {
		key: 'base',
		chainId: 8453,
		name: 'Base',
		rpcEnv: 'RPC_URL_8453',
		rpcDefault: 'https://mainnet.base.org',
		explorer: 'https://basescan.org',
	},
};

// ── arg / env plumbing ───────────────────────────────────────────────────────

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
		? process.argv[i + 1]
		: fallback;
}
function flag(name) {
	return process.argv.includes(name);
}

function loadEnvFile(path) {
	if (!existsSync(path)) return;
	for (const raw of readFileSync(path, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		const k = line.slice(0, eq).trim();
		let v = line.slice(eq + 1).trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		if (v && process.env[k] === undefined) process.env[k] = v;
	}
}

function loadEnv() {
	loadEnvFile(resolve(REPO_ROOT, '.env'));
	loadEnvFile(resolve(REPO_ROOT, '.env.local'));
	loadEnvFile(resolve(REPO_ROOT, '.vercel/.env.preview.local'));
}

function resolveSignerKey() {
	const names = [
		'ERC8004_SELF_REGISTER_KEY',
		'DEPLOYER_PRIVATE_KEY',
		'EVM_TREASURY_PRIVATE_KEY',
		'BSC_OPERATOR_KEY',
	];
	for (const n of names) {
		const v = process.env[n];
		if (v && v.trim()) return { key: v.trim().startsWith('0x') ? v.trim() : '0x' + v.trim(), name: n };
	}
	return null;
}

// ── ledger ───────────────────────────────────────────────────────────────────

function loadLedger() {
	if (!existsSync(LEDGER_PATH)) return { registrations: [] };
	try {
		return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
	} catch {
		return { registrations: [] };
	}
}
function ledgerHas(chainId) {
	return loadLedger().registrations.some((r) => r.chainId === chainId);
}
function appendLedger(entry) {
	const ledger = loadLedger();
	ledger.registrations = ledger.registrations.filter((r) => r.chainId !== entry.chainId);
	ledger.registrations.push({ ...entry, at: new Date().toISOString() });
	mkdirSync(dirname(LEDGER_PATH), { recursive: true });
	writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
}

// ── card verification gate (schema + model hash) ─────────────────────────────

function loadCard() {
	return JSON.parse(readFileSync(CARD_PATH, 'utf8'));
}

function verifyCard(card) {
	const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
	const ajv = new Ajv({ allErrors: true, strict: false });
	addFormats(ajv);
	const validate = ajv.compile(schema);
	if (!validate(card)) {
		const msg = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
		throw new Error(`card fails schema: ${msg}`);
	}
	const m = /\/avatars\/([^/?#]+)$/.exec(card.model?.uri || '');
	if (!m) throw new Error(`card model.uri is not a first-party /avatars asset: ${card.model?.uri}`);
	const local = resolve(REPO_ROOT, 'public/avatars', m[1]);
	if (!existsSync(local)) throw new Error(`model GLB not found locally: ${local}`);
	const actual = createHash('sha256').update(readFileSync(local)).digest('hex');
	if (actual !== String(card.model.sha256).toLowerCase()) {
		throw new Error(`model.sha256 mismatch — card ${card.model.sha256} vs bytes ${actual}`);
	}
	return { glbPath: local, glbName: m[1] };
}

// ── IPFS pinning (optional, when PINATA_JWT is present) ───────────────────────

async function pinToPinata(bytes, filename, contentType) {
	const jwt = process.env.PINATA_JWT;
	if (!jwt) return null;
	const form = new FormData();
	form.append('file', new Blob([bytes], { type: contentType }), filename);
	const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
		method: 'POST',
		headers: { Authorization: `Bearer ${jwt}` },
		body: form,
	});
	if (!res.ok) throw new Error(`Pinata pin failed (${res.status}): ${await res.text().catch(() => '')}`);
	const data = await res.json();
	return `ipfs://${data.IpfsHash}`;
}

// ── card writeback ───────────────────────────────────────────────────────────

/** Insert/replace a registration entry (dedup by chainId via the eip155 prefix). */
function upsertRegistration(list, chainId, registryAddr, agentId) {
	const entry = { agentId: Number(agentId), agentRegistry: agentRegistryId(chainId, registryAddr) };
	const prefix = `eip155:${chainId}:`;
	const next = (Array.isArray(list) ? list : []).filter(
		(r) => !String(r.agentRegistry || '').startsWith(prefix),
	);
	next.push(entry);
	return next;
}

function writeRegistrationsBack(results) {
	for (const path of [CARD_PATH, REGISTRATION_PATH]) {
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		for (const r of results) {
			doc.registrations = upsertRegistration(doc.registrations, r.chainId, r.registry, r.agentId);
		}
		writeFileSync(path, JSON.stringify(doc, null, '\t') + '\n');
		console.log(`  wrote ${results.length} registration(s) → ${basename(path)}`);
	}
}

// ── one network ──────────────────────────────────────────────────────────────

async function registerOnNetwork(net, { signerKey, cardURI, dryRun, glbName, glbPath }) {
	const deployment = REGISTRY_DEPLOYMENTS[net.chainId];
	if (!deployment?.identityRegistry) throw new Error(`no IdentityRegistry for chain ${net.chainId}`);
	const registry = deployment.identityRegistry;

	const rpc = process.env[net.rpcEnv] || net.rpcDefault;
	const provider = new ethers.JsonRpcProvider(rpc, net.chainId);
	const wallet = new ethers.Wallet(signerKey, provider);
	const contract = new ethers.Contract(registry, IDENTITY_REGISTRY_ABI, wallet);

	const bal = await provider.getBalance(wallet.address);
	console.log(`\n── ${net.name} (chain ${net.chainId}) ──`);
	console.log(`  rpc:      ${rpc}`);
	console.log(`  registry: ${registry}`);
	console.log(`  signer:   ${wallet.address}  (${ethers.formatEther(bal)} ETH)`);
	console.log(`  tokenURI: ${cardURI}`);

	// Optionally pin the GLB to IPFS now. The immutable card snapshot that points
	// at this URI is pinned AFTER the mint (below), once the agentId is known, so
	// the on-chain card embeds its own registration. We always mint against the
	// stable https card URL so the seed Registered event carries a resolvable URI.
	let glbIpfs = null;
	if (process.env.PINATA_JWT) {
		console.log('  pinning GLB to IPFS (PINATA_JWT present)…');
		glbIpfs = await pinToPinata(readFileSync(glbPath), glbName, 'model/gltf-binary');
		console.log(`  GLB pinned: ${glbIpfs}`);
	}
	const mintURI = cardURI;

	const fn = contract.getFunction('register(string)');

	if (dryRun) {
		const gas = await fn.estimateGas(mintURI);
		const feeData = await provider.getFeeData();
		const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
		const cost = gas * gasPrice;
		console.log(`  [dry-run] est. register gas = ${gas} · ~${ethers.formatEther(cost)} ETH`);
		return { dryRun: true, chainId: net.chainId };
	}

	if (bal === 0n) throw new Error(`signer has 0 ETH on ${net.name} — fund ${wallet.address} first`);

	// 1. register(cardURI)
	console.log('  register(cardURI)…');
	const tx = await fn.send(mintURI);
	console.log(`    tx: ${net.explorer}/tx/${tx.hash}`);
	const receipt = await tx.wait();
	if (!receipt || receipt.status !== 1) throw new Error(`register tx failed (status ${receipt?.status})`);

	let agentId = null;
	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
		try {
			const parsed = contract.interface.parseLog(log);
			if (parsed?.name === 'Registered') {
				agentId = parsed.args.agentId.toString();
				break;
			}
		} catch {
			/* not our event */
		}
	}
	if (!agentId) throw new Error(`Registered event not found in ${tx.hash}`);
	console.log(`    agentId = ${agentId}`);

	// 2. (optional) pin an immutable card snapshot that embeds this registration,
	//    and prefer it as the on-chain tokenURI.
	let finalURI = cardURI;
	if (process.env.PINATA_JWT) {
		const card = loadCard();
		if (glbIpfs) card.model.uri = glbIpfs;
		card.registrations = upsertRegistration(card.registrations, net.chainId, registry, agentId);
		const snapshot = Buffer.from(JSON.stringify(card, null, '\t'), 'utf8');
		const cardIpfs = await pinToPinata(snapshot, `3d-agent-card-${net.chainId}.json`, 'application/json');
		finalURI = cardIpfs;
		console.log(`    immutable card pinned: ${cardIpfs}`);
	}

	// 3. setAgentURI(agentId, finalURI)
	console.log('  setAgentURI(agentId, cardURI)…');
	const setTx = await contract.setAgentURI(agentId, finalURI);
	console.log(`    tx: ${net.explorer}/tx/${setTx.hash}`);
	const setReceipt = await setTx.wait();
	if (!setReceipt || setReceipt.status !== 1) throw new Error(`setAgentURI tx failed`);

	// 4. read-back tokenURI
	const onchainURI = await contract.tokenURI(agentId);
	const resolved = onchainURI === finalURI;
	console.log(`  tokenURI(${agentId}) = ${onchainURI}  ${resolved ? '✓ resolves' : '✗ MISMATCH'}`);
	if (!resolved) throw new Error(`tokenURI read-back mismatch: ${onchainURI} != ${finalURI}`);

	const result = {
		chainId: net.chainId,
		network: net.name,
		registry,
		agentId,
		owner: wallet.address,
		tokenURI: finalURI,
		registerTx: tx.hash,
		setUriTx: setTx.hash,
		agentRegistry: agentRegistryId(net.chainId, registry),
		explorer: `${net.explorer}/token/${registry}?a=${agentId}`,
	};
	appendLedger(result);
	console.log(`  ✓ registered — ${result.explorer}`);
	return result;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
	loadEnv();
	const which = arg('--network', 'both');
	const dryRun = flag('--dry-run');
	const confirmed = flag('--confirm');
	const force = flag('--force');

	const order =
		which === 'base' ? ['base'] : which === 'sepolia' ? ['sepolia'] : ['sepolia', 'base'];

	console.log('three.ws — ERC-8004 self-registration');
	console.log(`  networks: ${order.join(' → ')}   mode: ${dryRun ? 'DRY RUN' : confirmed ? 'LIVE' : 'UNCONFIRMED'}`);

	// Gate: the card must verify before we ever point a tokenURI at it.
	const card = loadCard();
	const { glbName, glbPath } = verifyCard(card);
	console.log(`  card verified: ${card.name} · model ${glbName} · sha256 ✓`);

	const origin = (process.env.PUBLIC_APP_ORIGIN || 'https://three.ws').replace(/\/$/, '');
	const cardURI = `${origin}/.well-known/3d-agent-card.json`;

	const signer = resolveSignerKey();
	if (!signer) {
		console.error(
			'\n✗ No signer key. Set ERC8004_SELF_REGISTER_KEY (or DEPLOYER_PRIVATE_KEY / ' +
				'EVM_TREASURY_PRIVATE_KEY) to a 0x-hex EVM private key funded with ETH on the ' +
				'target chain(s). Base Sepolia ETH is free from a faucet; Base mainnet needs real ETH.',
		);
		process.exit(1);
	}
	console.log(`  signer key: ${signer.name}`);

	if (!dryRun && !confirmed) {
		console.error('\n✗ Refusing a live run without --confirm (it broadcasts real txs). Add --confirm, or use --dry-run.');
		process.exit(1);
	}

	const results = [];
	for (const key of order) {
		const net = NETWORKS[key];
		if (!dryRun && !force && ledgerHas(net.chainId)) {
			console.log(`\n── ${net.name} — already in ledger, skipping (use --force to re-mint).`);
			continue;
		}
		try {
			const r = await registerOnNetwork(net, { signerKey: signer.key, cardURI, dryRun, glbName, glbPath });
			if (!r.dryRun) results.push(r);
		} catch (err) {
			console.error(`  ✗ ${net.name} failed: ${err.shortMessage || err.message}`);
			if (key === 'sepolia' && order.includes('base')) {
				console.error('  Aborting before mainnet — fix the testnet run first.');
				process.exit(1);
			}
		}
	}

	if (results.length > 0) {
		console.log('\nWriting registrations back to the served documents…');
		writeRegistrationsBack(results);
		console.log('\n✓ Done. Commit + deploy so the served cards carry the new registrations,');
		console.log('  then the on-chain tokenURI resolves to a card that lists its own agentId.');
	} else if (dryRun) {
		console.log('\nDry run complete — no txs sent, no files written.');
	}
}

main().catch((err) => {
	console.error('\nfatal:', err?.stack || err?.message || err);
	process.exit(1);
});
