// Remix royalty settlement — the real creator-payout leg (PAID track only).
//
// When an agent remixes another creator's published asset, it pays the full
// remix fee in USDC to the platform via x402 (single-recipient, as the x402 rail
// requires). The platform then routes the creator's royalty slice on-chain from
// its payout wallet to the original creator — a SECOND, real USDC transfer, not a
// fake ledger entry. This module is that second leg: it takes the settled fee,
// applies the pure split math (api/_lib/remix-royalty.js), pays the creator, and
// records the settlement onto the SOURCE creation as append-only provenance.
//
// Split + caps are pure and unit-tested; the payout wallet + on-chain send reuse
// the same audited rails as the vanity bounty payout (transferSolanaUSDC from the
// platform treasury). $THREE-policy clean: USDC is the settlement asset only; no
// other coin is named.

import bs58 from 'bs58';

import { transferSolanaUSDC } from './solana-transfer.js';
import { SOLANA_USDC_MINT } from '../payments/_config.js';
import { computeRemixSplit, REMIX_ROYALTY_DEFAULT_BPS } from './remix-royalty.js';
import { recordRemixSettlement } from './forge-store.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Resolve the platform's royalty payout wallet as a Base58 64-byte secret. A
// dedicated REMIX_ROYALTY_PAYOUT_KEY is preferred; the shared club treasury
// secret is the fallback (same wallet the vanity bounty market pays from). Both
// are validated to decode to 64 bytes so a misconfig fails loud, never on-chain.
// Exported so other real-royalty settlement flows (e.g. a tokenized-3D remix
// mint, api/_lib/tokenize-3d.js) reuse the SAME payout wallet resolution
// instead of re-deriving it — one source of truth for "who pays creator
// royalties on this platform."
export function resolvePayoutKeyBase58() {
	const dedicated = process.env.REMIX_ROYALTY_PAYOUT_KEY;
	if (dedicated && dedicated.trim()) {
		const s = dedicated.trim();
		try {
			if (bs58.decode(s).length === 64) return s;
		} catch {
			/* not Base58 — try base64 below */
		}
		try {
			const raw = Buffer.from(s, 'base64');
			if (raw.byteLength === 64) return bs58.encode(raw);
		} catch {
			/* ignore */
		}
	}
	const clubB64 = process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	if (clubB64) {
		try {
			const raw = Buffer.from(clubB64, 'base64');
			if (raw.byteLength === 64) return bs58.encode(raw);
		} catch {
			/* ignore */
		}
	}
	return null;
}

/** True when the platform can actually route a royalty on-chain. */
export function royaltyPayoutConfigured() {
	return !!resolvePayoutKeyBase58();
}

/**
 * Settle a creator royalty for a remix that has already had its fee collected.
 * Computes the split, and — when there IS a royalty to pay and the creator has a
 * valid payout wallet and the platform payout wallet is configured — sends the
 * creator's slice on-chain and records it on the source. Every non-paying outcome
 * is reported honestly with a reason (never a fake "pending"): a source with no
 * payout wallet, a sub-dust royalty, or an unconfigured platform wallet all
 * return `paid: false` with the split still computed for transparency.
 *
 * @param {object} p
 * @param {object} p.source           getRemixSource() result (id, creatorWallet, royaltyBps).
 * @param {bigint|number|string} p.priceAtomics  the remix fee actually collected, in USDC atomics.
 * @param {string} [p.remixCreationId] the derived creation this royalty is for.
 * @returns {Promise<{
 *   split: object, royaltyBps:number, requestedBps:number, capped:boolean, dust:boolean,
 *   creatorUsd:number, platformUsd:number, creatorAtomics:string, platformAtomics:string,
 *   paid:boolean, reason?:string, creatorTx?:string, settlement?:object }>}
 */
export async function settleRemixRoyalty({ source, priceAtomics, remixCreationId }) {
	const split = computeRemixSplit({
		priceAtomics,
		royaltyBps: source?.royaltyBps ?? REMIX_ROYALTY_DEFAULT_BPS,
	});
	const summary = {
		split,
		royaltyBps: split.royaltyBps,
		requestedBps: split.requestedBps,
		capped: split.capped,
		dust: split.dust,
		creatorUsd: split.creatorUsd,
		platformUsd: split.platformUsd,
		creatorAtomics: split.creatorAtomics.toString(),
		platformAtomics: split.platformAtomics.toString(),
	};

	const creatorWallet = source?.creatorWallet;
	if (!creatorWallet || !BASE58_RE.test(String(creatorWallet))) {
		return { ...summary, paid: false, reason: 'no_creator_wallet' };
	}
	if (split.creatorAtomics <= 0n) {
		return { ...summary, paid: false, reason: split.dust ? 'below_dust_floor' : 'zero_royalty' };
	}
	const fromWallet = resolvePayoutKeyBase58();
	if (!fromWallet) {
		return { ...summary, paid: false, reason: 'payout_unconfigured' };
	}

	const sig = await transferSolanaUSDC({
		fromWallet,
		toAddress: creatorWallet,
		amount: split.creatorAtomics,
		mint: SOLANA_USDC_MINT,
	});
	const settlement = {
		tx_signature: sig,
		usdc_atomics: split.creatorAtomics.toString(),
		creator_wallet: creatorWallet,
		royalty_bps: split.royaltyBps,
		remix_creation_id: remixCreationId ?? null,
		settled_at: new Date().toISOString(),
	};
	await recordRemixSettlement({ sourceCreationId: source.id, settlement });
	return { ...summary, paid: true, creatorTx: sig, settlement };
}
