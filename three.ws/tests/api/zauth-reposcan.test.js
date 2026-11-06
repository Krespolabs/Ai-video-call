// Tests for /api/zauth-reposcan — the same-origin pass-through that lets the
// in-game wallet modal pay zauth's RepoScan x402 endpoint.
//
// Pure-logic only — we exercise the exported helpers (normalizeEnvelope and
// the input guards) rather than the HTTP wrapper, keeping tests off the
// network while covering the envelope translation a settled payment depends
// on (verified live 2026-06-12: zauth only reads `payment-signature`, with
// resource.url pointing at THEIR endpoint).
//
// Coverage:
//   • normalizeEnvelope rewrites resource.url to the upstream URL
//   • strips the modal's extra top-level fields (scheme/network/extensions)
//   • preserves payload + accepted byte-for-byte (the signed transfer)
//   • passes non-base64 / non-envelope values through untouched
//   • REPO_RE accepts owner/repo shapes and rejects traversal/URL injection
//   • SESSION_RE accepts JWT-style tokens, rejects path metacharacters

import { describe, it, expect } from 'vitest';
import { normalizeEnvelope, REPO_RE, SESSION_RE } from '../../api/zauth-reposcan.js';

const UPSTREAM = 'https://api.zauth.inc/x402/reposcan';

const accepted = {
	scheme: 'exact',
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	amount: '50000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	payTo: 'ZAU64eKWAgiGNux8bzvgRn8RvWqFhdMVrpJytF7V1qm',
	maxTimeoutSeconds: 300,
	extra: { feePayer: 'ZAU64eKWAgiGNux8bzvgRn8RvWqFhdMVrpJytF7V1qm' },
};

// What public/x402.js + api/x402-checkout handleEncode actually emit.
const modalEnvelope = {
	x402Version: 2,
	scheme: 'exact',
	network: accepted.network,
	resource: { url: 'https://three.ws/api/zauth-reposcan', mimeType: 'application/json' },
	accepted,
	payload: { transaction: 'AQa1b2c3signedtransferbytes==' },
	extensions: { 'builder-code': { code: 'three' } },
};

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const decode = (b64) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

describe('normalizeEnvelope — modal → zauth translation', () => {
	it('rewrites resource.url to the upstream endpoint', () => {
		const out = decode(normalizeEnvelope(encode(modalEnvelope)));
		expect(out.resource.url).toBe(UPSTREAM);
		expect(out.resource.mimeType).toBe('application/json');
	});

	it('strips the extra top-level fields the modal adds', () => {
		const out = decode(normalizeEnvelope(encode(modalEnvelope)));
		expect(out).not.toHaveProperty('scheme');
		expect(out).not.toHaveProperty('network');
		expect(out).not.toHaveProperty('extensions');
		expect(Object.keys(out).sort()).toEqual(['accepted', 'payload', 'resource', 'x402Version']);
	});

	it('preserves the signed payload and accepted entry exactly', () => {
		const out = decode(normalizeEnvelope(encode(modalEnvelope)));
		expect(out.payload).toEqual(modalEnvelope.payload);
		expect(out.accepted).toEqual(accepted);
		expect(out.x402Version).toBe(2);
	});

	it('defaults x402Version to 2 and omits accepted when absent', () => {
		const out = decode(normalizeEnvelope(encode({ payload: { transaction: 'x' } })));
		expect(out.x402Version).toBe(2);
		expect(out).not.toHaveProperty('accepted');
	});

	it('passes non-envelope values through untouched', () => {
		expect(normalizeEnvelope('not-base64-json!!')).toBe('not-base64-json!!');
		const noPayload = encode({ hello: 'world' });
		expect(normalizeEnvelope(noPayload)).toBe(noPayload);
	});
});

describe('input guards', () => {
	it('REPO_RE accepts real owner/repo shapes', () => {
		for (const ok of ['nirholas/three.ws', 'a/b', 'octo-cat/Hello.World_2']) {
			expect(ok).toMatch(REPO_RE);
		}
	});

	it('REPO_RE rejects URLs, traversal, and missing parts', () => {
		for (const bad of [
			'https://github.com/owner/repo',
			'owner/repo/extra',
			'owner',
			'../etc/passwd',
			'owner/repo?x=1',
			'-leadinghyphen/repo',
			'owner/re po',
		]) {
			expect(bad).not.toMatch(REPO_RE);
		}
	});

	it('SESSION_RE accepts JWT-style tokens and rejects path injection', () => {
		expect('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-part_1').toMatch(SESSION_RE);
		expect('short').not.toMatch(SESSION_RE);
		expect('abc/def/../escape').not.toMatch(SESSION_RE);
		expect('token with spaces').not.toMatch(SESSION_RE);
	});
});
