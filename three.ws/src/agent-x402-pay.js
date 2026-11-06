/**
 * Agent x402 pay — client for the wallet hub Pay tab.
 *
 * Thin fetch layer over the real endpoints — no mocks, no sample data:
 *   - searchBazaarServices  → GET  /api/bazaar/search        (Solana-payable x402 services)
 *   - previewX402           → POST /api/x402-pay  { preview } (live price + what's bought)
 *   - payX402Stream         → POST /api/x402-pay  (SSE)        (build → settle from agent wallet)
 *   - fetchAgentUsdc        → GET  /api/agents/:id/solana/holdings (USDC balance, funding-aware)
 *   - fetchX402Activity     → GET  /api/agents/:id/solana/custody?category=x402
 *
 * Every payment is signed + settled server-side from the agent's OWN custodial
 * Solana wallet (api/x402-pay.js). The shared platform wallet is never used here.
 */

import { consumeCsrfToken } from './api.js';

// Browse / search the x402 bazaar, scoped to services payable in Solana USDC
// (the only network an agent's Solana wallet can settle). Returns normalized
// resources from api/_lib/x402/bazaar-client.js.
export async function searchBazaarServices(query = '', { maxPrice = null, limit = 24 } = {}) {
	const params = new URLSearchParams({ type: 'http', network: 'solana:*', limit: String(limit) });
	if (query) params.set('query', query);
	if (maxPrice != null) params.set('maxPrice', String(maxPrice));
	const resp = await fetch(`/api/bazaar/search?${params}`, { credentials: 'include' });
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(json?.error?.message || json?.message || `search failed (${resp.status})`);
	}
	return {
		resources: Array.isArray(json.resources) ? json.resources : [],
		count: json.count || 0,
		errors: Array.isArray(json.errors) ? json.errors : [],
	};
}

// Fetch the live payment requirements for one endpoint without moving funds.
// Resolves to the server's preview envelope:
//   { ok, requires_payment, payable?, price_usdc?, asset?, payTo?, network?, resource?, code? }
export async function previewX402({ agentId, url, method = 'GET', body = undefined }) {
	const resp = await fetch('/api/x402-pay', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agentId, url, method, body, preview: true }),
	});
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		const e = new Error(json?.error_description || json?.error || `preview failed (${resp.status})`);
		e.code = json?.code || json?.error;
		e.status = resp.status;
		throw e;
	}
	return json;
}

// Pay an endpoint from the agent wallet, streaming the lifecycle as SSE.
// `on(event, data)` is called for each event ('challenge'|'built'|'settled'|
// 'result'|'error'). Resolves with the final result envelope, or rejects with an
// Error carrying `.code`/`.envelope` from the 'error' event.
export async function payX402Stream({ agentId, url, method = 'GET', body = undefined, serviceLabel = null }, on = () => {}) {
	// Settle moves USDC + signs with the agent key → single-use CSRF token required
	// (the preview path above is exempt server-side). Bearer SDK callers are exempt.
	const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
	const token = await consumeCsrfToken();
	if (token) headers['x-csrf-token'] = token;
	const resp = await fetch('/api/x402-pay', {
		method: 'POST',
		credentials: 'include',
		headers,
		body: JSON.stringify({ agentId, url, method, body, service_label: serviceLabel, stream: true }),
	});

	// A non-stream error (auth, rate limit, validation) comes back as JSON, not SSE.
	const ctype = resp.headers.get('content-type') || '';
	if (!resp.ok && !ctype.includes('text/event-stream')) {
		const json = await resp.json().catch(() => ({}));
		const e = new Error(json?.error_description || json?.error || `payment failed (${resp.status})`);
		e.code = json?.code || json?.error;
		e.status = resp.status;
		throw e;
	}
	if (!resp.body) throw new Error('payment stream unavailable');

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let result = null;
	let failure = null;

	const dispatch = (event, dataRaw) => {
		let data = null;
		try {
			data = dataRaw ? JSON.parse(dataRaw) : null;
		} catch {
			data = null;
		}
		if (event === 'result') result = data;
		if (event === 'error') failure = data;
		try {
			on(event, data);
		} catch {
			/* a UI handler throwing must not break the stream pump */
		}
	};

	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let sep;
		while ((sep = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			let event = 'message';
			let data = '';
			for (const line of frame.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data += line.slice(5).trim();
			}
			if (data || event !== 'message') dispatch(event, data);
		}
	}

	if (failure) {
		const e = new Error(failure.error_description || failure.error || 'payment failed');
		e.code = failure.code;
		e.envelope = failure;
		throw e;
	}
	if (!result) throw new Error('payment ended without a result');
	return result;
}

// The agent wallet's USDC balance (+ SOL), read from real holdings. Returns
// { address, usdc, sol } — usdc is 0 when the agent holds none yet.
export async function fetchAgentUsdc(agentId, network = 'mainnet') {
	const resp = await fetch(
		`/api/agents/${encodeURIComponent(agentId)}/solana/holdings?network=${encodeURIComponent(network)}`,
		{ credentials: 'include' },
	);
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(json?.error?.message || json?.error || `holdings failed (${resp.status})`);
	}
	const data = json.data || {};
	const usdcToken = Array.isArray(data.tokens) ? data.tokens.find((t) => t.is_usdc) : null;
	return {
		address: data.address || null,
		sol: typeof data.sol === 'number' ? data.sol : null,
		usdc: usdcToken ? Number(usdcToken.ui_amount) || 0 : 0,
	};
}

// The agent's x402 payment history from the custody ledger (category=x402).
export async function fetchX402Activity(agentId, network = 'mainnet', limit = 25) {
	const resp = await fetch(
		`/api/agents/${encodeURIComponent(agentId)}/solana/custody?network=${encodeURIComponent(network)}&category=x402&limit=${limit}`,
		{ credentials: 'include' },
	);
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(json?.error?.message || json?.error || `activity failed (${resp.status})`);
	}
	return Array.isArray(json.data?.items) ? json.data.items : [];
}
