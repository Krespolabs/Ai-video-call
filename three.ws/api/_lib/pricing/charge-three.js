// charge-three — the one helper every paid surface uses to charge in $THREE.
//
// It wraps the token rail (api/_lib/token: issueQuote → verifyAndSettlePayment)
// so an endpoint never reimplements quoting or on-chain verification. Two phases:
//
//   1. CHARGE  — no payment yet → price the action from the catalog, issue a
//                signed $THREE quote, return { paid:false, quote }. The client
//                pays it (src/token-pay.js builds the multi-leg tx) and retries
//                with the quote token + tx signature.
//   2. SETTLE  — payment present → verify the on-chain tx satisfies the quote,
//                record it, return { paid:true, payment }. Only then does the
//                endpoint do the real (costly) work.
//
// FREE-FOREVER GUARDRAIL: a hard allowlist of growth surfaces that must NEVER be
// gated. requireThreePayment() refuses to gate any of them — a misconfiguration
// that tries to charge for one throws a loud developer error rather than quietly
// putting a paywall in front of the funnel.

import {
	issueQuote,
	verifyAndSettlePayment,
	allowanceEnabled,
	pullFromAllowance,
	recordAllowancePayment,
} from '../token/index.js';
import { catalogEntry, priceForAction, POLICY, CATALOG } from './catalog.js';
import { recordUsageSafe } from '../metering.js';

// Meter a SETTLED $THREE charge into the usage ledger. Derives the USDC-atomic
// price and the holder discount actually applied from the (discounted) quote.usd
// vs the catalog's full price, then records one idempotent row keyed by the
// settlement id — so a retried settlement meters exactly once. Never throws, so
// a ledger hiccup can never fail a charge the user already paid for; the
// reconciliation pass catches anything that slips through unmetered.
async function meterSettledCharge({ action, quoteUsd, userId, agentId, settlementRef }) {
	if (!settlementRef) return;
	const full = CATALOG[action]?.usd ?? null;
	const usd = Number(quoteUsd) || 0;
	const priceUsdcAtomics = Math.round(usd * 1_000_000);
	// Recover the discount that was applied to reach the quoted price (fixed-price
	// actions only — variable/marketplace prices carry no holder discount).
	let discountBps = 0;
	if (full != null && full > 0 && usd > 0 && usd < full) {
		discountBps = Math.max(0, Math.min(10000, Math.round((1 - usd / full) * 10000)));
	}
	await recordUsageSafe({
		userId: userId ?? null,
		agentId: agentId ?? null,
		action,
		units: 1,
		priceUsdcAtomics,
		discountBps,
		settlementRef: String(settlementRef),
		settlementKind: 'three',
	});
}

// Surfaces that are free forever (the growth funnel). These are NOT catalog
// actions — they have no price — but they're listed explicitly so the guardrail
// is self-documenting and a stray charge attempt fails fast and obviously.
export const FREE_SURFACES = Object.freeze(
	new Set([
		// Creation & configuration
		'agent.create',
		'agent.configure',
		// Discovery
		'marketplace.browse',
		'gallery.browse',
		'launches.feed',
		'community.browse',
		'agent.lookup',
		'visualizer.view',
		// Embedding
		'embed.web_component',
		'widget.studio',
		'examples.view',
		// Social
		'friends',
		'presence',
		'dm',
		'chat.free', // the free LLM tier (Groq / free-first)
		// Basic worlds (baseline access)
		'world.walk',
		'world.city',
		'world.communities',
		// Free generation lane (NVIDIA NIM draft) — the always-free draft tier
		'forge.draft',
		'mcp3d.generate.free',
		// Developer surfaces
		'docs',
		'tutorials',
		'sdk',
		'openapi',
		'status',
		'vanity.grinder',
		// Common (non-rare) names mint free; only rare names are auctioned.
		'name.common',
	]),
);

/** True when the surface is on the free-forever allowlist. */
export function isFreeSurface(surfaceId) {
	return FREE_SURFACES.has(surfaceId);
}

/**
 * Charge (or settle) a $THREE payment for a catalog action.
 *
 * @param {object} params
 * @param {string} params.action            a CATALOG key (api/_lib/pricing/catalog.js)
 * @param {object|null} [params.user]       the authenticated session user
 * @param {number} [params.usd]             per-call price for variable actions (usd:null in catalog)
 * @param {number} [params.discountBps]     holder-tier fee discount in bps (Lever 2 supplies this)
 * @param {string|null} [params.sellerWallet]  required for POLICY.MARKETPLACE actions
 * @param {string|null} [params.refType]    audit link (e.g. 'forge', 'skill')
 * @param {string|null} [params.refId]      audit id (e.g. the job / listing id)
 * @param {'mainnet'|'devnet'} [params.network]
 * @param {{ quoteToken?: string, txSignature?: string, payerWallet?: string }} [params.settle]
 *        when present with both fields, verifies + records the on-chain payment.
 * @returns {Promise<
 *   | { paid: false, quote: object }
 *   | { paid: true, payment: object }
 * >}
 */
export async function requireThreePayment({
	action,
	user = null,
	usd,
	discountBps = 0,
	sellerWallet = null,
	refType = null,
	refId = null,
	network = 'mainnet',
	settle = null,
}) {
	// Guardrail: never gate a free-forever surface, even by mistake.
	if (FREE_SURFACES.has(action)) {
		throw Object.assign(
			new Error(
				`[charge-three] refusing to gate "${action}" — it is on the free-forever allowlist. ` +
					'Free surfaces must never require payment.',
			),
			{ status: 500, code: 'free_surface_gated' },
		);
	}

	const entry = catalogEntry(action); // throws 404 unknown_action for non-catalog ids
	const priced = priceForAction(action, { usd, discountBps });
	const requiresSeller = entry.policy === POLICY.MARKETPLACE;
	if (requiresSeller && !sellerWallet) {
		throw Object.assign(new Error(`action ${action} requires a seller wallet`), {
			status: 400,
			code: 'seller_required',
		});
	}

	// ── SETTLE phase ────────────────────────────────────────────────────────────
	if (settle && settle.quoteToken && settle.txSignature) {
		const result = await verifyAndSettlePayment({
			quoteToken: settle.quoteToken,
			txSignature: settle.txSignature,
			payerWallet: settle.payerWallet ?? user?.wallet_address ?? null,
			userId: user?.id ?? null,
			network,
		});
		// Meter the settled charge into the usage ledger (idempotent on the
		// settlement id). result.quote.usd is the holder-discounted price actually
		// quoted; result.payment_id is the token_payments row this usage is paid by.
		await meterSettledCharge({
			action,
			quoteUsd: result?.quote?.usd,
			userId: user?.id ?? null,
			settlementRef: result?.payment_id,
		});
		return { paid: true, payment: result };
	}

	// ── CHARGE phase ──────────────────────────────────────────────────────────────
	const { token, quote, expiresAt } = await issueQuote({
		purpose: action,
		usd: priced.usd,
		splitPolicy: priced.policy,
		sellerWallet,
		network,
		refType: refType ?? action,
		refId,
	});

	// Allowance fast path: if the user pre-authorized a $THREE spend cap (Solana
	// native Subscriptions program) and the platform delegate is configured, pull
	// the charge with NO wallet popup — same price, same split legs, same on-chain
	// record. Any miss (no allowance, cap too low, degraded RPC) falls through to
	// the signed quote below, so this is strictly additive and never blocks a pay.
	const payerWallet = user?.wallet_address ?? null;
	if (payerWallet && (await allowanceEnabled())) {
		try {
			const pull = await pullFromAllowance({ userWallet: payerWallet, legs: quote.legs, network });
			const record = await recordAllowancePayment({
				quote,
				txSignature: pull.signature,
				network,
				payerWallet,
				userId: user?.id ?? null,
				slot: pull.slot,
			});
			// Meter the allowance-rail charge too — same ledger, same idempotency
			// guarantee (keyed by the token_payments id), so both rails reconcile.
			await meterSettledCharge({
				action,
				quoteUsd: quote.usd,
				userId: user?.id ?? null,
				settlementRef: record.id,
			});
			return {
				paid: true,
				via: 'allowance',
				payment: {
					payment_id: record.id,
					replay: record.replay,
					tx_signature: pull.signature,
					total_atomics: quote.total,
					legs: quote.legs,
					slot: pull.slot,
				},
			};
		} catch (err) {
			// insufficient_allowance is the expected "not enough cap" signal — fall
			// back silently. Anything else, log once and still fall back so a flaky
			// allowance path can never strand a user who could pay the normal way.
			if (err?.code !== 'insufficient_allowance') {
				console.warn(`[charge-three] allowance pull failed for ${action}, falling back to quote:`, err?.message || err);
			}
		}
	}

	return {
		paid: false,
		quote: {
			quote_token: token,
			action,
			label: priced.label,
			category: priced.category,
			policy: priced.policy,
			network: quote.network,
			mint: quote.mint,
			symbol: quote.symbol,
			decimals: quote.decimals,
			usd: quote.usd,
			price_usd: quote.priceUsd,
			price_source: quote.priceSource,
			total_atomics: quote.total,
			legs: quote.legs,
			memo: quote.nonce,
			expires_at: expiresAt,
		},
	};
}
