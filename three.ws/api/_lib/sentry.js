// Sentry error reporting for Vercel serverless functions.
// Required env: SENTRY_DSN
// Optional env: SENTRY_ENVIRONMENT (defaults to VERCEL_ENV), SENTRY_RELEASE (defaults to VERCEL_GIT_COMMIT_SHA)
//
// Usage: import { captureException } from './_lib/sentry.js'
// serverError() in http.js calls this automatically for 5xx errors.
//
// WHY NO @sentry/node SDK HERE — DO NOT "FIX" THIS BY ADDING IT BACK.
// This module is imported (via http.js) by ~360 of our serverless functions.
// The @sentry/node SDK statically pulls in the full OpenTelemetry instrumentation
// tree (@sentry + @opentelemetry ≈ 50 MB / thousands of files). On Vercel that
// tree is marked external in scripts/bundle-api.mjs, so @vercel/nft traces it
// once PER FUNCTION at build time — ~360 traversals of a 50 MB graph. That alone
// pushed the deploy past Vercel's 45-minute build timeout (deploy 5vphtZz6S).
// Reporting straight to Sentry's public envelope-ingestion HTTP API removes the
// dependency entirely: nothing for NFT to trace, no SDK init / OTel cold-start
// cost, and one fire-and-forget fetch on the (rare) error path. Same envelope
// Sentry's own SDK would POST — just without shipping the SDK to every function.
// Spec: https://develop.sentry.dev/sdk/envelopes/

import { webcrypto } from 'node:crypto';

const crypto = globalThis.crypto || webcrypto;

// Parse the DSN once. Shape: {PROTOCOL}://{PUBLIC_KEY}@{HOST}{PATH}/{PROJECT_ID}
// Returns null (→ reporting is a no-op) when SENTRY_DSN is unset or malformed.
function parseDsn(rawDsn) {
	if (!rawDsn) return null;
	let url;
	try {
		url = new URL(rawDsn);
	} catch {
		return null;
	}
	const publicKey = url.username;
	const segments = url.pathname.split('/').filter(Boolean);
	const projectId = segments.pop();
	if (!publicKey || !projectId) return null;
	const pathPrefix = segments.length ? `/${segments.join('/')}` : '';
	return {
		publicKey,
		envelopeUrl: `${url.protocol}//${url.host}${pathPrefix}/api/${projectId}/envelope/`,
	};
}

let _dsn;
function dsn() {
	if (_dsn === undefined) _dsn = parseDsn(process.env.SENTRY_DSN);
	return _dsn;
}

function eventId() {
	return crypto.randomUUID().replace(/-/g, '');
}

// V8 stack → Sentry frames. Sentry orders frames oldest-first (the crashing
// frame LAST), the reverse of how V8 prints them. Lines we can't parse are
// dropped; a partial trace still groups better than none.
function parseStack(stack) {
	if (typeof stack !== 'string') return [];
	const frames = [];
	for (const line of stack.split('\n')) {
		const m = line.match(/^\s*at (?:(.+?) )?\(?(.+?):(\d+):(\d+)\)?\s*$/);
		if (!m) continue;
		const [, fn, filename, lineno, colno] = m;
		frames.push({
			function: fn || '<anonymous>',
			filename,
			lineno: Number(lineno),
			colno: Number(colno),
			in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
		});
	}
	return frames.reverse();
}

function baseEvent(level) {
	return {
		event_id: eventId(),
		timestamp: Date.now() / 1000,
		platform: 'node',
		level,
		logger: 'three.ws',
		environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || 'development',
		release: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
		server_name: process.env.VERCEL_REGION || undefined,
		sdk: { name: 'threews.fetch', version: '1.0.0' },
	};
}

// Build the 3-line NDJSON envelope (envelope header, item header, event) and
// POST it. Fire-and-forget with a hard timeout so a slow/blocked ingest never
// delays — or hangs — the function it was reporting an error from.
function send(event) {
	const cfg = dsn();
	if (!cfg) return;
	const envelope =
		JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }) +
		'\n' +
		JSON.stringify({ type: 'event' }) +
		'\n' +
		JSON.stringify(event);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	fetch(cfg.envelopeUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-sentry-envelope',
			'x-sentry-auth': `Sentry sentry_version=7, sentry_client=threews.fetch/1.0.0, sentry_key=${cfg.publicKey}`,
		},
		body: envelope,
		signal: controller.signal,
		keepalive: true,
	})
		.catch(() => {})
		.finally(() => clearTimeout(timer));
}

export function captureException(err, context = {}) {
	if (!dsn()) return;
	const error =
		err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
	send({
		...baseEvent('error'),
		exception: {
			values: [
				{
					type: error.name || 'Error',
					value: error.message || String(error),
					stacktrace: { frames: parseStack(error.stack) },
				},
			],
		},
		extra: context,
	});
}

export function captureMessage(message, level = 'info', context = {}) {
	if (!dsn()) return;
	send({
		...baseEvent(level),
		message: { formatted: String(message) },
		extra: context,
	});
}
