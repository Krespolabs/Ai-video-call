#!/usr/bin/env node
// Verifies the avatar's money-movement path.
//
//   Phase 1 (offline, deterministic): builds + signs the EXACT transfer the
//   /api/agent/send-sol endpoint submits and proves it is cryptographically
//   valid — signature verifies, correct SystemProgram.transfer (from/to/
//   lamports) and memo instruction. No network, never flaky.
//
//   Phase 2 (on-chain, best-effort): airdrops devnet SOL and does a real
//   transfer via sendSol(). If the public faucet is dry/rate-limited it is
//   SKIPPED (not failed) — Phase 1 already proves the code path.
//
//   node scripts/verify-send-sol.mjs
//
// Exits non-zero only if Phase 1 fails.

import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey } from '@solana/web3.js';
import {
	getConnection,
	getSolBalance,
	sendSol,
	buildSignedSolTransfer,
	explorerTxUrl,
} from '../api/_lib/avatar-wallet.js';

const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const DEVNET = process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

// ── Phase 1: offline build + sign + verify ──────────────────────────────────
function phaseOffline() {
	console.log('▸ Phase 1 — offline build/sign/verify (deterministic)\n');
	const from = Keypair.generate();
	const to = Keypair.generate();
	const lamports = Math.round(0.0067 * LAMPORTS_PER_SOL); // ~$1 of SOL @ ~$150
	const memo = 'three.ws avatar · $1.00 SOL';
	// A recent blockhash is just a 32-byte base58 value for signing purposes.
	const blockhash = Keypair.generate().publicKey.toBase58();

	const tx = buildSignedSolTransfer({ fromKeypair: from, to: to.publicKey, lamports, memo, blockhash });

	assert(tx.verifySignatures() === true, 'signature does not verify');
	assert(tx.feePayer.equals(from.publicKey), 'fee payer is not the sender');
	assert(tx.instructions.length === 2, `expected 2 instructions, got ${tx.instructions.length}`);

	const [transferIx, memoIx] = tx.instructions;
	assert(transferIx.programId.toBase58() === SYSTEM_PROGRAM, 'first ix is not the System Program');
	assert(transferIx.keys[0].pubkey.equals(from.publicKey), 'transfer source mismatch');
	assert(transferIx.keys[1].pubkey.equals(to.publicKey), 'transfer destination mismatch');
	// SystemProgram transfer encodes: u32 instruction index (2) + u64 lamports (LE).
	const encodedLamports = transferIx.data.readBigUInt64LE(4);
	assert(encodedLamports === BigInt(lamports), `encoded lamports ${encodedLamports} !== ${lamports}`);

	assert(memoIx.programId.toBase58() === MEMO_PROGRAM, 'second ix is not the Memo Program');
	assert(memoIx.data.toString('utf8') === memo, 'memo payload mismatch');

	console.log(`  ✓ signature verifies (ed25519)`);
	console.log(`  ✓ SystemProgram.transfer ${from.publicKey.toBase58().slice(0, 6)}… → ${to.publicKey.toBase58().slice(0, 6)}… for ${encodedLamports} lamports`);
	console.log(`  ✓ memo instruction = "${memo}"`);
	console.log(`  ✓ serializes to ${tx.serialize().length} bytes (submittable)\n`);
}

// ── Phase 2: best-effort real devnet send ───────────────────────────────────
async function phaseOnchain() {
	console.log('▸ Phase 2 — real devnet transfer (best-effort)\n');
	const connection = getConnection(DEVNET);
	const sender = Keypair.generate();
	const recipient = Keypair.generate();

	let funded = false;
	for (let attempt = 1; attempt <= 2 && !funded; attempt++) {
		try {
			const sig = await connection.requestAirdrop(sender.publicKey, LAMPORTS_PER_SOL);
			const bh = await connection.getLatestBlockhash('confirmed');
			await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
			funded = true;
		} catch (err) {
			if (/429|airdrop limit|faucet has run dry|Internal error/i.test(err.message)) {
				console.log('  ⓘ devnet faucet unavailable (rate-limited / dry) — SKIPPING on-chain phase.');
				console.log('    Phase 1 already proved the transfer is correct & submittable.');
				console.log('    To run live: fund a devnet wallet at https://faucet.solana.com and re-run,');
				console.log('    or set AVATAR_NETWORK=mainnet on a funded wallet for the real demo.\n');
				return 'skipped';
			}
			console.log(`  airdrop attempt ${attempt} failed (${err.message}) — retrying…`);
			await sleep(2000);
		}
	}
	if (!funded) {
		console.log('  ⓘ could not fund devnet wallet — SKIPPING on-chain phase.\n');
		return 'skipped';
	}

	const lamports = Math.round(0.01 * LAMPORTS_PER_SOL);
	const signature = await sendSol({
		connection,
		fromKeypair: sender,
		to: recipient.publicKey,
		lamports,
		memo: 'three.ws avatar · devnet verify',
	});
	const recvBal = await getSolBalance(connection, recipient.publicKey);
	assert(recvBal.lamports === lamports, `recipient got ${recvBal.lamports}, expected ${lamports}`);
	console.log(`  ✓ confirmed on-chain: ${signature}`);
	console.log(`    ${explorerTxUrl(signature, 'devnet')}`);
	console.log(`  ✓ recipient received exactly ${recvBal.sol} SOL\n`);
	return 'sent';
}

(async () => {
	phaseOffline();
	const onchain = await phaseOnchain();
	console.log(onchain === 'sent'
		? '✅ Money path verified offline AND on-chain.'
		: '✅ Money path verified offline (on-chain phase skipped — faucet dry).');
	process.exit(0);
})().catch((err) => {
	console.error('\n✗ verification failed:', err?.message || err);
	process.exit(1);
});
