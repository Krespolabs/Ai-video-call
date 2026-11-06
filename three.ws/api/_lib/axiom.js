// Axiom event ingest for Vercel serverless functions — payment/business metrics.
// Optional env: AXIOM_TOKEN (API token), AXIOM_DATASET (dataset name).
//               AXIOM_URL (override host, e.g. https://api.eu.axiom.co for EU).
//
// Usage: import { recordPaymentMetric } from './_lib/axiom.js'
//
// WHY A RAW fetch AND NOT @axiomhq/js — same reasoning as sentry.js: this can be
// imported by many serverless functions, and we want zero SDK weight / no
// cold-start init. Axiom's ingest API is a single authenticated POST of a JSON
// event array, so we send it straight. Fire-and-forget with a hard timeout so a
// slow/blocked ingest never delays — or hangs — the money path it reports on.
//
// Fail-closed-to-noop: when AXIOM_TOKEN / AXIOM_DATASET are unset (local, CI, or
// before the Vercel↔Axiom account is connected) every export is a no-op. Wiring
// it in now means metrics start flowing the moment those env vars are set — no
// code change, exactly like the SENTRY_DSN gate in sentry.js.
//
// Ingest API: POST {host}/v1/datasets/{dataset}/ingest  (Bearer token, JSON array)
// Docs: https://axiom.co/docs/restapi/ingest

const DEFAULT_HOST = 'https://api.axiom.co';

let _cfg;
function cfg() {
	if (_cfg === undefined) {
		const token = process.env.AXIOM_TOKEN;
		const dataset = process.env.AXIOM_DATASET;
		_cfg =
			token && dataset
				? {
						url: `${(process.env.AXIOM_URL || DEFAULT_HOST).replace(/\/+$/, '')}/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
						token,
					}
				: null;
	}
	return _cfg;
}

/** True when ingest is configured — lets callers skip building a payload entirely. */
export function axiomEnabled() {
	return cfg() !== null;
}

// Common envelope fields, mirroring sentry.js: Axiom keys on `_time`, and we tag
// every row with environment / release / region so dashboards can slice by deploy.
function envelope(fields) {
	return {
		_time: new Date().toISOString(),
		environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
		release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
		region: process.env.VERCEL_REGION || undefined,
		...fields,
	};
}

/**
 * Fire-and-forget ingest of one structured event. Never throws, never blocks.
 * @param {object} fields — flat JSON; avoid PII. `_time` is added automatically.
 */
export function ingestEvent(fields) {
	const c = cfg();
	if (!c) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	fetch(c.url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${c.token}`,
		},
		body: JSON.stringify([envelope(fields)]),
		signal: controller.signal,
		keepalive: true,
	})
		.catch(() => {})
		.finally(() => clearTimeout(timer));
}

/**
 * Record a payment/settlement metric — the data the audit found we couldn't yet
 * see (success rate + latency per network). One row per attempt; dashboard the
 * rest in Axiom (e.g. `status:'ok'` ÷ total, p95 of `latency_ms`).
 * @param {object} m
 * @param {string} m.kind            — e.g. 'avatar_payout', 'plan_subscription', 'x402'
 * @param {'ok'|'failed'} m.status
 * @param {string} [m.network]       — 'solana' | 'base' | …
 * @param {number} [m.amountUsd]
 * @param {number} [m.latencyMs]
 * @param {string} [m.reason]        — failure reason / error code
 * @param {string} [m.signature]     — on-chain tx signature, when settled
 */
export function recordPaymentMetric({ kind, status, network, amountUsd, latencyMs, reason, signature } = {}) {
	if (!cfg()) return;
	ingestEvent({
		type: 'payment',
		kind,
		status,
		network,
		amount_usd: amountUsd,
		latency_ms: latencyMs,
		reason,
		signature,
	});
}
