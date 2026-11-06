/**
 * On-chain review attestor (server-side).
 *
 * Every time a user submits or edits an agent/skill review, this module emits a
 * threews.review.v1 SPL-Memo attestation signed by the platform attester and
 * mirrors it into solana_attestations. The result is a tamper-evident,
 * publicly-verifiable on-chain record of each review anchored to the agent's
 * Metaplex Core asset.
 *
 * Design mirrors trader-score-attest.js:
 *   - Best-effort: callers catch errors and log; the HTTP response is never blocked.
 *   - Idempotent per (agent_asset, network, review_id, updated_at): editing a
 *     review emits a new attestation capturing the updated state; retrying the
 *     same POST never double-mints.
 *   - Silently no-ops when the agent has no Solana asset (newer agents may not
 *     yet have a Metaplex Core pubkey on record).
 */

import crypto from 'node:crypto';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { sendAndConfirm } from './solana/confirm.js';

import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { RPC } from './solana-attestations.js';
import { loadAttesterKeypair } from './attest-event.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const REVIEW_KIND = 'threews.review.v1';
const TX_TIMEOUT_MS = 15_000;

export class ReviewAttestError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ReviewAttestError';
		this.code = code;
	}
}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(Object.assign(new Error(`rpc timeout after ${ms}ms`), { code: 'RPC_TIMEOUT' })),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Attest a user review on-chain via Solana SPL-Memo.
 *
 * @param {object} p
 * @param {string} p.reviewId      UUID of the agent_reviews or skill_reviews row.
 * @param {string} p.updatedAt     ISO timestamp from the DB row (updated_at) — part of the idempotency key.
 * @param {string} p.agentId       three.ws agent UUID (DB identifier, recorded in payload for back-reference).
 * @param {number} p.rating        1–5 star rating.
 * @param {string|null} p.body     Review text (may be null / empty).
 * @param {'agent'|'skill'} p.reviewType
 * @param {string} [p.skill]       Skill name — only for reviewType='skill'.
 * @param {'mainnet'|'devnet'} [p.network='mainnet']
 * @returns {Promise<{ status:'minted'|'deduped'|'no_asset', signature:string|null }>}
 */
export async function attestReview({ reviewId, updatedAt, agentId, rating, body, reviewType, skill, network = 'mainnet' }) {
	// Resolve the agent's Metaplex Core asset pubkey — the canonical attestation subject.
	// Column mirrors what solana-bouncer.js reads.
	const [agentRow] = await sql`
		select coalesce(meta->'onchain'->>'sol_asset', meta->>'sol_mint_address') as agent_asset
		  from agent_identities
		 where id = ${agentId} and deleted_at is null
		 limit 1
	`;
	const agentAsset = agentRow?.agent_asset;
	if (!agentAsset) return { status: 'no_asset', signature: null };

	try { new PublicKey(agentAsset); } catch {
		throw new ReviewAttestError('invalid_asset', `agent_identities row has an unparseable sol_asset for agent ${agentId}`);
	}

	let attester;
	try { attester = loadAttesterKeypair(); } catch {
		throw new ReviewAttestError('attester_key_not_configured', 'ATTEST_AGENT_SECRET_KEY is not set');
	}

	// Idempotency: one attestation per (review_id, updated_at second).
	// Edits change updated_at, so each new write produces exactly one new attestation.
	const updatedSec = String(Math.floor(new Date(updatedAt).getTime() / 1000));
	const [existing] = await sql`
		select signature from solana_attestations
		where agent_asset = ${agentAsset}
		  and network = ${network}
		  and kind = ${REVIEW_KIND}
		  and payload->>'review_id' = ${reviewId}
		  and payload->>'updated_sec' = ${updatedSec}
		limit 1
	`;
	if (existing) return { status: 'deduped', signature: existing.signature };

	// SHA-256 of the body text — lets anyone verify the content matches without
	// storing the body itself on-chain (privacy) while still making it tamper-evident.
	const bodyHash = body ? crypto.createHash('sha256').update(body, 'utf8').digest('hex') : null;

	const payload = {
		v: 1,
		kind: REVIEW_KIND,
		agent: agentAsset,
		agent_id: agentId,
		review_id: reviewId,
		updated_sec: updatedSec,
		rating,
		body_hash: bodyHash,
		review_type: reviewType,
		...(skill ? { skill } : {}),
		network,
		ts: Math.floor(Date.now() / 1000),
		source: 'threews.review',
	};

	const conn = solanaConnection({ url: RPC[network] || RPC.devnet, commitment: 'confirmed' });
	const ix = new TransactionInstruction({
		programId: MEMO_PROGRAM_ID,
		keys: [
			{ pubkey: attester.publicKey, isSigner: true, isWritable: false },
			{ pubkey: new PublicKey(agentAsset), isSigner: false, isWritable: false },
		],
		data: Buffer.from(JSON.stringify(payload), 'utf8'),
	});

	let signature;
	try {
		signature = await withTimeout(
			sendAndConfirm(conn, new Transaction().add(ix), [attester], { commitment: 'confirmed' }),
			TX_TIMEOUT_MS,
		);
	} catch (err) {
		throw new ReviewAttestError('tx_failed', `review memo tx failed: ${err.message}`);
	}

	try {
		await sql`
			insert into solana_attestations (
				signature, network, slot, block_time, agent_asset, attester, kind, payload, verified
			) values (
				${signature}, ${network}, null, now(),
				${agentAsset}, ${attester.publicKey.toBase58()},
				${REVIEW_KIND}, ${JSON.stringify(payload)}::jsonb, true
			)
			on conflict (signature) do nothing
		`;
	} catch (err) {
		if (err?.code !== '23505') throw err;
	}

	return { status: 'minted', signature };
}
