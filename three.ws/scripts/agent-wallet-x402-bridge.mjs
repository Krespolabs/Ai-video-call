#!/usr/bin/env node
// agent-wallet-x402-bridge — local bridge between the /play/agent-wallet demo
// page and the three.ws agent wallet (a local Solana payer keypair).
//
// The payer secret lives in the developer's environment (A2A_PAYER_SOLANA_SECRET,
// the same convention the A2A payer uses), so a browser page can't reach it
// directly. This bridge exposes the three operations the demo needs over
// localhost HTTP:
//
//   GET  /status                 → wallet address + live SOL/USDC balances (Solana RPC)
//   GET  /quote?endpoint=<url>   → the endpoint's real 402 challenge, parsed
//   POST /pay {endpoint,method,body} → SSE stream of a REAL x402 payment:
//        challenge → signing → signed → submitting → done|error
//
// The payment is the standard x402 v2 `exact` scheme on Solana mainnet
// (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp): the bridge fetches the 402
// challenge, builds an SPL TransferChecked via the official @x402/svm scheme
// with the endpoint-advertised facilitator as fee payer, partially signs it
// with the agent wallet, then retries the request with the X-PAYMENT header.
// Settlement happens server-side at the paid endpoint via its facilitator —
// real USDC moves on Solana.
//
// Safety rails (this listens on localhost, where any local page could reach it):
//   • Target endpoints must be on an allowlisted origin (three.ws + local dev).
//   • Per-payment cap, default $0.10 USDC (X402_BRIDGE_MAX_USDC_MICROS).
//   • CORS restricted to local dev origins + *.app.github.dev.
//
// Run: node scripts/agent-wallet-x402-bridge.mjs   (or: npm run demo:agent-wallet-bridge)

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Pick up A2A_PAYER_SOLANA_SECRET / SOLANA_RPC_URL from the repo .env when
// present, without overriding anything already exported in the shell.
try {
	const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
	}
} catch {
	/* no .env — rely on the shell environment */
}

const PORT = Number(process.env.X402_BRIDGE_PORT) || 4402;
const MAX_USDC_MICROS = BigInt(process.env.X402_BRIDGE_MAX_USDC_MICROS || '100000'); // $0.10
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PAYER_SECRET =
	process.env.A2A_PAYER_SOLANA_SECRET || process.env.A2A_PAYER_SOLANA_PRIVATE_KEY || '';
const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Origins a target paid endpoint may live on. The demo pays three.ws's own
// x402 endpoints; local dev lets you point at `vercel dev`/vite proxies.
const ALLOWED_ENDPOINT_ORIGINS = (
	process.env.X402_BRIDGE_ALLOWED_ENDPOINT_ORIGINS ||
	'https://three.ws,http://localhost:3000,http://127.0.0.1:3000'
)
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

// Browser origins allowed to call the bridge (the demo page).
function corsOriginAllowed(origin) {
	if (!origin) return false;
	try {
		const u = new URL(origin);
		if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
		if (u.hostname.endsWith('.app.github.dev')) return true;
		if (origin === 'https://three.ws') return true;
		return false;
	} catch {
		return false;
	}
}

// ── agent wallet (Solana payer keypair) ────────────────────────────────────

// Decode a Solana secret key from any of the encodings used across this
// codebase: a JSON byte array (solana-keygen), base58 (Phantom export), or
// base64. Returns the 64-byte expanded secret key.
async function decodeSolanaSecret(secret) {
	const trimmed = String(secret).trim();
	if (trimmed.startsWith('[')) {
		const bytes = Uint8Array.from(JSON.parse(trimmed));
		if (bytes.length === 64) return bytes;
		throw new Error('Solana secret: malformed 64-byte JSON array');
	}
	const { default: bs58 } = await import('bs58');
	for (const decode of [() => bs58.decode(trimmed), () => new Uint8Array(Buffer.from(trimmed, 'base64'))]) {
		try {
			const bytes = decode();
			if (bytes.length === 64) return bytes;
		} catch {
			/* try the next encoding */
		}
	}
	throw new Error('Solana secret must be a 64-byte key encoded as base58, base64, or a JSON array');
}

let signerPromise = null;
function agentSigner() {
	if (!PAYER_SECRET) {
		return Promise.reject(
			new Error('agent wallet not configured — set A2A_PAYER_SOLANA_SECRET in .env or the shell'),
		);
	}
	if (!signerPromise) {
		signerPromise = (async () => {
			const { createKeyPairSignerFromBytes } = await import('@solana/kit');
			return createKeyPairSignerFromBytes(await decodeSolanaSecret(PAYER_SECRET));
		})();
		signerPromise.catch(() => {
			signerPromise = null; // let a corrected env value retry on next call
		});
	}
	return signerPromise;
}

let statusCache = null; // { at, payload }
async function walletStatus() {
	if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.payload;
	const signer = await agentSigner();
	const [{ Connection, PublicKey }, { getAssociatedTokenAddressSync }] = await Promise.all([
		import('@solana/web3.js'),
		import('@solana/spl-token'),
	]);
	const conn = new Connection(SOLANA_RPC_URL, 'confirmed');
	const owner = new PublicKey(signer.address);
	let sol = null;
	let usdc = 0;
	try {
		sol = (await conn.getBalance(owner)) / 1e9;
		const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT_SOLANA), owner);
		const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
		usdc = bal?.value?.uiAmount ?? 0; // no ATA yet → zero USDC
	} catch {
		// RPC hiccup — report the wallet without live balances rather than fail
	}
	const payload = {
		ok: true,
		wallet: {
			address: signer.address,
			mode: 'solana',
			chainNamespace: 'solana',
		},
		balance: {
			currency: 'USD',
			totalValue: usdc.toFixed(2),
			chains: [{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', sol, usdc }],
		},
	};
	statusCache = { at: Date.now(), payload };
	return payload;
}

// ── x402 client flow (Solana exact scheme, official @x402/svm) ─────────────

function endpointAllowed(endpoint) {
	try {
		const u = new URL(endpoint);
		return ALLOWED_ENDPOINT_ORIGINS.includes(u.origin);
	} catch {
		return false;
	}
}

// A co-signable Solana accept: exact scheme, Solana CAIP-2 network, and the
// facilitator fee payer the @x402/svm scheme needs to build the transaction.
function isSolanaExactAccept(a) {
	return a && a.scheme === 'exact' && String(a.network || '').startsWith('solana:') && a.extra?.feePayer;
}

async function fetch402(endpoint, method, body) {
	const res = await fetch(endpoint, {
		method,
		headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (res.status !== 402) {
		const text = (await res.text()).slice(0, 300);
		throw new Error(`expected a 402 challenge from ${endpoint}, got ${res.status}: ${text}`);
	}
	const challenge = await res.json();
	if (!Array.isArray(challenge?.accepts) || !challenge.accepts.length) {
		throw new Error('402 challenge has no accepts[] entries');
	}
	const accept = challenge.accepts.find(isSolanaExactAccept);
	if (!accept) {
		throw new Error('endpoint does not accept exact-scheme USDC on Solana');
	}
	return { challenge, accept };
}

// ERC-8021 builder-code echo — the server rejects payments that don't echo the
// declared app code. Self-attribute this bridge as the wallet/service pair.
const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
function builderCodeEcho(challenge) {
	const declaredA = challenge?.extensions?.['builder-code']?.info?.a;
	if (!declaredA || !BUILDER_CODE_PATTERN.test(declaredA)) return null;
	return { a: declaredA, w: 'threews_agent', s: ['agent_wallet_x402_bridge'] };
}

function fmtUsdc(micros) {
	return '$' + (Number(micros) / 1e6).toFixed(2);
}

async function executePayment({ endpoint, method, body, emit }) {
	// 1. Real 402 challenge from the paid endpoint.
	const { challenge, accept } = await fetch402(endpoint, method, body);
	const amount = BigInt(accept.amount);
	if (amount > MAX_USDC_MICROS) {
		throw new Error(
			`endpoint asks for ${fmtUsdc(accept.amount)} USDC, above the bridge cap of ${fmtUsdc(MAX_USDC_MICROS.toString())} (raise X402_BRIDGE_MAX_USDC_MICROS to allow)`,
		);
	}
	emit({
		stage: 'challenge',
		amount: accept.amount,
		payTo: accept.payTo,
		asset: accept.asset,
		network: accept.network,
		resource: challenge.resource || null,
	});

	// 2. The agent wallet builds + partially signs the SPL TransferChecked.
	// The endpoint-advertised extra.feePayer pays the transaction fee and is
	// co-signed by the facilitator on /settle — the agent only signs the
	// transfer authority.
	const signer = await agentSigner();
	emit({
		stage: 'signing',
		signer: signer.address,
		network: accept.network,
		mint: accept.asset,
		to: accept.payTo,
		value: accept.amount,
		feePayer: accept.extra.feePayer,
	});
	const { ExactSvmScheme } = await import('@x402/svm');
	const scheme = new ExactSvmScheme(signer, { rpcUrl: SOLANA_RPC_URL });
	const built = await scheme.createPaymentPayload(2, accept);
	emit({ stage: 'signed', signer: signer.address });

	// 3. Retry the request with the X-PAYMENT header — the endpoint verifies and
	// settles via its facilitator, then does the paid work.
	const paymentPayload = {
		x402Version: built.x402Version || 2,
		scheme: 'exact',
		network: accept.network,
		resource: { url: endpoint, mimeType: 'application/json' },
		accepted: accept,
		payload: built.payload,
	};
	const echo = builderCodeEcho(challenge);
	if (echo) paymentPayload.extensions = { 'builder-code': echo };
	emit({ stage: 'submitting' });

	const paidRes = await fetch(endpoint, {
		method,
		headers: {
			accept: 'application/json',
			'x-payment': Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64'),
			...(body ? { 'content-type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const resultText = await paidRes.text();
	let result = null;
	try {
		result = JSON.parse(resultText);
	} catch {
		result = { raw: resultText.slice(0, 1000) };
	}
	if (!paidRes.ok) {
		throw new Error(
			`payment rejected by endpoint (HTTP ${paidRes.status}): ${result?.error?.message || result?.error || resultText.slice(0, 300)}`,
		);
	}
	let settlement = null;
	const settleHeader = paidRes.headers.get('x-payment-response');
	if (settleHeader) {
		try {
			settlement = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'));
		} catch {
			settlement = null;
		}
	}
	statusCache = null; // balance just changed
	emit({
		stage: 'done',
		amount: accept.amount,
		payer: signer.address,
		payTo: accept.payTo,
		settlement,
		result,
	});
}

// ── HTTP server ───────────────────────────────────────────────────────────

function readBody(req) {
	return new Promise((resolvePromise, reject) => {
		let data = '';
		req.on('data', (c) => {
			data += c;
			if (data.length > 64 * 1024) reject(new Error('request body too large'));
		});
		req.on('end', () => resolvePromise(data));
		req.on('error', reject);
	});
}

function sendJson(res, status, obj) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
	const origin = req.headers.origin;
	if (origin && corsOriginAllowed(origin)) {
		res.setHeader('access-control-allow-origin', origin);
		res.setHeader('vary', 'origin');
		res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
		res.setHeader('access-control-allow-headers', 'content-type');
	}
	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		return res.end();
	}

	const url = new URL(req.url, `http://localhost:${PORT}`);
	try {
		if (req.method === 'GET' && url.pathname === '/status') {
			return sendJson(res, 200, await walletStatus());
		}

		if (req.method === 'GET' && url.pathname === '/quote') {
			const endpoint = url.searchParams.get('endpoint') || '';
			const method = (url.searchParams.get('method') || 'POST').toUpperCase();
			if (!endpointAllowed(endpoint)) {
				return sendJson(res, 400, { ok: false, error: `endpoint origin not allowed (allowed: ${ALLOWED_ENDPOINT_ORIGINS.join(', ')})` });
			}
			const bodyParam = url.searchParams.get('body');
			const probeBody = bodyParam ? JSON.parse(bodyParam) : undefined;
			const { challenge, accept } = await fetch402(endpoint, method, probeBody);
			return sendJson(res, 200, {
				ok: true,
				amount: accept.amount,
				payTo: accept.payTo,
				asset: accept.asset,
				network: accept.network,
				feePayer: accept.extra?.feePayer || null,
				maxTimeoutSeconds: accept.maxTimeoutSeconds,
				resource: challenge.resource || null,
			});
		}

		if (req.method === 'POST' && url.pathname === '/pay') {
			const raw = await readBody(req);
			let parsed;
			try {
				parsed = JSON.parse(raw || '{}');
			} catch {
				return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
			}
			const endpoint = String(parsed.endpoint || '');
			const method = String(parsed.method || 'POST').toUpperCase();
			if (!['GET', 'POST'].includes(method)) {
				return sendJson(res, 400, { ok: false, error: 'method must be GET or POST' });
			}
			if (!endpointAllowed(endpoint)) {
				return sendJson(res, 400, { ok: false, error: `endpoint origin not allowed (allowed: ${ALLOWED_ENDPOINT_ORIGINS.join(', ')})` });
			}
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
			});
			let lastStage = 'challenge';
			const emit = (evt) => {
				lastStage = evt.stage || lastStage;
				res.write(`data: ${JSON.stringify(evt)}\n\n`);
			};
			try {
				await executePayment({ endpoint, method, body: parsed.body, emit });
			} catch (err) {
				emit({ stage: 'error', failedStage: lastStage, message: err.message });
			}
			return res.end();
		}

		sendJson(res, 404, { ok: false, error: 'not found' });
	} catch (err) {
		if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
		else res.end();
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`agent-wallet x402 bridge listening on http://127.0.0.1:${PORT}`);
	console.log(`  settlement rail: USDC on Solana mainnet (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)`);
	console.log(`  allowed endpoint origins: ${ALLOWED_ENDPOINT_ORIGINS.join(', ')}`);
	console.log(`  per-payment cap: ${fmtUsdc(MAX_USDC_MICROS.toString())} USDC`);
	walletStatus()
		.then((s) =>
			console.log(
				`  agent wallet: ${s.wallet.address} (${s.balance.chains[0]?.usdc ?? 0} USDC, ${s.balance.chains[0]?.sol ?? '?'} SOL)`,
			),
		)
		.catch((e) => console.warn(`  wallet unavailable: ${e.message}`));
});
