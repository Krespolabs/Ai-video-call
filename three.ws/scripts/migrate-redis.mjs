#!/usr/bin/env node
// Migrate durable keys from the dead Upstash store to the active store.
//
// Background: On 2026-06-12 the original Upstash store (three-ws) hit its
// 500k/mo free-tier ceiling. A new store (three-ratelimit) was provisioned
// with new credentials. This script copies durable user data from the old
// store to the new one.
//
// Usage:
//   DEAD_REDIS_URL=<url> DEAD_REDIS_TOKEN=<token> node scripts/migrate-redis.mjs [--dry-run]
//
// Credential sources:
//   DEAD_REDIS_URL / DEAD_REDIS_TOKEN  — old store (three-ws).
//     Retrieve from console.upstash.com → three-ws store → REST API tab.
//     Or via Vercel env history (needs Vercel PAT): see docs/ops/redis.md.
//
//   Active store credentials are auto-resolved from .env.local using the
//   same fallback chain as api/_lib/env.js:
//     UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//     three_KV_REST_API_URL  / three_KV_REST_API_TOKEN    ← local .env.local
//     KV_REST_API_URL        / KV_REST_API_TOKEN
//
//   Override with ACTIVE_REDIS_URL / ACTIVE_REDIS_TOKEN if needed.
//
// Key patterns migrated (actual patterns used by the codebase — no "three:" prefix):
//   cosmetics:owned:*  — SET, 2-year TTL.  User cosmetic purchases. Critical.
//   x402:pay:call:*   — STRING, 30-day TTL. Payment dedup by tx hash.
//   featured-builds:* — STRING, 45-day TTL. Forge build gallery indexes.
//   play-build:*      — STRING, 45-day TTL. Individual build thumbnails.
//   x402:pay:feed     — LIST, no TTL. Recent x402 payment display feed.
//   feed:events       — LIST, no TTL. General activity event feed.
//
// Keys skipped (ephemeral, auto-regenerate):
//   rl:*              — rate limit windows
//   x402:rl:*         — subscription rate limit sorted sets
//   forge-smoke:*     — forge health cron state
//   uptime:*          — uptime cron data
//   usage:*           — usage buffer flushed by cron
//   feed:joined:*     — world join dedup (short TTL)
//   rep:*             — reputation cache (5-min TTL)
//   quota:*           — quota check cache (25h TTL)
//   a2a:spend:*       — A2A mandate spend ledger
//   keys containing | — idempotency cache (route|paymentId)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Credential resolution ────────────────────────────────────────────────────

function loadEnvLocal() {
	try {
		const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq < 1) continue;
			const key = trimmed.slice(0, eq).trim();
			let val = trimmed.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			if (key && !process.env[key]) process.env[key] = val;
		}
	} catch { /* .env.local absent in CI — fine */ }
}

loadEnvLocal();

const DEAD_URL   = (process.env.DEAD_REDIS_URL   || '').replace(/\/$/, '');
const DEAD_TOKEN = process.env.DEAD_REDIS_TOKEN  || '';

const ACTIVE_URL = (
	process.env.ACTIVE_REDIS_URL         ||
	process.env.UPSTASH_REDIS_REST_URL   ||
	process.env.three_KV_REST_API_URL    ||
	process.env.KV_REST_API_URL          || ''
).replace(/\/$/, '');

const ACTIVE_TOKEN =
	process.env.ACTIVE_REDIS_TOKEN        ||
	process.env.UPSTASH_REDIS_REST_TOKEN  ||
	process.env.three_KV_REST_API_TOKEN   ||
	process.env.KV_REST_API_TOKEN         || '';

function validateCredentials() {
	const errs = [];
	if (!DEAD_URL)    errs.push('DEAD_REDIS_URL is not set');
	if (!DEAD_TOKEN)  errs.push('DEAD_REDIS_TOKEN is not set');
	if (!ACTIVE_URL)  errs.push('Active store URL not found (set UPSTASH_REDIS_REST_URL or ensure .env.local has three_KV_REST_API_URL)');
	if (!ACTIVE_TOKEN) errs.push('Active store token not found (set UPSTASH_REDIS_REST_TOKEN or ensure .env.local has three_KV_REST_API_TOKEN)');
	if (DEAD_URL && ACTIVE_URL && DEAD_URL === ACTIVE_URL) {
		errs.push('DEAD_REDIS_URL and active store URL are the same — refusing to migrate store to itself');
	}
	if (errs.length) {
		console.error('\nCannot start migration:\n' + errs.map(e => '  • ' + e).join('\n'));
		console.error('\nSee the credential recovery guide in docs/ops/redis.md');
		process.exit(1);
	}
}

// ── Upstash REST helpers ─────────────────────────────────────────────────────

async function pipeline(baseUrl, token, commands) {
	const res = await fetch(`${baseUrl}/pipeline`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(commands),
	});
	if (!res.ok) throw new Error(`Upstash pipeline HTTP ${res.status}: ${await res.text()}`);
	const body = await res.json();
	if (!Array.isArray(body)) throw new Error(`Unexpected pipeline response: ${JSON.stringify(body)}`);
	return body.map((r, i) => {
		if (r && r.error) throw new Error(`Pipeline cmd ${i} error: ${r.error}`);
		return r.result;
	});
}

async function cmd(baseUrl, token, ...args) {
	const [result] = await pipeline(baseUrl, token, [args]);
	return result;
}

// Cursor-based SCAN returning all matching keys.
async function scanAll(baseUrl, token, pattern) {
	const keys = [];
	let cursor = '0';
	do {
		const result = await cmd(baseUrl, token, 'SCAN', cursor, 'MATCH', pattern, 'COUNT', '200');
		if (!Array.isArray(result) || result.length < 2) break;
		cursor = String(result[0]);
		if (Array.isArray(result[1])) keys.push(...result[1]);
	} while (cursor !== '0');
	return keys;
}

// ── Key patterns ─────────────────────────────────────────────────────────────

// Patterns to scan (user data that must survive store rotation).
const SCAN_PATTERNS = [
	'cosmetics:owned:*',
	'x402:pay:call:*',
	'featured-builds:*',
	'play-build:*',
];

// Single well-known list keys (existence checked individually, not via SCAN).
const SINGLE_LIST_KEYS = [
	'x402:pay:feed',
	'feed:events',
];

// Keys that match these prefixes are ephemeral and always skipped even if
// somehow discovered via SCAN (belt-and-suspenders).
const SKIP_PREFIXES = [
	'rl:',
	'x402:rl:',
	'forge-smoke:',
	'uptime:',
	'usage:',
	'feed:joined:',
	'rep:',
	'quota:',
	'a2a:spend:',
];

function shouldSkip(key) {
	if (key.includes('|')) return true; // idempotency cache: route|paymentId
	return SKIP_PREFIXES.some(p => key.startsWith(p));
}

// ── Migration logic per key type ─────────────────────────────────────────────

async function migrateSet(key) {
	const [members, ttl] = await pipeline(DEAD_URL, DEAD_TOKEN, [
		['SMEMBERS', key],
		['TTL', key],
	]);
	if (!Array.isArray(members) || members.length === 0) return { action: 'skip', reason: 'empty set' };

	if (!DRY_RUN) {
		// SADD is idempotent — safe to call even if some members already exist.
		const activeCmds = [['SADD', key, ...members]];
		if (ttl > 0) {
			const expireAt = Math.floor(Date.now() / 1000) + ttl;
			activeCmds.push(['EXPIREAT', key, String(expireAt)]);
		}
		await pipeline(ACTIVE_URL, ACTIVE_TOKEN, activeCmds);
	}
	return { action: 'copy', type: 'set', count: members.length, ttl };
}

async function migrateString(key) {
	const [val, ttl] = await pipeline(DEAD_URL, DEAD_TOKEN, [
		['GET', key],
		['TTL', key],
	]);
	if (val === null || val === undefined) return { action: 'skip', reason: 'null value' };
	if (ttl === -2) return { action: 'skip', reason: 'key expired in dead store' };

	if (!DRY_RUN) {
		// NX = only set if the key doesn't already exist, so newer post-incident
		// data in the active store is never clobbered by stale dead-store values.
		const serialized = typeof val === 'string' ? val : JSON.stringify(val);
		const setCmd = ttl > 0
			? ['SET', key, serialized, 'NX', 'EX', String(ttl)]
			: ['SET', key, serialized, 'NX'];
		await cmd(ACTIVE_URL, ACTIVE_TOKEN, ...setCmd);
	}
	return { action: 'copy', type: 'string', ttl };
}

async function migrateList(key) {
	const [items, ttl] = await pipeline(DEAD_URL, DEAD_TOKEN, [
		['LRANGE', key, '0', '-1'],
		['TTL', key],
	]);
	if (!Array.isArray(items) || items.length === 0) return { action: 'skip', reason: 'empty list' };

	if (!DRY_RUN) {
		// Only write if the key doesn't exist in the active store — new events
		// written after the incident are more current than the dead store's list.
		const exists = await cmd(ACTIVE_URL, ACTIVE_TOKEN, 'EXISTS', key);
		if (exists) return { action: 'skip', reason: 'already exists in active store' };

		// RPUSH preserves LRANGE order (newest-first convention maintained).
		await cmd(ACTIVE_URL, ACTIVE_TOKEN, 'RPUSH', key, ...items);
		if (ttl > 0) {
			const expireAt = Math.floor(Date.now() / 1000) + ttl;
			await cmd(ACTIVE_URL, ACTIVE_TOKEN, 'EXPIREAT', key, String(expireAt));
		}
	}
	return { action: 'copy', type: 'list', count: items.length, ttl };
}

async function migrateKey(key) {
	if (shouldSkip(key)) return { action: 'skip', reason: 'ephemeral key pattern' };

	const type = await cmd(DEAD_URL, DEAD_TOKEN, 'TYPE', key);

	switch (type) {
		case 'set':    return migrateSet(key);
		case 'string': return migrateString(key);
		case 'list':   return migrateList(key);
		case 'none':   return { action: 'skip', reason: 'key expired or missing in dead store' };
		default:       return { action: 'skip', reason: `unsupported type: ${type}` };
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	validateCredentials();

	const mode = DRY_RUN ? ' [DRY RUN]' : '';
	console.log(`\n── Redis migration${mode} ──────────────────────────────────────`);
	console.log(`  Dead store  : ${DEAD_URL}`);
	console.log(`  Active store: ${ACTIVE_URL}`);
	console.log('');

	// Collect all durable keys from the dead store.
	const allKeys = new Set();

	process.stdout.write('Scanning dead store…');
	for (const pattern of SCAN_PATTERNS) {
		const found = await scanAll(DEAD_URL, DEAD_TOKEN, pattern);
		for (const k of found) allKeys.add(k);
		process.stdout.write(` ${found.length} ${pattern}`);
	}

	// Check single list keys individually.
	for (const key of SINGLE_LIST_KEYS) {
		const exists = await cmd(DEAD_URL, DEAD_TOKEN, 'EXISTS', key);
		if (exists) allKeys.add(key);
	}

	console.log(`\n\nFound ${allKeys.size} durable keys in dead store.\n`);

	if (allKeys.size === 0) {
		console.log('Nothing to migrate — the dead store appears to have no durable keys.');
		console.log('If this is unexpected, verify that DEAD_REDIS_URL/TOKEN point to the correct store.');
		return;
	}

	// Migrate each key.
	const stats = { total: allKeys.size, copied: 0, skipped: 0, errors: 0 };
	const rows = [];

	for (const key of allKeys) {
		try {
			const result = await migrateKey(key);
			if (result.action === 'copy') {
				stats.copied++;
				const detail = result.count != null ? ` (${result.count} items)` : '';
				const ttlNote = result.ttl > 0 ? ` TTL=${result.ttl}s` : result.ttl === -1 ? ' no-TTL' : '';
				rows.push(`  COPY  ${key}${detail}${ttlNote}`);
			} else {
				stats.skipped++;
				rows.push(`  SKIP  ${key}  — ${result.reason}`);
			}
		} catch (err) {
			stats.errors++;
			rows.push(`  ERROR ${key}  — ${err.message}`);
		}
	}

	for (const row of rows) console.log(row);

	console.log('\n── Summary ──────────────────────────────────────────────────');
	console.log(`  Total scanned : ${stats.total}`);
	console.log(`  Copied        : ${stats.copied}`);
	console.log(`  Skipped       : ${stats.skipped}`);
	console.log(`  Errors        : ${stats.errors}`);
	if (DRY_RUN) {
		console.log('\n  (DRY RUN — nothing written to the active store)');
	} else if (stats.errors > 0) {
		console.log('\n  Migration finished with errors. Re-run to retry failed keys.');
		process.exit(1);
	} else {
		console.log('\n  Migration complete. Verify with docs/ops/redis.md post-migration checks.');
	}
}

main().catch(err => {
	console.error('\nFatal error:', err.message);
	process.exit(1);
});
