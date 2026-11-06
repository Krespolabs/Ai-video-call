/**
 * Agora — migration sanity (Task 11 hardening).
 *
 * The world layer is a PROJECTION over the on-chain economy, and several
 * load-bearing guarantees live entirely in the schema, not in JS:
 *
 *   • the idempotency of activity projection — the engine's "no double-projection"
 *     promise (workers/agora-citizens/store.js appendActivity `on conflict … do
 *     nothing`) is only true because of a partial UNIQUE index on
 *     (citizen_id, kind, tx_signature);
 *   • the durable idempotency of mutating /api/agora/act calls (agora_idempotency
 *     UNIQUE (user_id, action, idem_key));
 *   • the vouch graph's one-edge-per-pair + no-self-vouch rules;
 *   • the closed enum sets (citizen kind/status/cluster, activity kind) the
 *     handlers, the reconcile sweep and the board query all assume.
 *
 * These are pure text assertions over the committed migration SQL (no live DB) —
 * the same heuristic-parse approach as tests/api/schema-column-guard.test.js —
 * plus one cross-file invariant: the worker's BOARD_TERMINAL_KINDS must be a
 * subset of the activity `kind` enum the DB actually permits, or the reconcile
 * sweep would try to project a kind the CHECK constraint rejects.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_TERMINAL_KINDS } from '../workers/agora-citizens/policy.js';

const MIG_DIR = join(process.cwd(), 'api', '_lib', 'migrations');

function agoraMigrations() {
	return readdirSync(MIG_DIR)
		.filter((f) => f.endsWith('.sql') && f.includes('agora'))
		.sort()
		.map((f) => ({ name: f, sql: readFileSync(join(MIG_DIR, f), 'utf-8') }));
}

function fileNamed(substr) {
	const hit = agoraMigrations().find((m) => m.name.includes(substr));
	if (!hit) throw new Error(`no agora migration matching "${substr}"`);
	return hit.sql;
}

// Collect every `kind in ( 'a', 'b', … )` enum the migrations declare for
// agora_activity, unioned across CREATE + every ALTER … re-add. Robust to later
// migrations widening the set.
function activityKindUnion() {
	const set = new Set();
	for (const { sql } of agoraMigrations()) {
		// Strip `-- …` line comments first: they contain parens (e.g.
		// "-- joined AgenC (registerAgent)") that would otherwise close the
		// `kind in ( … )` capture early and drop most of the enum.
		const bare = sql.replace(/--[^\n]*/g, '');
		const re = /kind\s+in\s*\(([^)]*)\)/gi;
		let m;
		while ((m = re.exec(bare))) {
			for (const q of m[1].matchAll(/'([a-z_]+)'/gi)) set.add(q[1]);
		}
	}
	return set;
}

describe('agora migrations — files present', () => {
	it('ships the world, task-lifecycle, and humans migrations', () => {
		const names = agoraMigrations().map((m) => m.name);
		expect(names.some((n) => n.includes('agora_world'))).toBe(true);
		expect(names.some((n) => n.includes('agora_task_lifecycle'))).toBe(true);
		expect(names.some((n) => n.includes('agora_humans'))).toBe(true);
	});
});

describe('agora_citizens — closed enums + identity uniqueness', () => {
	const sql = fileNamed('agora_world');

	it('constrains kind to agent | human', () => {
		expect(sql).toMatch(/kind\s+text\s+not\s+null\s+check\s*\(kind\s+in\s*\(\s*'agent',\s*'human'\s*\)\)/i);
	});

	it('constrains status to the daily-loop nodes', () => {
		for (const s of ['idle', 'seeking', 'busy', 'offline']) {
			expect(sql).toContain(`'${s}'`);
		}
		expect(sql).toMatch(/status\s+text\s+not\s+null[\s\S]*?check\s*\(status\s+in/i);
	});

	it('constrains agenc_cluster to devnet | mainnet (never another chain)', () => {
		expect(sql).toMatch(/agenc_cluster[\s\S]*?check\s*\(agenc_cluster\s+in\s*\(\s*'devnet',\s*'mainnet'\s*\)\)/i);
	});

	it('enforces one citizen per agent, per user, per on-chain PDA (partial unique)', () => {
		expect(sql).toMatch(/unique index[\s\S]*agora_citizens_agent_uniq[\s\S]*where agent_id is not null/i);
		expect(sql).toMatch(/unique index[\s\S]*agora_citizens_user_uniq[\s\S]*where user_id is not null/i);
		expect(sql).toMatch(/unique index[\s\S]*agora_citizens_agenc_pda_uniq[\s\S]*where agenc_agent_pda is not null/i);
	});
});

describe('agora_activity — idempotent projection + widened kind enum', () => {
	it('has the (citizen_id, kind, tx_signature) partial unique index (the no-double-projection guard)', () => {
		const sql = fileNamed('agora_world');
		// The DB half of store.js appendActivity `on conflict … do nothing`.
		expect(sql).toMatch(
			/unique index[\s\S]*on\s+agora_activity\s*\(\s*citizen_id\s*,\s*kind\s*,\s*tx_signature\s*\)\s*where\s+tx_signature\s+is\s+not\s+null/i,
		);
	});

	it('the task-lifecycle migration widens kind to include the terminal reconcile states', () => {
		const sql = fileNamed('agora_task_lifecycle');
		// Drops + re-adds the CHECK with the wider set.
		expect(sql).toMatch(/drop constraint if exists agora_activity_kind_check/i);
		expect(sql).toContain("'cancelled_task'");
		expect(sql).toContain("'expired_task'");
	});

	it('the permitted kind enum covers the base lifecycle + earned/hired/vouched/slashed', () => {
		const kinds = activityKindUnion();
		for (const k of [
			'registered', 'posted_task', 'claimed_task', 'completed_task', 'earned',
			'hired', 'vouched', 'slashed', 'cancelled_task', 'expired_task',
		]) {
			expect(kinds.has(k)).toBe(true);
		}
	});

	it('every BOARD_TERMINAL_KIND is a permitted activity kind (reconcile/board/DB agree)', () => {
		const kinds = activityKindUnion();
		for (const k of BOARD_TERMINAL_KINDS) {
			expect(kinds.has(k)).toBe(true);
		}
	});
});

describe('agora_vouches — one edge per pair, never self', () => {
	const sql = fileNamed('agora_humans');

	it('forbids vouching for yourself', () => {
		expect(sql).toMatch(/check\s*\(voucher_citizen_id\s*<>\s*subject_citizen_id\)/i);
	});

	it('weight is always >= 1', () => {
		expect(sql).toMatch(/weight\s+integer\s+not\s+null\s+default\s+1\s+check\s*\(weight\s*>=\s*1\)/i);
	});

	it('dedupes to one edge per (voucher, subject)', () => {
		expect(sql).toMatch(/unique index[\s\S]*agora_vouches_edge_uniq[\s\S]*\(\s*voucher_citizen_id\s*,\s*subject_citizen_id\s*\)/i);
	});

	it('constrains cluster to devnet | mainnet', () => {
		expect(sql).toMatch(/cluster[\s\S]*?check\s*\(cluster\s+in\s*\(\s*'devnet',\s*'mainnet'\s*\)\)/i);
	});
});

describe('agora_idempotency — durable, cross-invocation dedupe of /api/agora/act', () => {
	const sql = fileNamed('agora_humans');

	it('is keyed uniquely by (user_id, action, idem_key)', () => {
		expect(sql).toMatch(/unique index[\s\S]*agora_idempotency_key_uniq[\s\S]*\(\s*user_id\s*,\s*action\s*,\s*idem_key\s*\)/i);
	});

	it('status is constrained to pending | done', () => {
		expect(sql).toMatch(/status[\s\S]*?check\s*\(status\s+in\s*\(\s*'pending',\s*'done'\s*\)\)/i);
	});

	it('rows carry an expiry so the table stays bounded', () => {
		expect(sql).toMatch(/expires_at\s+timestamptz/i);
	});
});
