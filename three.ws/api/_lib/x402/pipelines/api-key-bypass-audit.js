// api/_lib/x402/pipelines/api-key-bypass-audit.js
//
// API Key Bypass Security Test — autonomous pipeline (self/security).
//
// A run()-style registry entry (autonomous-registry.js → `api-key-bypass-audit`)
// the per-tick spend loop invokes once a day. It is the platform's free-access
// canary: it proves the X-API-Key bypass lane (api/_lib/x402/access-control.js →
// installAccessControl) only ever grants free access to a VALID key — and that a
// missing or invalid key still hits the paywall. A refactor that accidentally
// short-circuits the 402 for ANY key (or no key) lets the whole paid surface be
// drained for free; this audit catches that within a day.
//
// The bypass matrix it exercises against every audited route:
//   • VALID key   → expect a free grant: HTTP 200 carrying `x-payment-bypass`,
//                   NOT a 402 and NOT a 403. (the bypass lane working)
//   • INVALID key → expect denial: a 403 (Invalid API key) or a 402 paywall —
//                   anything that does NOT grant free access. A 200 here is a LEAK.
//   • NO key      → expect the 402 paywall challenge. A 200 here means the
//                   paywall was removed — a LEAK.
//   • REVOKED key → (subscription lane only) after we revoke the canary key, the
//                   SAME key must now be denied. A grant here is a LEAK.
//
// Both audited routes share the same installAccessControl() hook but invoke it
// from different consumers, so the pair covers both code paths a refactor could
// break:
//   • /api/x402/model-check — hand-rolled access-control invocation (GET, $0.001,
//     read-only/idempotent). Full matrix (valid grant + denials) runs here, and
//     this is the one route we actually PAY: paying its no-key 402 challenge once
//     proves the paywall→verify→settle path is intact end-to-end ("without a valid
//     key you must pay, and paying works").
//   • /api/x402/dance-tip — paidEndpoint(spec) factory access-control (POST,
//     $0.001). Deny matrix only (invalid → 403, no-key → 402); those paths reject
//     BEFORE the handler runs, so probing them has no side effects and we never
//     fire a free dance-tip.
//
// Acquiring a VALID key: we mint an EPHEMERAL subscription key (createSubscription)
// with a 10-minute self-expiry, exercise the partner/DB bypass lane every
// paidEndpoint relies on, then revoke it in a finally — so a crash mid-run can
// never leave a live free-access key behind (it self-expires regardless). When the
// DB is unavailable we fall back to the INTERNAL_API_KEY env (the internal-service
// lane). With neither, the grant check is skipped (verdict: inconclusive) but the
// deny matrix + paywall payment still run.
//
// Recording: the loop records ONE x402_autonomous_log row per run (signalData →
// signal_data, valueExtracted → value_extracted, amountAtomic = the single $0.001
// paywall-proof payment). The dedicated value sink is `x402_api_key_bypass_audit`
// — one row per audit with the full per-route matrix, the pass/fail verdict, and
// the paywall-payment evidence.
//
// Downstream consumer: api/ops/health.js reads the latest x402_api_key_bypass_audit
// row (loadApiKeyBypassAudit) and folds a confirmed bypass leak / broken bypass
// into the platform health verdict (alongside the idempotency audit and the
// cross-network circuit breaker), so the status page / on-call surface a leaking
// paywall immediately.

import { randomUUID, randomBytes } from 'node:crypto';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { sendOpsAlert } from '../../alerts.js';
import { createSubscription, revokeSubscription } from '../api-keys.js';
import {
	loadSeedKeypair,
	bootstrapSolanaContext,
	payX402,
	fetchWithTimeout,
} from '../pay.js';

const log = logger('x402-api-key-bypass-audit');

const UA = 'threews-x402-autonomous/1.0';

// fox.glb — a tiny public canary the model-check server fetches behind its SSRF
// guard. Pinned to the canonical public origin so model-check always has a real
// public asset to inspect on the paid (no-key) probe.
const CANARY_GLB = 'https://three.ws/avatars/fox.glb';

// Routes under audit. `probeGrant` runs the valid-key grant probe (read-only
// routes only, so a free grant has no side effect). `pay` marks the single route
// whose no-key 402 we actually settle to prove the paywall path end-to-end.
const AUDIT_ROUTES = [
	{
		route: '/api/x402/model-check',
		label: 'hand-rolled',
		method: 'GET',
		query: `?url=${encodeURIComponent(CANARY_GLB)}`,
		body: null,
		probeGrant: true,
		pay: true,
	},
	{
		route: '/api/x402/dance-tip',
		label: 'paidEndpoint',
		method: 'GET',
		query: '',
		// Deny matrix only: the invalid-key (403) and no-key (402) paths both reject
		// inside / before the access-control hook, well before the dance-tip handler
		// runs — so probing them is read-only and never fires a free tip. No grant
		// probe here (that would run the handler), so no params are needed.
		body: null,
		probeGrant: false,
		pay: false,
	},
];

let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_api_key_bypass_audit (
			id                bigserial PRIMARY KEY,
			ts                timestamptz DEFAULT now(),
			run_id            uuid,
			route             text NOT NULL,
			valid_key_source  text,
			valid_status      int,
			valid_bypassed    boolean,
			invalid_status    int,
			invalid_denied    boolean,
			nokey_status      int,
			nokey_challenged  boolean,
			revoked_status    int,
			revoked_denied    boolean,
			routes_tested     int NOT NULL DEFAULT 0,
			leaks             int NOT NULL DEFAULT 0,
			paid_status       int,
			paid_settled      boolean NOT NULL DEFAULT false,
			paid_tx           text,
			amount_atomic     bigint NOT NULL DEFAULT 0,
			verdict           text NOT NULL,
			pass              boolean NOT NULL,
			leak              boolean NOT NULL DEFAULT false,
			details           jsonb,
			duration_ms       int,
			error_msg         text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_api_key_bypass_audit_ts ON x402_api_key_bypass_audit (ts DESC)`;
	_schemaReady = true;
}

async function storeAudit(sql, runId, row) {
	try {
		await ensureSchema(sql);
		await sql`
			INSERT INTO x402_api_key_bypass_audit
				(run_id, route, valid_key_source, valid_status, valid_bypassed,
				 invalid_status, invalid_denied, nokey_status, nokey_challenged,
				 revoked_status, revoked_denied, routes_tested, leaks,
				 paid_status, paid_settled, paid_tx, amount_atomic,
				 verdict, pass, leak, details, duration_ms, error_msg)
			VALUES
				(${runId || null}, ${row.route}, ${row.valid_key_source || null},
				 ${row.valid_status}, ${row.valid_bypassed},
				 ${row.invalid_status}, ${row.invalid_denied},
				 ${row.nokey_status}, ${row.nokey_challenged},
				 ${row.revoked_status}, ${row.revoked_denied},
				 ${row.routes_tested}, ${row.leaks},
				 ${row.paid_status}, ${row.paid_settled}, ${row.paid_tx || null},
				 ${row.amount_atomic || 0},
				 ${row.verdict}, ${row.pass}, ${row.leak},
				 ${JSON.stringify(row.details || [])}, ${row.duration_ms}, ${row.error_msg || null})
		`;
	} catch (err) {
		// A DB fault must never crash the loop — log and move on.
		log.warn('api_key_bypass_audit_insert_failed', { message: err?.message });
	}
}

// One free probe of a route with a given header set. Never throws — a network
// fault lands as status 0 (classified 'error', never a leak).
async function probe(url, route, extraHeaders) {
	const headers = { 'user-agent': UA, ...extraHeaders };
	const init = { method: route.method, headers };
	if (route.method !== 'GET' && route.body != null) {
		headers['content-type'] = 'application/json';
		init.body = JSON.stringify(route.body);
	}
	try {
		const res = await fetchWithTimeout(url, init);
		return {
			status: res.status,
			bypass: !!res.headers?.get?.('x-payment-bypass'),
		};
	} catch (err) {
		return { status: 0, bypass: false, error: err?.message || 'network' };
	}
}

// Classify one probe against what the scenario expects.
//   expectation 'grant'     → a valid key must yield a free bypass (200 + header).
//   expectation 'deny'      → invalid/revoked key must NOT grant free access.
//   expectation 'challenge' → no key must hit the 402 paywall.
// A 200 carrying x-payment-bypass on a deny/challenge scenario, or any 200 that
// ran the handler without paying, is a LEAK.
function classify(scenario, route, p, expectation) {
	const granted = p.status === 200 && p.bypass;
	const free200 = p.status === 200 && !p.bypass;
	const challenged = p.status === 402;
	const denied = p.status === 401 || p.status === 403;

	let verdict;
	if (p.status === 0) {
		verdict = 'error';
	} else if (expectation === 'grant') {
		verdict = granted ? 'secure' : 'bypass_broken';
	} else if (granted || free200) {
		verdict = 'leak';
	} else if (expectation === 'challenge') {
		verdict = challenged ? 'secure' : denied ? 'anomaly_denied' : 'anomaly';
	} else {
		// deny: a 403 reject OR a 402 paywall both withhold free access → secure.
		verdict = denied || challenged ? 'secure' : 'anomaly';
	}
	return {
		route: route.route,
		label: route.label,
		scenario,
		status: p.status,
		bypass: p.bypass,
		verdict,
	};
}

// Acquire a VALID api key to prove the bypass lane grants free access. Prefer an
// ephemeral subscription key (the partner/DB lane every paidEndpoint depends on);
// fall back to the internal-service key; else null (grant probe is skipped).
async function acquireValidKey() {
	try {
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
		const sub = await createSubscription({
			name: `bypass-audit-canary ${new Date().toISOString()}`,
			rateLimitPerMinute: 120,
			expiresAt, // self-expires in 10 min even if revoke never runs
			meta: { canary: true, purpose: 'api-key-bypass-audit' },
		});
		return { token: sub.token, source: 'subscription', subId: sub.id };
	} catch (err) {
		const internal = process.env.INTERNAL_API_KEY;
		if (internal) return { token: internal, source: 'internal', subId: null };
		return { token: null, source: null, subId: null, error: err?.message };
	}
}

/**
 * Run the API key bypass security test. Self-contained: builds its own Solana
 * payment context for the paywall-proof payment when one isn't supplied, so it can
 * be invoked directly (manual test) or handed the loop's shared blockhash + keypair.
 *
 * @param {object} [ctx] — supplied by the loop:
 *   { origin, buyer, conn, blockhash, mintInfo, redis, sql, log, runId, remainingCap }
 * @returns {Promise<{success, amountAtomic, txSig, responseData, signalData,
 *   valueExtracted, errorMsg, note}>} the outcome the loop records to x402_autonomous_log.
 */
export async function runApiKeyBypassAudit(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;
	const t0 = Date.now();

	// A well-formed-but-unregistered key: passes the `x402_live_` namespace gate so
	// the access-control hook actually runs the DB lookup (returns no row → 403),
	// exercising the real invalid-key path rather than short-circuiting on prefix.
	const invalidKey = `x402_live_${randomBytes(32).toString('base64url')}`;

	const valid = await acquireValidKey();
	const matrix = [];

	try {
		for (const r of AUDIT_ROUTES) {
			const url = `${origin}${r.route}${r.query || ''}`;
			// NO key → expect the 402 paywall.
			matrix.push(classify('no-key', r, await probe(url, r, {}), 'challenge'));
			// INVALID key → expect denial (403 or 402), never a free grant.
			matrix.push(
				classify('invalid-key', r, await probe(url, r, { 'x-api-key': invalidKey }), 'deny'),
			);
			// VALID key → expect a free bypass. Read-only routes only.
			if (r.probeGrant && valid.token) {
				matrix.push(
					classify('valid-key', r, await probe(url, r, { 'x-api-key': valid.token }), 'grant'),
				);
			}
		}

		// Revocation lifecycle (subscription lane): revoke the canary, then confirm
		// the SAME key is now denied on the read-only route.
		if (valid.source === 'subscription' && valid.subId) {
			try {
				await revokeSubscription(valid.subId);
				const primary = AUDIT_ROUTES.find((r) => r.probeGrant) || AUDIT_ROUTES[0];
				const url = `${origin}${primary.route}${primary.query || ''}`;
				matrix.push(
					classify('revoked-key', primary, await probe(url, primary, { 'x-api-key': valid.token }), 'deny'),
				);
			} catch (err) {
				log.warn('api_key_bypass_revoke_probe_failed', { message: err?.message });
			}
		}
	} finally {
		// Belt-and-suspenders cleanup: never leave a live canary key.
		if (valid.source === 'subscription' && valid.subId) {
			try {
				await revokeSubscription(valid.subId);
			} catch { /* already revoked / DB blip — the 10-min expiry still bounds it */ }
		}
	}

	const leak = matrix.some((m) => m.verdict === 'leak');
	const bypassBroken = matrix.some((m) => m.verdict === 'bypass_broken');
	const leaks = matrix.filter((m) => m.verdict === 'leak').length;
	const grantTested = matrix.some((m) => m.scenario === 'valid-key');

	// ── Paywall-proof payment: settle the no-key 402 once to prove the full
	// paywall → verify → settle path still works (the "you must pay" side of the
	// test). Best-effort: a missing wallet skips this step gracefully, the free
	// bypass-matrix verdict above stands on its own. ────────────────────────────
	let amountAtomic = 0;
	let paidTx = null;
	let paidStatus = null;
	let paidSettled = false;
	let payNote = null;

	const payRoute = AUDIT_ROUTES.find((r) => r.pay);
	let buyer = ctx.buyer;
	if (!buyer) {
		try {
			buyer = loadSeedKeypair();
		} catch (err) {
			payNote = `wallet_unconfigured: ${err.message}`;
			log.info('api_key_bypass_pay_skipped', { reason: payNote });
		}
	}
	if (buyer && payRoute) {
		let conn = ctx.conn;
		let blockhash = ctx.blockhash;
		let mintInfo = ctx.mintInfo;
		if (!conn || !blockhash || !mintInfo) {
			try {
				({ conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
			} catch (err) {
				payNote = `solana_preflight_failed: ${err?.message}`;
				log.warn('api_key_bypass_solana_preflight_failed', { message: err?.message });
			}
		}
		if (conn && blockhash && mintInfo) {
			const url = `${origin}${payRoute.route}${payRoute.query || ''}`;
			const out = await payX402({
				url,
				method: payRoute.method,
				body: payRoute.body || null,
				buyer,
				conn,
				blockhash,
				mintInfo,
				remainingCap,
			});
			paidStatus = out.status;
			paidSettled = !!(out.paid && out.txSig);
			amountAtomic = out.paid ? out.amountAtomic : 0;
			paidTx = out.txSig;
			if (!out.paid) payNote = out.errorMsg || 'pay_unsettled';
		}
	}

	// ── Verdict ────────────────────────────────────────────────────────────────
	let verdict;
	let pass;
	if (leak) {
		verdict = 'bypass_leak';
		pass = false;
	} else if (bypassBroken) {
		verdict = 'bypass_broken';
		pass = false;
	} else if (!grantTested) {
		// Deny matrix held, but we never confirmed a valid key grants access (no key
		// source / network error) — not proof of a sound bypass lane.
		verdict = 'inconclusive';
		pass = false;
	} else {
		verdict = 'secure';
		pass = true;
	}

	const errorMsg = leak
		? `api_key_bypass_leak: ${matrix.filter((m) => m.verdict === 'leak').map((m) => `${m.scenario}@${m.route}=${m.status}`).join(', ')}`
		: bypassBroken
			? `api_key_bypass_broken: ${matrix.filter((m) => m.verdict === 'bypass_broken').map((m) => `${m.scenario}@${m.route}=${m.status}`).join(', ')}`
			: payNote && !paidSettled && verdict === 'secure'
				? `paywall_payment_unverified: ${payNote}`
				: null;

	const primaryRoute = (AUDIT_ROUTES.find((r) => r.probeGrant) || AUDIT_ROUTES[0]).route;
	const pick = (scenario, route) =>
		matrix.find((m) => m.scenario === scenario && m.route === route) || null;
	const validRow = pick('valid-key', primaryRoute);
	const invalidRow = pick('invalid-key', primaryRoute);
	const nokeyRow = pick('no-key', primaryRoute);
	const revokedRow = pick('revoked-key', primaryRoute);
	const durationMs = Date.now() - t0;

	await storeAudit(sql, runId, {
		route: primaryRoute,
		valid_key_source: valid.source,
		valid_status: validRow?.status ?? null,
		valid_bypassed: validRow ? validRow.verdict === 'secure' : null,
		invalid_status: invalidRow?.status ?? null,
		invalid_denied: invalidRow ? invalidRow.verdict === 'secure' : null,
		nokey_status: nokeyRow?.status ?? null,
		nokey_challenged: nokeyRow ? nokeyRow.verdict === 'secure' : null,
		revoked_status: revokedRow?.status ?? null,
		revoked_denied: revokedRow ? revokedRow.verdict === 'secure' : null,
		routes_tested: AUDIT_ROUTES.length,
		leaks,
		paid_status: paidStatus,
		paid_settled: paidSettled,
		paid_tx: paidTx,
		amount_atomic: amountAtomic,
		verdict,
		pass,
		leak,
		details: matrix,
		duration_ms: durationMs,
		error_msg: errorMsg,
	});

	// A confirmed free-access leak is a security-critical event — page ops.
	if (leak) {
		sendOpsAlert(
			'x402 API-key bypass LEAK — paywall granting free access',
			`The X-API-Key bypass lane granted free access where it must not: ` +
				`${matrix.filter((m) => m.verdict === 'leak').map((m) => `${m.scenario} on ${m.route} → HTTP ${m.status}`).join('; ')}. ` +
				`A missing or invalid key is bypassing payment — paid endpoints can be drained for free.`,
			{ signature: 'x402-api-key-bypass:leak' },
		).catch(() => {});
	} else if (bypassBroken) {
		// Lower severity: partners with valid keys are being charged/blocked.
		sendOpsAlert(
			'x402 API-key bypass BROKEN — valid keys not honored',
			`A valid API key failed to bypass the paywall: ` +
				`${matrix.filter((m) => m.verdict === 'bypass_broken').map((m) => `${m.scenario} on ${m.route} → HTTP ${m.status}`).join('; ')}. ` +
				`Subscribers are being charged for access they already pay for.`,
			{ signature: 'x402-api-key-bypass:broken' },
		).catch(() => {});
	}

	log.info('api_key_bypass_audit_complete', {
		run_id: runId,
		verdict,
		pass,
		leak,
		bypass_broken: bypassBroken,
		valid_key_source: valid.source,
		paid_settled: paidSettled,
		routes_tested: AUDIT_ROUTES.length,
		duration_ms: durationMs,
	});

	const signalData = {
		audited: true,
		verdict,
		pass,
		leak,
		bypass_broken: bypassBroken,
		routes_tested: AUDIT_ROUTES.length,
		leaks,
		valid_key_source: valid.source,
		grant_tested: grantTested,
		paid_settled: paidSettled,
		matrix: matrix.map((m) => ({ s: m.scenario, r: m.route, code: m.status, v: m.verdict })),
	};

	return {
		// amountAtomic reflects ONLY the single legitimate paywall-proof payment.
		success: pass,
		amountAtomic,
		txSig: paidTx,
		responseData: {
			matrix,
			paid: { status: paidStatus, settled: paidSettled, tx: paidTx, note: payNote },
		},
		signalData,
		valueExtracted: { verdict, leaks, routes_tested: AUDIT_ROUTES.length, paid_settled: paidSettled },
		errorMsg,
		note: verdict,
	};
}

// Alias matching the pipelines convention (bazaar-warmup exports `run`).
export { runApiKeyBypassAudit as run };
