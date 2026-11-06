// Pure-logic tests for the economy master accounting ledger
// (api/_lib/economy-ledger.js): row construction from a sweep result, the running
// balance, USD valuation, and the SHA-256 hash chain's tamper-evidence. No DB.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSweepRows, hashEntry } from '../api/_lib/economy-ledger.js';

const MASTER = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';

function sampleResult() {
	return {
		configured: true,
		master: MASTER,
		masterSol: 10,
		reserveSol: 1,
		spendableSol: 9,
		funded: [
			{ name: 'a2a-payer', pubkey: 'AAA', sol: 0.5, signature: 'sigA' },
			{ name: 'club-treasury', pubkey: 'BBB', sol: 0.25, signature: 'sigB' },
		],
		failed: [{ name: 'launcher', pubkey: 'CCC', sol: 0.5, reason: 'blockhash_expired' }],
		rejected: [{ name: 'evil', pubkey: 'EVIL', reason: 'not_in_registry' }],
		skipped: [{ name: 'hair', reason: 'below_dust_threshold' }],
		spentSol: 0.75,
	};
}

test('buildSweepRows: one row per transfer/failed/blocked + a sweep summary', () => {
	const rows = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 200, now: 1_000_000 });
	assert.equal(rows.filter((r) => r.event === 'transfer').length, 2);
	assert.equal(rows.filter((r) => r.event === 'failed').length, 1);
	assert.equal(rows.filter((r) => r.event === 'blocked').length, 1);
	assert.equal(rows.filter((r) => r.event === 'sweep').length, 1);
});

test('running balance decrements across transfers; sweep row holds the final', () => {
	const rows = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 200, now: 1_000_000 });
	const transfers = rows.filter((r) => r.event === 'transfer');
	assert.equal(transfers[0].master_sol_before, 10);
	assert.equal(transfers[0].master_sol_after, 9.5); // 10 - 0.5
	assert.equal(transfers[1].master_sol_after, 9.25); // 9.5 - 0.25
	const sweep = rows.find((r) => r.event === 'sweep');
	assert.equal(sweep.master_sol_after, 9.25);
	assert.equal(sweep.detail.spent_sol, 0.75);
});

test('USD valuation is captured at the transfer instant', () => {
	const rows = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 200, now: 1_000_000 });
	const t = rows.find((r) => r.event === 'transfer');
	assert.equal(t.sol_usd, 200);
	assert.equal(t.usd_value, 100); // 0.5 SOL × $200
});

test('an unpriced sweep (solUsd 0) records null valuations, not a guess', () => {
	const rows = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 0, now: 1 });
	const t = rows.find((r) => r.event === 'transfer');
	assert.equal(t.sol_usd, null);
	assert.equal(t.usd_value, null);
});

test('a no-op sweep still writes the heartbeat summary row', () => {
	const rows = buildSweepRows({
		masterPubkey: MASTER,
		result: { configured: true, master: MASTER, masterSol: 5, funded: [], failed: [], rejected: [], skipped: [], spentSol: 0 },
		solUsd: 100,
		now: 1,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, 'sweep');
});

// Simulate recordSweep's chaining, then assert tamper-evidence.
function chain(rows, startSeq = 0, startHash = '') {
	let prevHash = startHash;
	let seq = startSeq;
	return rows.map((r) => {
		const row = { ...r, seq: ++seq, prev_hash: prevHash };
		row.entry_hash = hashEntry(prevHash, row);
		prevHash = row.entry_hash;
		return row;
	});
}

test('hash chain: each entry_hash recomputes from the row + prev_hash', () => {
	const built = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 200, now: 1_000_000 });
	const chained = chain(built);
	let prev = '';
	for (const row of chained) {
		assert.equal(row.prev_hash, prev);
		assert.equal(hashEntry(prev, row), row.entry_hash); // reproducible
		prev = row.entry_hash;
	}
});

test('tamper: editing a recorded amount breaks the chain from that row on', () => {
	const built = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 200, now: 1_000_000 });
	const chained = chain(built);
	const victim = chained.find((r) => r.event === 'transfer');
	// Attacker rewrites the resulting balance to hide a drain.
	const tampered = { ...victim, master_sol_after: 9.9 };
	assert.notEqual(hashEntry(tampered.prev_hash, tampered), victim.entry_hash);
});

test('tamper: swapping the recipient of a transfer is detectable', () => {
	const built = buildSweepRows({ masterPubkey: MASTER, result: sampleResult(), solUsd: 200, now: 1_000_000 });
	const chained = chain(built);
	const victim = chained.find((r) => r.event === 'transfer');
	const tampered = { ...victim, target_pubkey: 'ATTACKER_WALLET' };
	assert.notEqual(hashEntry(tampered.prev_hash, tampered), victim.entry_hash);
});
