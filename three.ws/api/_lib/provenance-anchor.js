// Solana anchor for 3D provenance credentials — the on-chain write half.
//
// Writes a provenance credential's hash into a Solana SPL Memo transaction signed
// by the three.ws issuer key (ATTEST_AGENT_SECRET_KEY, the same attester used for
// validation attestations), and confirms the anchor exists on read. Separated
// from the pure core (provenance-3d.js) so the hashing/sign/verify logic stays
// dependency-free and unit-testable, while this file holds the chain I/O.
//
// Requires the issuer key and a funded payer on the target cluster; when either
// is absent it throws a coded error the tool maps to a clean message — never a
// fake success.

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { solanaConnection } from './solana/connection.js';
import { sendAndConfirm } from './solana/confirm.js';
import { loadAttesterKeypair } from './attest-event.js';
import { RPC } from './solana-attestations.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PROVENANCE_MEMO_KIND = 'threews.provenance.3d.v1';

function anchorError(code, message) {
	const e = new Error(message);
	e.code = code;
	return e;
}

/**
 * Anchor a credential hash on Solana. Emits a Memo tx `{ k, h, ts }` signed by the
 * issuer key. Returns the confirmed signature.
 *
 * @param {object} a
 * @param {string} a.credentialHash  sha256 (hex) of the canonical credential
 * @param {string} a.glbSha256       sha256 (hex) of the GLB bytes (for the memo)
 * @param {'devnet'|'mainnet'} [a.cluster='devnet']
 * @returns {Promise<{ signature:string, cluster:string, issuer:string }>}
 */
export async function anchorCredentialHash({ credentialHash, glbSha256, cluster = 'devnet' }) {
	if (!/^[0-9a-f]{64}$/.test(String(credentialHash || ''))) {
		throw anchorError('bad_hash', 'credentialHash must be a 64-char hex sha256');
	}
	let issuer;
	try {
		issuer = loadAttesterKeypair();
	} catch (err) {
		throw anchorError('issuer_key_missing', 'the provenance issuer key (ATTEST_AGENT_SECRET_KEY) is not configured on this deployment');
	}
	const net = cluster === 'mainnet' || cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
	const conn = solanaConnection({ url: RPC[net] || RPC.devnet, commitment: 'confirmed' });

	const memo = JSON.stringify({ k: PROVENANCE_MEMO_KIND, h: credentialHash, glb: glbSha256 });
	const ix = new TransactionInstruction({
		programId: MEMO_PROGRAM_ID,
		keys: [{ pubkey: issuer.publicKey, isSigner: true, isWritable: false }],
		data: Buffer.from(memo, 'utf8'),
	});
	const tx = new Transaction().add(ix);

	let signature;
	try {
		signature = await sendAndConfirm(conn, tx, [issuer], { commitment: 'confirmed' });
	} catch (err) {
		// Most commonly: the issuer wallet has no SOL to pay the fee on this cluster.
		const msg = /insufficient|0 lamports|airdrop|debit an account/i.test(String(err?.message))
			? 'the issuer wallet has insufficient SOL on this cluster to pay the anchor fee'
			: `the anchor transaction failed: ${err?.message || err}`;
		throw anchorError('anchor_failed', msg);
	}
	return { signature, cluster: net, issuer: issuer.publicKey.toBase58() };
}

/**
 * Confirm an anchor transaction exists on-chain. Best-effort and read-only:
 * returns true when the signature is found, false when it isn't, and null when
 * the RPC can't be reached (so verify never fails just because the RPC is down).
 */
export async function confirmAnchor(signature, cluster = 'devnet') {
	const net = cluster === 'mainnet' || cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
	try {
		const conn = solanaConnection({ url: RPC[net] || RPC.devnet, commitment: 'confirmed' });
		const st = await conn.getSignatureStatuses([signature]);
		const info = st?.value?.[0];
		if (!info) return false;
		return info.confirmationStatus === 'confirmed' || info.confirmationStatus === 'finalized' || info.slot != null;
	} catch {
		return null;
	}
}
