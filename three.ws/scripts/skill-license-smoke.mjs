#!/usr/bin/env node
/**
 * Devnet smoke test for the deployed `skill_license` Solana program.
 *
 * Exercises the real program end-to-end against the LIVE deployment:
 *   1. confirms the program id is deployed + executable on the target cluster,
 *   2. ensures the singleton marketplace config exists (initializes it on first
 *      run, with the minter key as both admin authority and minter),
 *   3. mints a license to a fresh synthetic owner for a fresh synthetic agent
 *      mint (never a real third-party wallet/mint),
 *   4. verifies the on-chain SkillLicense PDA reads back as owned + active,
 *   5. asserts the buyer's associated token account holds exactly 1 NFT.
 *
 * Re-runnable: fresh owner + agent mint each run, so the derived license/mint
 * PDAs never collide with a previous run. Exits non-zero on any failure.
 *
 * Env:
 *   SOLANA_RPC_URL_DEVNET     RPC endpoint (default https://api.devnet.solana.com)
 *   SKILL_LICENSE_PROGRAM_ID  override the program id (defaults to the baked id)
 *   SKILL_LICENSE_MINTER_KEY  base58 secret of the authorized minter (required).
 *                             On devnet it is funded via faucet; elsewhere it
 *                             must already hold SOL.
 */
import {
	Connection,
	Keypair,
	PublicKey,
	LAMPORTS_PER_SOL,
	Transaction,
	sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import {
	SKILL_LICENSE_PROGRAM_ID,
	buildInitializeMarketplaceIx,
	buildMintSkillLicenseIx,
	deriveMarketplacePda,
	verifyOnchainSkillLicense,
} from '../api/_lib/skill-license-onchain.js';

const RPC = process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(process.env.SKILL_LICENSE_PROGRAM_ID || SKILL_LICENSE_PROGRAM_ID);
const SKILL = 'summarize';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadMinter() {
	const secret = process.env.SKILL_LICENSE_MINTER_KEY;
	if (!secret) {
		throw new Error(
			'SKILL_LICENSE_MINTER_KEY is required (base58 secret of the authorized minter).',
		);
	}
	return Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

async function ensureFunded(connection, wallet) {
	const balance = await connection.getBalance(wallet.publicKey);
	if (balance >= 0.05 * LAMPORTS_PER_SOL) return;
	if (!RPC.includes('devnet')) {
		throw new Error(
			`minter ${wallet.publicKey.toBase58()} has insufficient SOL (${balance / LAMPORTS_PER_SOL}). ` +
				'Fund it and re-run.',
		);
	}
	let lastErr;
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const sig = await connection.requestAirdrop(wallet.publicKey, 0.2 * LAMPORTS_PER_SOL);
			const bh = await connection.getLatestBlockhash();
			await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
			return;
		} catch (err) {
			lastErr = err;
			console.warn(`  airdrop attempt ${attempt} failed: ${err.message}; retrying…`);
			await sleep(2000 * attempt);
		}
	}
	throw new Error(`could not fund minter via devnet faucet after retries (${lastErr?.message}).`);
}

function decodeMarketplaceMinter(data) {
	// 8-byte discriminator + authority(32) + minter(32)
	return new PublicKey(Buffer.from(data).subarray(40, 72));
}

async function ensureMarketplace(connection, minter) {
	const [marketplace] = deriveMarketplacePda(PROGRAM_ID);
	const info = await connection.getAccountInfo(marketplace);
	if (info) {
		const configured = decodeMarketplaceMinter(info.data);
		if (!configured.equals(minter.publicKey)) {
			throw new Error(
				`marketplace minter is ${configured.toBase58()}, but SKILL_LICENSE_MINTER_KEY is ` +
					`${minter.publicKey.toBase58()}. Use the configured minter key.`,
			);
		}
		console.log(`  marketplace already initialized (minter ✓)`);
		return marketplace;
	}
	console.log(`  initializing marketplace (authority + minter = ${minter.publicKey.toBase58()})…`);
	const { instruction } = buildInitializeMarketplaceIx({
		authority: minter.publicKey,
		minter: minter.publicKey,
		programId: PROGRAM_ID,
	});
	const sig = await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [
		minter,
	], { commitment: 'confirmed' });
	console.log(`  marketplace initialized: ${sig}`);
	return marketplace;
}

async function main() {
	console.log(`skill_license smoke test`);
	console.log(`  rpc:     ${RPC}`);
	console.log(`  program: ${PROGRAM_ID.toBase58()}`);

	const connection = new Connection(RPC, 'confirmed');

	const programAccount = await connection.getAccountInfo(PROGRAM_ID);
	if (!programAccount || !programAccount.executable) {
		throw new Error(
			`program ${PROGRAM_ID.toBase58()} is not deployed/executable on ${RPC}. Deploy it first.`,
		);
	}
	console.log(`  program is deployed + executable ✓`);

	const minter = loadMinter();
	console.log(`  minter: ${minter.publicKey.toBase58()}`);
	await ensureFunded(connection, minter);
	await ensureMarketplace(connection, minter);

	// Fresh synthetic recipient + agent grouping mint each run.
	const owner = Keypair.generate();
	const agentMint = Keypair.generate().publicKey;
	console.log(`  owner:      ${owner.publicKey.toBase58()}`);
	console.log(`  agent mint: ${agentMint.toBase58()}`);

	console.log(`  minting skill license '${SKILL}'…`);
	const { instruction, accounts } = buildMintSkillLicenseIx({
		minter: minter.publicKey,
		owner: owner.publicKey,
		agentMint,
		skillName: SKILL,
		programId: PROGRAM_ID,
	});
	const signature = await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [
		minter,
	], { commitment: 'confirmed' });
	console.log(`  tx confirmed: ${signature}`);
	console.log(`  license: ${accounts.skillLicense}`);
	console.log(`  nft:     ${accounts.nftMint}`);

	const result = await verifyOnchainSkillLicense({
		connection,
		ownerWallet: owner.publicKey.toBase58(),
		agentMint: agentMint.toBase58(),
		skill: SKILL,
		network: RPC.includes('devnet') ? 'devnet' : 'mainnet',
		programId: PROGRAM_ID,
	});
	const checks = [
		['deployed', result.deployed, true],
		['exists', result.exists, true],
		['owned', result.owned, true],
		['revoked', result.revoked, false],
		['record.authority', result.record?.authority, owner.publicKey.toBase58()],
		['record.agentMint', result.record?.agentMint, agentMint.toBase58()],
		['record.nftMint', result.record?.nftMint, accounts.nftMint],
		['record.skillName', result.record?.skillName, SKILL],
	];
	for (const [name, got, want] of checks) {
		if (got !== want) throw new Error(`${name} mismatch: got ${got}, expected ${want}`);
		console.log(`  ${name} ✓`);
	}

	const bal = await connection.getTokenAccountBalance(new PublicKey(accounts.ownerTokenAccount));
	if (bal.value.amount !== '1' || bal.value.decimals !== 0) {
		throw new Error(`expected exactly 1 NFT (0 decimals), got ${JSON.stringify(bal.value)}`);
	}
	console.log(`  owner holds exactly 1 NFT ✓`);

	const cluster = RPC.includes('devnet') ? '?cluster=devnet' : '';
	console.log(`\n✅ SkillLicense minted + verified on-chain.`);
	console.log(`   https://explorer.solana.com/address/${accounts.skillLicense}${cluster}`);
}

main().catch((err) => {
	console.error(`\n❌ smoke test failed: ${err.message}`);
	process.exit(1);
});
