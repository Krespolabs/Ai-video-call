// The live x402 probe applies the checklist a marketplace validator runs against
// an unpaid request. These cases pin the verdicts that matter: a non-402 answer
// (what the 2026-09-18 import outage looked like from outside), an oversized
// body, and a 402 whose Bazaar block a catalog would reject.

import { describe, it, expect } from 'vitest';
import { routeKey, sampleRoutes, rebase, checkResponse } from '../scripts/probe-x402-live.mjs';
import { declareHttpDiscovery } from '../api/_lib/x402/bazaar-helpers.js';

const URL_ = 'https://three.ws/api/x402/token-intel';

function challenge(overrides = {}) {
	return {
		x402Version: 2,
		resource: { url: URL_, description: 'token intel', mimeType: 'application/json' },
		accepts: [
			{
				scheme: 'exact',
				network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
				asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				amount: '10000',
				payTo: 'THREEsynthetic11111111111111111111111111111',
				maxTimeoutSeconds: 60,
				extra: { name: 'USDC', decimals: 6 },
			},
		],
		extensions: { bazaar: declareHttpDiscovery({ method: 'GET', input: { mint: 'abc' }, output: { example: { ok: true } } }) },
		...overrides,
	};
}

function respond(body, { status = 402, header = true } = {}) {
	const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
	return checkResponse({
		url: URL_,
		status,
		bodyBytes: Buffer.byteLength(bodyText),
		bodyText,
		paymentRequiredHeader: header ? Buffer.from(bodyText).toString('base64') : null,
	});
}

describe('route sampling', () => {
	it('collapses the parameterised datapoint catalog to one sample per handler', () => {
		expect(routeKey('https://three.ws/api/x402/d/coin/bitcoin?x=1')).toBe('/api/x402/d/coin');
		expect(routeKey('https://three.ws/api/x402/forge')).toBe('/api/x402/forge');
		const targets = sampleRoutes([
			{ url: 'https://three.ws/api/x402/d/coin/bitcoin', method: 'GET' },
			{ url: 'https://three.ws/api/x402/d/coin/ethereum', method: 'GET' },
			{ url: 'https://three.ws/api/mcp', method: 'POST', extensions: { bazaar: { info: { input: { body: { jsonrpc: '2.0' } } } } } },
		]);
		expect(targets.map((t) => t.route)).toEqual(['/api/x402/d/coin', '/api/mcp']);
		expect(targets[1]).toMatchObject({ method: 'POST', body: { jsonrpc: '2.0' } });
	});

	it('rebases catalog URLs onto the probed host so a local run never tests production', () => {
		expect(rebase('https://three.ws/api/x402/d/coin/bitcoin?x=1', 'http://localhost:8080')).toBe('http://localhost:8080/api/x402/d/coin/bitcoin?x=1');
		const [target] = sampleRoutes([{ url: URL_, method: 'GET' }], { onto: 'http://localhost:8080' });
		expect(target.url).toBe('http://localhost:8080/api/x402/token-intel');
	});
});

describe('checkResponse', () => {
	it('passes a well-formed v2 challenge', () => {
		expect(respond(challenge())).toEqual({ failures: [], advisories: [] });
	});

	it('fails a route that answers 500, the shape of a handler that throws on import', () => {
		const verdict = respond({ error: 'internal_error' }, { status: 500 });
		expect(verdict.failures).toEqual(['HTTP 500, expected 402 for an unpaid request']);
	});

	it('fails an oversized body before anything else, as the validator does', () => {
		const verdict = respond('x'.repeat(70000), { status: 200 });
		expect(verdict.failures).toHaveLength(1);
		expect(verdict.failures[0]).toMatch(/over the 65536-byte limit/);
	});

	it('fails a 402 with no PAYMENT-REQUIRED header', () => {
		expect(respond(challenge(), { header: false }).failures).toEqual(['PAYMENT-REQUIRED header missing (v2 delivers PaymentRequired there)']);
	});

	it('fails a flat pre-v2 bazaar block, which has no info for a catalog to read', () => {
		const flat = { description: 'x', input: { type: 'query', example: {} }, output: { type: 'json', example: {} }, schema: {} };
		const verdict = respond(challenge({ extensions: { bazaar: flat } }));
		expect(verdict.failures).toContain('bazaar.info missing');
		expect(verdict.failures).toContain('bazaar.info.input missing');
	});

	it('fails an info block its own schema rejects', () => {
		const bazaar = declareHttpDiscovery({ method: 'POST', input: {}, inputSchema: { type: 'object' } });
		delete bazaar.info.input.bodyType;
		const verdict = respond(challenge({ extensions: { bazaar } }));
		expect(verdict.failures.join('\n')).toMatch(/fails its own schema/);
	});

	it('fails a USDC price under the marketplace minimum and an empty accepts list', () => {
		const cheap = challenge();
		cheap.accepts[0].amount = '500';
		expect(respond(cheap).failures).toEqual(['accepts[0] prices 500 atomic USDC, under the $0.001 minimum']);
		expect(respond(challenge({ accepts: [] })).failures).toContain('accepts[] missing or empty');
	});

	it('reports a missing output example as advisory, not a failure', () => {
		const bazaar = declareHttpDiscovery({ method: 'GET', input: { mint: 'abc' } });
		expect(respond(challenge({ extensions: { bazaar } }))).toEqual({ failures: [], advisories: ['no output metadata'] });
	});
});
