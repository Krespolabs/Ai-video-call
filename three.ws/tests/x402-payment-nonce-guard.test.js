// Every server-side payment builder call must choose its nonce.
//
// buildPaymentTx() is deterministic by design (a retry rebuilds the same bytes),
// so its default nonce is 0. Two payments with the same payer, payTo, mint and
// amount, signed against the same blockhash with nonce 0, compile to one
// transaction and one Ed25519 signature: only the first can land, and the
// facilitator refuses the rest with `signature_already_settled`. The autonomous
// loop and the pipelines it runs all sign against one tick-wide blockhash, so
// that is not a corner case. Measured on production 2026-09-30: 51 such
// refusals in 20 minutes, which the loop recorded as `http_502` and which were
// the whole of the settle sensor's rail faults behind a degraded 74.9%.
//
// A source-level guard, because the failure only shows up on mainnet with two
// same-priced entries in one tick: it pins that every buildPaymentTx({...}) call
// under api/ names a nonce, so a new caller cannot silently fall back to 0.

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function listJs(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listJs(full)));
		else if (entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}

// The argument object of each `buildPaymentTx({ ... })` call, found by brace
// matching from the call's opening brace.
function callArguments(source) {
	const calls = [];
	const re = /buildPaymentTx\(\s*\{/g;
	let match;
	while ((match = re.exec(source))) {
		if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
		let depth = 0;
		let i = match.index + match[0].length - 1;
		const start = i;
		for (; i < source.length; i += 1) {
			if (source[i] === '{') depth += 1;
			else if (source[i] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		calls.push(source.slice(start, i + 1));
	}
	return calls;
}

describe('payment nonce guard', () => {
	it('every buildPaymentTx call under api/ passes an explicit nonce', async () => {
		const files = await listJs('api');
		const offenders = [];
		let seen = 0;
		for (const file of files) {
			const source = await readFile(file, 'utf8');
			if (!source.includes('buildPaymentTx(')) continue;
			for (const args of callArguments(source)) {
				seen += 1;
				if (!/\bnonce\s*[:,}]/.test(args)) offenders.push(`${file}: ${args.replace(/\s+/g, ' ').slice(0, 120)}`);
			}
		}
		// The loop, three pipelines, the seed cron, payX402, the wallet bridge and
		// the inference top-up: if this drops, the scan stopped finding callers.
		expect(seen).toBeGreaterThanOrEqual(8);
		expect(offenders).toEqual([]);
	});

	// The same tick-wide blockhash is also why these callers must re-read it. A
	// tick runs its entries in sequence for up to about four minutes, and a hash
	// read at the top of it is past its ~60 second validity by the later ones:
	// 16 `BlockhashNotFound` broadcast failures in 90 minutes on 2026-09-30.
	it('every payment signed inside a loop tick uses the freshness-cached blockhash', async () => {
		for (const file of [
			'api/cron/x402-autonomous-loop.js',
			'api/_lib/x402/pipelines/streaming-mcp-health.js',
			'api/_lib/x402/pipelines/payment-proof-idempotency-audit.js',
			'api/_lib/x402/pipelines/builder-code-attribution.js',
		]) {
			const source = await readFile(file, 'utf8');
			for (const args of callArguments(source)) {
				expect(args, file).toMatch(/blockhash:\s*signBlockhash/);
			}
			expect(source, file).toMatch(/const signBlockhash = await currentBlockhash\(conn, blockhash\)/);
		}
	});
});
