// Integration tests for SIWX opt-in on api/_lib/x402-paid-endpoint.js.
//
// Exercises the full paidEndpoint() wrapper end-to-end with a stubbed Vercel
// req/res so we cover both the 402 body shape (extension advertised, nonce
// + supportedChains present) and the SIWX short-circuit (verified signature
// + recorded grant → 200, otherwise 402 / 401). Uses a real Solana keypair so
// the message construction + Ed25519 signature path runs end-to-end against
// the upstream @x402/extensions/sign-in-with-x verifier.
//
// DATABASE_URL is required (the storage adapter writes through to Neon).
// Tests scope rows under a per-run resource prefix so concurrent CI runs and
// failed prior runs don't poison each other.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, it, expect, afterAll, beforeEach } from 'vitest';

import { paidEndpoint } from '../../api/_lib/x402-paid-endpoint.js';
import { sql } from '../../api/_lib/db.js';
import { siwxStorage } from '../../api/_lib/siwx-storage.js';
import {
	SIGN_IN_WITH_X,
	createSIWxPayload,
	encodeSIWxHeader,
} from '@x402/extensions/sign-in-with-x';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const HAS_DB = !!process.env.DATABASE_URL;
const itDb = HAS_DB ? it : it.skip;

const RUN_TAG = `siwx-it-${crypto.randomUUID()}`;
const ROUTE_BASE = `/__test__/siwx-${RUN_TAG.slice(0, 12)}`;

function mockReqRes({ method = 'GET', headers = {}, url = ROUTE_BASE } = {}) {
	const lowerHeaders = {};
	for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
	const req = Object.assign(new Readable({ read() {} }), {
		method,
		url,
		headers: lowerHeaders,
		connection: { remoteAddress: '127.0.0.1' },
		socket: { remoteAddress: '127.0.0.1' },
	});
	req.push(null);
	const chunks = [];
	const resHeaders = {};
	const res = {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) {
			resHeaders[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return resHeaders[k.toLowerCase()];
		},
		end(body) {
			if (body !== undefined) chunks.push(body);
			res.writableEnded = true;
		},
		write(chunk) {
			chunks.push(chunk);
		},
		get body() {
			return chunks.join('');
		},
		get headers() {
			return resHeaders;
		},
	};
	return { req, res };
}

function decodeChallenge(res) {
	return JSON.parse(
		Buffer.from(String(res.getHeader('payment-required')), 'base64').toString('utf8'),
	);
}

function makeHandler() {
	return async ({ siwx }) => ({ ok: true, served: 'plain', siwx: siwx?.address ?? null });
}

const HANDLER_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'object', properties: {}, required: [] },
		output: { type: 'object', properties: { ok: { type: 'boolean' } } },
	},
	schema: { type: 'object' },
};

function makeEndpoint({ siwx, route }) {
	return paidEndpoint({
		route,
		method: 'GET',
		networks: ['solana'],
		description: 'siwx integration test',
		bazaar: HANDLER_BAZAAR,
		handler: makeHandler(),
		siwx,
	});
}

// Sign a SIWX payload with @solana/web3.js Keypair using the wallet-adapter
// signer shape the SDK accepts (publicKey + signMessage(Uint8Array)).
function solanaAdapterSigner(kp) {
	return {
		publicKey: bs58.encode(kp.publicKey.toBytes()),
		signMessage: async (msg) => nacl.sign.detached(msg, kp.secretKey),
	};
}

async function signSiwxFromChallenge(challenge, signer, chainId) {
	const info = challenge.extensions[SIGN_IN_WITH_X].info;
	const completeInfo = { ...info, chainId, type: 'ed25519' };
	// The client binds the challenge to the origin it was served from, so the
	// request URL is the challenge's own uri.
	const payload = await createSIWxPayload(completeInfo, signer, info.uri);
	return encodeSIWxHeader(payload);
}

function describeIfDb(name, fn) {
	if (HAS_DB) return describe(name, fn);
	return describe.skip(name, fn);
}

describeIfDb('paidEndpoint() with siwx opt-in', () => {
	afterAll(async () => {
		await sql`delete from siwx_payments where resource like ${'%' + RUN_TAG + '%'}`;
		await sql`delete from siwx_nonces   where resource like ${'%' + RUN_TAG + '%'}`;
	});

	it('without siwx: no sign-in-with-x extension in the 402 body', async () => {
		const route = `${ROUTE_BASE}/no-siwx`;
		const handler = paidEndpoint({
			route,
			networks: ['solana'],
			description: 'no siwx',
			bazaar: HANDLER_BAZAAR,
			handler: makeHandler(),
		});
		const { req, res } = mockReqRes({ url: route });
		await handler(req, res);
		expect(res.statusCode).toBe(402);
		const body = decodeChallenge(res);
		expect(body.extensions[SIGN_IN_WITH_X]).toBeUndefined();
	});

	it('with siwx: 402 body declares the sign-in-with-x extension', async () => {
		const route = `${ROUTE_BASE}/declared`;
		const handler = makeEndpoint({
			route,
			siwx: { statement: 'sign to re-access', ttlSeconds: null },
		});
		const { req, res } = mockReqRes({ url: route });
		await handler(req, res);
		expect(res.statusCode).toBe(402);
		const body = decodeChallenge(res);
		const ext = body.extensions[SIGN_IN_WITH_X];
		expect(ext).toBeTruthy();
		expect(ext.info.statement).toBe('sign to re-access');
		expect(typeof ext.info.nonce).toBe('string');
		expect(ext.info.nonce.length).toBeGreaterThanOrEqual(16);
		expect(typeof ext.info.issuedAt).toBe('string');
		expect(Array.isArray(ext.supportedChains)).toBe(true);
		expect(ext.supportedChains.length).toBeGreaterThanOrEqual(1);
		expect(ext.supportedChains.some((c) => c.chainId.startsWith('solana:'))).toBe(true);
	});

	it('valid signature + no prior grant → 402 siwx_not_paid', async () => {
		const route = `${ROUTE_BASE}/no-grant`;
		const handler = makeEndpoint({
			route,
			siwx: { statement: 'gated', ttlSeconds: null },
		});
		const { req: req1, res: res1 } = mockReqRes({ url: route });
		await handler(req1, res1);
		const challenge = decodeChallenge(res1);

		const kp = Keypair.generate();
		const signer = solanaAdapterSigner(kp);
		const chainId = challenge.extensions[SIGN_IN_WITH_X].supportedChains.find((c) =>
			c.chainId.startsWith('solana:'),
		).chainId;
		const headerVal = await signSiwxFromChallenge(challenge, signer, chainId);

		const { req: req2, res: res2 } = mockReqRes({
			url: route,
			headers: { 'sign-in-with-x': headerVal },
		});
		await handler(req2, res2);
		expect(res2.statusCode).toBe(402);
		const body = decodeChallenge(res2);
		expect(body.error).toMatch(/has not paid/i);
	});

	itDb('valid signature + recorded grant → 200 with handler body', async () => {
		const route = `${ROUTE_BASE}/granted`;
		const handler = makeEndpoint({
			route,
			siwx: { statement: 'gated', ttlSeconds: null },
		});

		// First call: fetch the 402 challenge so the SDK can pin nonce/issuedAt.
		const { req: req1, res: res1 } = mockReqRes({ url: route });
		await handler(req1, res1);
		const challenge = decodeChallenge(res1);

		// Now sign with a fresh Solana keypair and pre-record the grant under
		// the (resource, address) pair the verified signature will produce.
		const kp = Keypair.generate();
		const signer = solanaAdapterSigner(kp);
		const address = bs58.encode(kp.publicKey.toBytes());
		const chainId = challenge.extensions[SIGN_IN_WITH_X].supportedChains.find((c) =>
			c.chainId.startsWith('solana:'),
		).chainId;
		const resourceUrl = challenge.resource.url;
		await siwxStorage.recordPayment(resourceUrl, address, { network: chainId });

		const headerVal = await signSiwxFromChallenge(challenge, signer, chainId);
		const { req: req2, res: res2 } = mockReqRes({
			url: route,
			headers: { 'sign-in-with-x': headerVal },
		});
		await handler(req2, res2);
		expect(res2.statusCode).toBe(200);
		expect(res2.getHeader('x-siwx-address')).toBe(address);
		const parsed = JSON.parse(res2.body);
		expect(parsed.ok).toBe(true);
		expect(parsed.siwx).toBe(address);
	});

	itDb('nonce replay → second attempt rejected as siwx_message_invalid', async () => {
		const route = `${ROUTE_BASE}/replay`;
		const handler = makeEndpoint({
			route,
			siwx: { statement: 'gated', ttlSeconds: null },
		});
		const { req: req1, res: res1 } = mockReqRes({ url: route });
		await handler(req1, res1);
		const challenge = decodeChallenge(res1);

		const kp = Keypair.generate();
		const signer = solanaAdapterSigner(kp);
		const address = bs58.encode(kp.publicKey.toBytes());
		const chainId = challenge.extensions[SIGN_IN_WITH_X].supportedChains.find((c) =>
			c.chainId.startsWith('solana:'),
		).chainId;
		const resourceUrl = challenge.resource.url;
		await siwxStorage.recordPayment(resourceUrl, address, { network: chainId });

		const headerVal = await signSiwxFromChallenge(challenge, signer, chainId);
		const { req: r2, res: s2 } = mockReqRes({
			url: route,
			headers: { 'sign-in-with-x': headerVal },
		});
		await handler(r2, s2);
		expect(s2.statusCode).toBe(200);

		const { req: r3, res: s3 } = mockReqRes({
			url: route,
			headers: { 'sign-in-with-x': headerVal },
		});
		await handler(r3, s3);
		expect(s3.statusCode).toBe(401);
		const replayBody = JSON.parse(s3.body);
		expect(replayBody.error).toBe('siwx_message_invalid');
	});
});
