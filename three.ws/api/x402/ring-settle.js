// POST /api/x402/ring-settle
//
// Internal settlement primitive for the closed-loop agent-to-agent economy.
//
// The platform's ring payer wallets pay THIS endpoint (recipient = our treasury,
// X402_PAY_TO_SOLANA) in real USDC, settled by the self-hosted facilitator
// (api/x402-facilitator). It exists so ring volume can use a SINGLE, price-
// configurable call instead of raising the price of real product endpoints:
//
//   FEE ECONOMICS — the Solana network fee is ~flat per transaction (~$0.002),
//   independent of payment size, so ring cost scales with tx COUNT, not volume.
//   To generate $X of gross volume for the least SOL, make FEWER, LARGER payments.
//   Tune the per-call size with X402_PRICE_RING_SETTLE (atomics, 6dp). Default is
//   a deliberately large $0.10 so a handful of calls, not thousands, move real
//   money. At $1.00/call, $10k of volume costs ~$20 of SOL; at $0.001/call the
//   same $10k would cost ~$20,000 of SOL. Bigger calls, smaller burn.
//
// discoverable:false — this is an INTERNAL primitive. It is deliberately NOT
// advertised on the public x402 bazaar / agentic.market catalog: ring volume is
// dogfooding, not organic third-party demand, and must not masquerade as such.
//
// The settled response is a real receipt (a signed economic tick) so the call is
// a genuine paid service invocation, not a naked money move.

import crypto from 'node:crypto';

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { priceFor } from '../_lib/x402-prices.js';
import { RING_SETTLE_DEFAULT_PRICE_ATOMICS } from '../_lib/x402/ring-constants.js';

const ROUTE = '/api/x402/ring-settle';

// Default $1.00 — deliberately large so ring volume uses FEW transactions (fee
// scales with tx count, not size). Raise X402_PRICE_RING_SETTLE to $10–$100 for
// near-zero SOL burn; lower it only if you want more, smaller settlements. The
// literal lives in ring-constants.js so the volume cap and the config validator
// read the same source of truth.
const DEFAULT_PRICE_ATOMICS = RING_SETTLE_DEFAULT_PRICE_ATOMICS;

const DESCRIPTION =
	'three.ws internal ring-settlement primitive. Platform-controlled agent ' +
	'wallets pay this endpoint in USDC to cycle the closed-loop agent economy; ' +
	'the settled response is a signed economic tick receipt. Price is operator-' +
	'configurable (X402_PRICE_RING_SETTLE) so ring volume uses fewer, larger ' +
	'payments and burns minimal SOL. Not a public service.';

const INPUT_EXAMPLE = { note: 'ring-cycle', seq: 1 };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		note: { type: 'string', description: 'Optional label echoed into the receipt.' },
		seq: { type: 'integer', description: 'Optional caller sequence number, echoed back.' },
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	kind: 'ring-tick',
	receiptId: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
	note: 'ring-cycle',
	seq: 1,
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '100000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	settledAt: '2026-07-01T18:42:09.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'kind', 'receiptId', 'settledAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		kind: { type: 'string', const: 'ring-tick' },
		receiptId: { type: 'string', format: 'uuid' },
		note: { type: ['string', 'null'] },
		seq: { type: ['integer', 'null'] },
		payer: { type: ['string', 'null'] },
		network: { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
		settledAt: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: false,
	info: {
		input: { type: 'http', method: 'POST', body: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('ring-settle', DEFAULT_PRICE_ATOMICS),
	networks: ['solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	// No SIWX free-retrigger: every ring call must be a real settled payment, or
	// the volume would be a signature bypass instead of an on-chain cycle.
	async handler({ req, requirement, payer }) {
		const body = req.body && typeof req.body === 'object' ? req.body : {};
		return {
			ok: true,
			kind: 'ring-tick',
			receiptId: crypto.randomUUID(),
			note: typeof body.note === 'string' ? body.note.slice(0, 120) : null,
			seq: Number.isInteger(body.seq) ? body.seq : null,
			payer: payer ?? null,
			network: requirement?.network ?? null,
			amountAtomics: requirement?.amount ?? null,
			asset: requirement?.asset ?? null,
			settledAt: new Date().toISOString(),
		};
	},
});
