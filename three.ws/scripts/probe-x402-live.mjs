#!/usr/bin/env node
/**
 * Live x402 probe: would a marketplace validator accept our paid endpoints?
 *
 * Why this exists
 * ---------------
 * `verify:x402` validates the discovery DOCUMENT. It says nothing about whether
 * the routes that document lists actually answer an unpaid request with a valid
 * 402. On 2026-09-18 the document was the least of it: a dependency bump made
 * every paid route throw on import, so each one answered 500, and the first
 * sign was Agentic Market's seller validator reporting "No x402 Setup Detected".
 *
 * This sends the same unpaid request a buyer or indexer sends and applies the
 * checklist Agentic Market's validator (agentic.market, Seller Tools) publishes:
 *
 *   Transport   https, reachable, body <= 65536 bytes, HTTP 402, valid JSON,
 *               resource object present
 *   Payment     x402Version 2, PAYMENT-REQUIRED header that decodes, accepts[]
 *               present and well-formed, known scheme, CAIP-2 network, asset,
 *               USDC price >= $0.001, payTo, maxTimeoutSeconds
 *   Bazaar      extension present, info block, input type + method, schema,
 *               and info validating against that schema (the strict check CDP
 *               runs before cataloging); output metadata and example are
 *               advisory
 *
 * It costs nothing: no request carries a payment.
 *
 * Usage:
 *   node scripts/probe-x402-live.mjs                        # https://three.ws, one sample per route
 *   node scripts/probe-x402-live.mjs --base=http://localhost:3000
 *   node scripts/probe-x402-live.mjs --only=/api/x402/forge # routes whose path contains the text
 *   node scripts/probe-x402-live.mjs --url=https://three.ws/api/x402/forge --method=POST
 *   node scripts/probe-x402-live.mjs --json                 # machine-readable report
 *
 * Exit code 0 when every probed route passes, 1 when any fails, 2 when the
 * discovery document itself cannot be loaded.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const base = (flag('base') || 'https://three.ws').replace(/\/$/, '');
const only = flag('only');
const singleUrl = flag('url');
const singleMethod = (flag('method') || 'GET').toUpperCase();
const concurrency = Math.max(1, Number(flag('concurrency')) || 4);
const asJson = args.includes('--json');

// The validator truncates anything larger and then skips every other check.
const MAX_BODY_BYTES = 65536;
const MIN_USDC_ATOMIC = 1000n; // $0.001 at 6 decimals
const KNOWN_SCHEMES = new Set(['exact', 'upto']);
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$/;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The datapoint catalog lists thousands of parameterised URLs behind a handful
 * of handlers (/api/x402/d/<family>/...). One sample per handler is what tells
 * us whether the route works; the rest would only hammer the probe rate limit.
 */
export function routeKey(url) {
	const parts = new URL(url).pathname.split('/').filter(Boolean);
	if (parts[0] === 'api' && parts[1] === 'x402' && parts[2] === 'd') return `/${parts.slice(0, 4).join('/')}`;
	return `/${parts.join('/')}`;
}

/**
 * The catalog always prints canonical production URLs, whatever host served it.
 * Probing a --base (a local server, a preview) has to hit THAT host, or the run
 * quietly tests production instead.
 */
export function rebase(url, onto) {
	const source = new URL(url);
	return new URL(`${source.pathname}${source.search}`, onto).href;
}

export function sampleRoutes(resources, { onto = null } = {}) {
	const byRoute = new Map();
	for (const r of resources) {
		if (!r?.url) continue;
		const key = routeKey(r.url);
		if (!byRoute.has(key)) byRoute.set(key, r);
	}
	return [...byRoute.entries()].map(([route, r]) => ({
		route,
		url: onto ? rebase(r.url, onto) : r.url,
		method: String(r.method || r.extensions?.bazaar?.info?.input?.method || 'GET').toUpperCase(),
		body: r.extensions?.bazaar?.info?.input?.body ?? null,
	}));
}

function decodePaymentRequiredHeader(value) {
	try {
		return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
	} catch {
		return null;
	}
}

/**
 * Applies the validator's checklist to one response. Returns
 * `{ failures: [...], advisories: [...] }`; an empty failures list is a pass.
 */
export function checkResponse({ url, status, bodyBytes, bodyText, paymentRequiredHeader }) {
	const failures = [];
	const advisories = [];

	if (new URL(url).protocol !== 'https:' && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
		failures.push('resource URL does not use HTTPS');
	}
	if (bodyBytes > MAX_BODY_BYTES) {
		failures.push(`response body is ${bodyBytes} bytes, over the ${MAX_BODY_BYTES}-byte limit (the validator truncates it and skips every other check)`);
		return { failures, advisories };
	}
	if (status !== 402) {
		failures.push(`HTTP ${status}, expected 402 for an unpaid request`);
		return { failures, advisories };
	}

	let body;
	try {
		body = JSON.parse(bodyText);
	} catch {
		failures.push('402 body is not valid JSON');
		return { failures, advisories };
	}

	if (!body.resource || typeof body.resource !== 'object' || !body.resource.url) failures.push('resource object missing or has no url');
	if (body.x402Version !== 2) failures.push(`x402Version is ${JSON.stringify(body.x402Version)}, expected 2`);

	if (!paymentRequiredHeader) {
		failures.push('PAYMENT-REQUIRED header missing (v2 delivers PaymentRequired there)');
	} else if (!decodePaymentRequiredHeader(paymentRequiredHeader)?.accepts) {
		failures.push('PAYMENT-REQUIRED header does not decode to a PaymentRequired object');
	}

	const accepts = Array.isArray(body.accepts) ? body.accepts : [];
	if (!accepts.length) failures.push('accepts[] missing or empty');
	accepts.forEach((a, i) => {
		for (const field of ['scheme', 'network', 'asset', 'amount', 'payTo']) {
			if (a?.[field] == null || a[field] === '') failures.push(`accepts[${i}] missing ${field}`);
		}
		if (a?.scheme && !KNOWN_SCHEMES.has(a.scheme)) failures.push(`accepts[${i}].scheme "${a.scheme}" is not a known scheme`);
		if (a?.network && !CAIP2.test(a.network)) failures.push(`accepts[${i}].network "${a.network}" is not a CAIP-2 id`);
		if (!(Number(a?.maxTimeoutSeconds) > 0)) failures.push(`accepts[${i}].maxTimeoutSeconds is not set`);
		if (a?.extra?.name === 'USDC' && /^\d+$/.test(String(a.amount)) && BigInt(a.amount) < MIN_USDC_ATOMIC) {
			failures.push(`accepts[${i}] prices ${a.amount} atomic USDC, under the $0.001 minimum`);
		}
	});

	const bazaar = body.extensions?.bazaar;
	if (!bazaar) {
		failures.push('bazaar extension missing (will not be cataloged)');
	} else {
		if (!bazaar.info) failures.push('bazaar.info missing');
		const input = bazaar.info?.input;
		if (!input) failures.push('bazaar.info.input missing');
		else {
			if (!input.type) failures.push('bazaar.info.input.type missing');
			if (!input.method && input.type === 'http') failures.push('bazaar.info.input.method missing');
		}
		if (!bazaar.schema) failures.push('bazaar.schema missing');
		else if (bazaar.info) {
			try {
				const validate = ajv.compile(bazaar.schema);
				if (!validate(bazaar.info)) {
					const detail = (validate.errors || []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
					failures.push(`bazaar.info fails its own schema, so CDP rejects the listing: ${detail}`);
				}
			} catch (err) {
				failures.push(`bazaar.schema does not compile: ${err.message}`);
			}
		}
		if (!bazaar.info?.output) advisories.push('no output metadata');
		else if (bazaar.info.output.example == null) advisories.push('no output example');
	}

	return { failures, advisories };
}

async function probe({ route, url, method, body }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const hasBody = method !== 'GET' && method !== 'HEAD';
		const res = await fetch(url, {
			method,
			headers: { accept: 'application/json', ...(hasBody ? { 'content-type': 'application/json' } : {}) },
			body: hasBody ? JSON.stringify(body ?? {}) : undefined,
			redirect: 'manual',
			signal: controller.signal,
		});
		const buf = Buffer.from(await res.arrayBuffer());
		const verdict = checkResponse({
			url,
			status: res.status,
			bodyBytes: buf.length,
			bodyText: buf.toString('utf8'),
			paymentRequiredHeader: res.headers.get('payment-required'),
		});
		return { route, url, method, status: res.status, bytes: buf.length, ...verdict };
	} catch (err) {
		const reason = err?.name === 'AbortError' ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s` : err?.message || String(err);
		return { route, url, method, status: 0, bytes: 0, failures: [`endpoint is not reachable: ${reason}`], advisories: [] };
	} finally {
		clearTimeout(timer);
	}
}

async function runPool(items, worker, size) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await worker(items[index]);
			}
		}),
	);
	return results;
}

async function loadTargets() {
	if (singleUrl) return [{ route: routeKey(singleUrl), url: singleUrl, method: singleMethod, body: null }];
	const docUrl = `${base}/.well-known/x402.json`;
	let res;
	try {
		res = await fetch(docUrl, { headers: { accept: 'application/json' } });
	} catch (err) {
		console.error(`[x402:probe] cannot reach ${docUrl}: ${err.message}`);
		process.exit(2);
	}
	if (!res.ok) {
		console.error(`[x402:probe] ${docUrl} answered HTTP ${res.status}. The discovery document is down, so nothing listed in it can be indexed. Probe a route directly with --url=<paid route>.`);
		process.exit(2);
	}
	const doc = await res.json();
	const targets = sampleRoutes(doc.resources || doc.items || [], { onto: base });
	return only ? targets.filter((t) => t.route.includes(only)) : targets;
}

async function main() {
	const targets = await loadTargets();
	if (!targets.length) {
		console.error('[x402:probe] no routes to probe (empty discovery document, or --only matched nothing)');
		process.exit(2);
	}
	const results = await runPool(targets, probe, concurrency);
	const failing = results.filter((r) => r.failures.length);

	if (asJson) {
		console.log(JSON.stringify({ base, probed: results.length, failing: failing.length, results }, null, 2));
		process.exit(failing.length ? 1 : 0);
	}

	for (const r of failing) {
		console.log(`FAIL  ${r.method} ${r.route}  (HTTP ${r.status}, ${r.bytes} bytes)`);
		for (const f of r.failures) console.log(`        ${f}`);
	}
	const advised = results.filter((r) => !r.failures.length && r.advisories.length);
	for (const r of advised) console.log(`note  ${r.method} ${r.route}: ${r.advisories.join('; ')}`);

	const largest = results.reduce((max, r) => Math.max(max, r.bytes), 0);
	console.log(
		`\n[x402:probe] ${results.length - failing.length}/${results.length} route(s) pass the marketplace checklist at ${singleUrl ? singleUrl : base}; largest response ${largest} of ${MAX_BODY_BYTES} bytes`,
	);
	process.exit(failing.length ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	main().catch((err) => {
		console.error(`[x402:probe] ${err?.stack || err}`);
		process.exit(2);
	});
}
