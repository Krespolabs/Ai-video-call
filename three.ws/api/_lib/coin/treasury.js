// Keypair loaders + SOL transfer helpers for coin distribution.
//
// Two keypairs are involved:
//
//   coin treasury (fee payer + transfer signer)
//     env: COIN_TREASURY_SECRET_KEY_B64
//     purpose: pays tx fees for all distribution ops AND signs SystemProgram.transfer
//              instructions when paying lottery winners / reflection drips. The
//              treasury holds the SOL that was previously claimed from the
//              pump.fun creator vault — distribution is just "move from
//              treasury to holders".
//
//   coin creator (pump.fun creator address for one specific launch)
//     env: COIN_CREATOR_SECRET_KEY_B64_<MINT>
//          or coin_launches.metadata.creator_secret_b64 (loaded by ID)
//     purpose: signs the `collectCreatorFee` instruction so pump.fun's program
//              releases creator-fee SOL to its associated token account, which
//              then gets unwrapped and routed to the treasury inside the same
//              transaction.

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { getConnection } from '../pump.js';
import { submitProtected } from '../execution-engine.js';
import { decryptSecret, isEncryptedSecret } from '../secret-box.js';

const SOL_LAMPORTS = 1_000_000_000n;
const TX_MAX_TRANSFERS = 18; // SystemProgram.transfer is ~96 bytes; leaves room for compute-budget ix
const PRIORITY_MICRO_LAMPORTS = 50_000; // priority fee per CU — moderate competitive level

function decodeB64Keypair(b64, label) {
	if (!b64) throw new Error(`${label}: env not set`);
	const raw = Buffer.from(b64, 'base64');
	if (raw.byteLength !== 64) {
		throw new Error(`${label}: expected 64-byte secret key, got ${raw.byteLength}`);
	}
	return Keypair.fromSecretKey(raw);
}

/** Load the treasury keypair from env. Throws if unset. */
export function loadCoinTreasury() {
	return decodeB64Keypair(process.env.COIN_TREASURY_SECRET_KEY_B64, 'COIN_TREASURY_SECRET_KEY_B64');
}

/**
 * Load the pump.fun creator keypair for a specific mint.
 *
 * Lookup order:
 *   1. COIN_CREATOR_SECRET_KEY_B64_<MINT>  (env, deploy-time secret, base64)
 *   2. coin.metadata.creator_secret_b64    (DB, set by the launch script)
 *
 * The DB value is AES-256-GCM-encrypted at rest under WALLET_ENCRYPTION_KEY
 * (the same custodial-key scheme as agent wallets) — a `v2:`-prefixed blob is
 * decrypted before use. Pre-encryption rows held a raw base64 secret in the
 * clear; those are still read (so launches keep claiming fees) but emit a loud
 * deprecation warning — re-run the launcher / a re-encrypt sweep to upgrade them.
 *
 * Async because decryption is async. Returns null if neither source is
 * configured (caller decides whether to fall back to dry-run or error).
 */
export async function loadCoinCreatorFromCoin(coin) {
	const mintKey = `COIN_CREATOR_SECRET_KEY_B64_${coin.mint}`;
	const envValue = process.env[mintKey];
	if (envValue) return decodeB64Keypair(envValue, mintKey);

	const dbValue = coin?.metadata?.creator_secret_b64;
	if (!dbValue) return null;

	if (isEncryptedSecret(dbValue)) {
		const b64 = await decryptSecret(dbValue);
		return decodeB64Keypair(b64, 'coin.metadata.creator_secret_b64 (decrypted)');
	}

	// Legacy: a plaintext base64 secret was stored before at-rest encryption.
	// Honor it so existing launches keep working, but make the exposure LOUD —
	// page ops (deduped) until `scripts/reencrypt-creator-keys.mjs --apply` runs.
	console.warn(
		`[coin/treasury] mint ${coin.mint}: creator_secret_b64 is stored UNENCRYPTED. ` +
			'Run scripts/reencrypt-creator-keys.mjs --apply to remove the plaintext key.',
	);
	import('../alerts.js')
		.then(({ sendOpsAlert }) =>
			sendOpsAlert(
				'Unencrypted pump.fun creator key in use',
				'A coin_launches row still holds a plaintext creator_secret_b64. ' +
					'Run scripts/reencrypt-creator-keys.mjs --apply to encrypt it at rest.',
				{ signature: 'plaintext-creator-key' },
			),
		)
		.catch(() => {});
	return decodeB64Keypair(dbValue, 'coin.metadata.creator_secret_b64 (legacy plaintext)');
}

/** Lamports → SOL string for log lines. */
export function lamportsToSol(lamports) {
	const big = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
	const whole = big / SOL_LAMPORTS;
	const frac = big % SOL_LAMPORTS;
	return `${whole}.${frac.toString().padStart(9, '0')}`;
}

/**
 * Send a single SystemProgram.transfer of `lamports` SOL from `from` to `to`.
 * Returns the tx signature on confirmation. Used for the lottery winner payout.
 *
 * @param {object} opts
 * @param {Keypair} opts.from        signing keypair (treasury) — pays fees + transfers
 * @param {string|PublicKey} opts.to recipient wallet
 * @param {bigint|number} opts.lamports
 * @param {'mainnet'|'devnet'} [opts.network]
 */
export async function sendSolTransfer({ from, to, lamports, network = 'mainnet' }) {
	const connection = getConnection({ network });
	const toPk = typeof to === 'string' ? new PublicKey(to) : to;
	const amount = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
	if (amount <= 0n) throw new Error('sendSolTransfer: amount must be > 0');

	// Protected send: data-driven priority fee + CU, rebroadcast with blockhash
	// refresh, and a hard throw on an on-chain revert. (submitProtected sets its
	// own compute-budget, so we no longer add one here.)
	const { signature } = await submitProtected({
		network,
		connection,
		payer: from,
		instructions: [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: toPk, lamports: amount })],
	});
	return signature;
}

/**
 * Send up to TX_MAX_TRANSFERS SystemProgram.transfer ix in a single tx.
 * Used as the inner primitive by sendSolBatched().
 */
async function sendChunk({ from, transfers, network }) {
	const connection = getConnection({ network });
	const instructions = transfers.map((t) =>
		SystemProgram.transfer({
			fromPubkey: from.publicKey,
			toPubkey: typeof t.to === 'string' ? new PublicKey(t.to) : t.to,
			lamports: typeof t.lamports === 'bigint' ? t.lamports : BigInt(t.lamports),
		}),
	);
	const { signature } = await submitProtected({ network, connection, payer: from, instructions });
	return signature;
}

/**
 * Send a batch of SOL transfers, splitting into multiple transactions when
 * the batch exceeds TX_MAX_TRANSFERS. Returns an array of result objects
 * matching the input order; each result has {recipients: [...], signature, error}.
 *
 * Failures inside one chunk DO NOT abort the rest — every chunk is attempted
 * and individually reported, so the caller can mark the successful payouts
 * confirmed in DB and re-queue the failed ones.
 *
 * @param {object} opts
 * @param {Keypair} opts.from
 * @param {Array<{ to: string, lamports: bigint|number, ref?: any }>} opts.transfers
 * @param {'mainnet'|'devnet'} [opts.network]
 */
export async function sendSolBatched({ from, transfers, network = 'mainnet' }) {
	const results = [];
	for (let i = 0; i < transfers.length; i += TX_MAX_TRANSFERS) {
		const chunk = transfers.slice(i, i + TX_MAX_TRANSFERS);
		try {
			const sig = await sendChunk({ from, transfers: chunk, network });
			results.push({ recipients: chunk, signature: sig, error: null });
		} catch (err) {
			results.push({
				recipients: chunk,
				signature: null,
				error: err?.message || String(err),
			});
		}
	}
	return results;
}

export { TX_MAX_TRANSFERS, PRIORITY_MICRO_LAMPORTS };
