// GET /api/x402/billboard?coin=<mint>&image=<url>&caption=<text>
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For a flat USDC/$THREE fee
// the caller features their content on a 3D coin-world's billboard — the framed
// panel src/walk.js stands behind spawn — for a fixed rental window. Whoever
// pays most recently holds the board until the slot expires.
//
// This is a paid community canvas, not an ad unit: nothing is targeted or
// tracked, the panel just shows one image and/or caption. The /temporary coin
// world reads the active placement from /api/billboard and renders it in place
// of the world's default content. Agents can call this programmatically with
// @x402/fetch to put their own art (or a coin's image) on a world's board.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { setPlacement, sanitizeImageUrl, sanitizeCaption, isValidCoin, SLOT_HOURS } from '../_lib/billboard-store.js';
import billboardListing from '../_lib/service-catalog/services/billboard.js';

const ROUTE = '/api/x402/billboard';

// Single source of truth: api/_lib/service-catalog/services/billboard.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js). SLOT_HOURS is still
// imported above for the actual placement TTL the handler writes.
const DESCRIPTION = billboardListing.description;

const INPUT_EXAMPLE = {
	coin: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	image: 'https://three.ws/og-image.png',
	caption: 'gm from the gallery',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['coin'],
	properties: {
		coin: {
			type: 'string',
			pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
			description: 'The coin-world mint — which world’s billboard to set.',
		},
		image: {
			type: 'string',
			format: 'uri',
			description: 'http/https image URL, cover-fit onto the panel. Optional if a caption is given.',
		},
		caption: {
			type: 'string',
			maxLength: 80,
			description: 'Short caption shown in a strip under the image. Optional if an image is given.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	coin: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	image: 'https://three.ws/og-image.png',
	caption: 'gm from the gallery',
	slotHours: SLOT_HOURS,
	startsAt: '2026-06-28T18:42:09.000Z',
	endsAt: '2026-06-29T00:42:09.000Z',
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '50000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'coin', 'slotHours', 'startsAt', 'endsAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		coin: { type: 'string' },
		image: { type: ['string', 'null'] },
		caption: { type: ['string', 'null'] },
		slotHours: { type: 'integer', minimum: 1, maximum: 24 },
		startsAt: { type: 'string', format: 'date-time' },
		endsAt: { type: 'string', format: 'date-time' },
		payer: { type: ['string', 'null'] },
		network: { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export const BAZAAR_SCHEMA = BAZAAR;

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	// Flat fee for one slot. $0.05 USDC default — a placement is more than a tip
	// but kept low so featuring content stays accessible.
	priceAtomics: priceFor('billboard', '50000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Coin-World Billboard',
		tags: ['3d', 'world', 'billboard', 'content', 'placement'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req, requirement, payer, bypass }) {
		const coin = String(req.query?.coin || '').trim();
		if (!isValidCoin(coin)) {
			const err = new Error('a valid coin-world mint is required in ?coin=');
			err.status = 400;
			err.code = 'invalid_coin';
			throw err;
		}
		const image = sanitizeImageUrl(req.query?.image);
		const caption = sanitizeCaption(req.query?.caption);
		if (!image && !caption) {
			const err = new Error('provide ?image=<url> and/or ?caption=<text> to display');
			err.status = 400;
			err.code = 'empty_content';
			throw err;
		}

		const rec = await setPlacement(coin, {
			image,
			caption,
			payer: payer ?? (bypass ? bypass.callerId : null),
			network: requirement?.network ?? null,
			amountAtomics: requirement?.amount ?? null,
			asset: requirement?.asset ?? null,
			hours: SLOT_HOURS,
		});

		const out = {
			ok: true,
			coin: rec.coin,
			image: rec.image,
			caption: rec.caption,
			slotHours: SLOT_HOURS,
			startsAt: rec.startsAt,
			endsAt: rec.endsAt,
			payer: rec.payer,
			network: rec.network,
			amountAtomics: rec.amountAtomics,
			asset: rec.asset,
		};
		if (bypass) out.bypass = bypass.reason;
		return out;
	},
});
