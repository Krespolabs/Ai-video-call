#!/usr/bin/env node
// scripts/economy-ledger-export.mjs
//
// Accounting export for the economy master funding wallet's tamper-evident ledger
// (api/_lib/economy-master.js → economy_master_ledger). Emits every recorded money
// event over a window as CSV (default) or JSON, with the running balance and the
// USD value captured at the instant of each transfer — the record an accountant or
// auditor reads. Optionally re-verifies the hash chain first.
//
// Auth: reads DATABASE_URL from the environment (Neon). Never prints secrets.
//
// Usage:
//   node scripts/economy-ledger-export.mjs                         # all rows, CSV
//   node scripts/economy-ledger-export.mjs --from 2026-07-01 --to 2026-07-31
//   node scripts/economy-ledger-export.mjs --event transfer --format json
//   node scripts/economy-ledger-export.mjs --verify                # check chain integrity
//   node scripts/economy-ledger-export.mjs --from 2026-07-01 > july.csv

import { readLedger, verifyChain } from '../api/_lib/economy-ledger.js';

const DEFAULT_MASTER = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';

function parseArgs(argv) {
	const a = { format: 'csv', master: process.env.ECONOMY_MASTER_ADDRESS || DEFAULT_MASTER, from: null, to: null, event: null, verify: false };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--verify') a.verify = true;
		else if (k === '--format') a.format = argv[++i];
		else if (k === '--master') a.master = argv[++i];
		else if (k === '--from') a.from = argv[++i];
		else if (k === '--to') a.to = argv[++i];
		else if (k === '--event') a.event = argv[++i];
		else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
	}
	return a;
}

function printHelp() {
	console.log('Usage: node scripts/economy-ledger-export.mjs [--from DATE] [--to DATE] [--event transfer|failed|blocked|sweep] [--master ADDR] [--format csv|json] [--verify]');
}

const CSV_COLS = [
	'seq', 'ts', 'event', 'target_name', 'target_pubkey', 'lamports', 'sol',
	'sol_usd', 'usd_value', 'tx_signature', 'reason', 'master_sol_before',
	'master_sol_after', 'run_id', 'entry_hash',
];

function csvCell(v) {
	if (v == null) return '';
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL is not set. Export it or add it to .env.local.');
		process.exit(1);
	}
	const args = parseArgs(process.argv);

	if (args.verify) {
		const v = await verifyChain(args.master);
		if (v.ok) {
			console.error(`✓ chain intact — ${v.count} rows, head seq ${v.headSeq}, head hash ${String(v.headHash).slice(0, 16)}…`);
		} else {
			const where = v.brokenAtSeq != null ? `broken at seq ${v.brokenAtSeq}` : `gap before seq ${v.gapAtSeq}`;
			console.error(`✗ CHAIN INTEGRITY FAILURE — ${where}. The ledger has been altered.`);
			process.exit(2);
		}
	}

	const rows = await readLedger({ masterPubkey: args.master, from: args.from, to: args.to, event: args.event });

	// Accounting totals over the window (transfers only are real money out).
	let outSol = 0;
	let outUsd = 0;
	for (const r of rows) {
		if (r.event === 'transfer') {
			outSol += Number(r.sol || 0);
			outUsd += Number(r.usd_value || 0);
		}
	}

	if (args.format === 'json') {
		process.stdout.write(JSON.stringify({
			master: args.master,
			from: args.from,
			to: args.to,
			rows,
			totals: { transfers: rows.filter((r) => r.event === 'transfer').length, sol_out: outSol, usd_out: outUsd },
		}, null, 2) + '\n');
	} else {
		process.stdout.write(CSV_COLS.join(',') + '\n');
		for (const r of rows) process.stdout.write(CSV_COLS.map((c) => csvCell(r[c])).join(',') + '\n');
	}

	console.error(`\n${rows.length} rows · ${outSol.toFixed(6)} SOL out ($${outUsd.toFixed(2)}) · master ${args.master}`);
}

main().catch((e) => {
	console.error('export failed:', e?.message || e);
	process.exit(1);
});
