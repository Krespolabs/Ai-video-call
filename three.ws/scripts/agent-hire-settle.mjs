#!/usr/bin/env node
// Real end-to-end agent-to-agent commerce settlement driver.
//
// Drives the FULL, live loop against the three.ws MCP server: discover a
// reputation-ranked agent, then hire it — quoting the price, settling REAL USDC
// on Solana mainnet via the x402 `exact` scheme, running the remote agent, and
// printing the result plus the on-chain settlement reference. No mock payment:
// a funded Solana wallet signs a real transfer, the platform facilitator settles
// it, and the transaction lands on-chain (Solscan link printed).
//
// This is the operator's one-command proof of the commerce loop. It talks to the
// LOCAL stdio server (the published @three-ws/mcp-server package) by default, so
// it exercises exactly what a Claude Desktop / connector user runs.
//
// ── What you need ────────────────────────────────────────────────────────────
//   1. A funded Solana wallet (a few cents of USDC; the platform fee-payer covers
//      the network fee, so no SOL is required). Provide its secret key as:
//        X402_BUYER_SOLANA_SECRET_BASE58=<base58 secret>      (preferred)
//      or a JSON byte-array keypair file:
//        X402_BUYER_SOLANA_KEYPAIR=/path/to/keypair.json
//   2. A platform delegation credential so the hire's remote agent can run
//      (the talk endpoint burns platform LLM credit and requires a principal):
//        MCP_AGENT_TALK_TOKEN=sk_live_...        (an api_keys token, scope agents:delegate)
//   3. A hireable agent id (its embed_policy.surfaces.mcp must be true):
//        HIRE_AGENT_ID=<uuid>                    (optional — otherwise discovery picks one)
//
// ── Run ──────────────────────────────────────────────────────────────────────
//   MCP_SVM_PAYMENT_ADDRESS=<treasury> \
//   X402_BUYER_SOLANA_SECRET_BASE58=<secret> \
//   MCP_AGENT_TALK_TOKEN=sk_live_... \
//   node scripts/agent-hire-settle.mjs "summarise recent solana sentiment in 3 bullets"
//
// Writes the full transcript + settlement reference to
// prompts/store-submissions/_generated/commerce/settlement-<ts>.json when
// COMMERCE_EVIDENCE_DIR is set.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import bs58 from 'bs58';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { wrapMCPClientWithPayment, extractPaymentResponseFromMeta } from '@x402/mcp';

const bs58decode = bs58.default ? bs58.default.decode : bs58.decode;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const TASK = process.argv[2] || 'summarise recent solana token market sentiment in 3 bullets';
const HIRE_MESSAGE =
	process.env.HIRE_MESSAGE || 'In two sentences, what can you help a three.ws user accomplish?';

function fail(msg, code = 2) {
	console.error(`\n✖ ${msg}`);
	process.exit(code);
}

// Read a tool result's structured payload robustly: prefer structuredContent,
// fall back to a JSON text block, and never throw on a non-JSON content block
// (a PaymentRequired challenge or a plain-text error surfaces as { _raw }).
function readResult(res) {
	if (res?.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
	const text = res?.content?.find((c) => c?.type === 'text')?.text;
	if (typeof text === 'string') {
		try {
			return JSON.parse(text);
		} catch {
			return { _raw: text };
		}
	}
	return {};
}

async function loadBuyerSigner() {
	const b58 = process.env.X402_BUYER_SOLANA_SECRET_BASE58;
	const file = process.env.X402_BUYER_SOLANA_KEYPAIR;
	let secret;
	if (b58 && b58.trim()) {
		secret = Uint8Array.from(bs58decode(b58.trim()));
	} else if (file && existsSync(file)) {
		secret = Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')));
	} else {
		fail(
			'no buyer wallet — set X402_BUYER_SOLANA_SECRET_BASE58 (base58 secret) or ' +
				'X402_BUYER_SOLANA_KEYPAIR (JSON byte-array keypair file). Fund it with a few cents of USDC on Solana.',
		);
	}
	// @solana/kit signer wants the 64-byte secret key (seed + pubkey).
	return createKeyPairSignerFromBytes(secret);
}

async function main() {
	const signer = await loadBuyerSigner();
	console.log(`[commerce] buyer wallet: ${signer.address}`);

	// x402 client with the Solana `exact` scheme registered against the buyer.
	const paymentClient = new x402Client();
	registerExactSvmScheme(paymentClient, {
		signer,
		...(process.env.SOLANA_RPC ? { config: { rpcUrl: process.env.SOLANA_RPC } } : {}),
	});

	// Spawn the local stdio MCP server (the published package) and connect.
	const transport = new StdioClientTransport({
		command: 'node',
		args: [join(REPO, 'mcp-server', 'src', 'index.js')],
		env: {
			...process.env,
			MCP_SVM_PAYMENT_ADDRESS:
				process.env.MCP_SVM_PAYMENT_ADDRESS || process.env.X402_PAY_TO_SOLANA || '',
		},
	});
	const raw = new Client({ name: 'agent-hire-settle', version: '1.0.0' }, { capabilities: {} });
	await raw.connect(transport);

	// Wrap the MCP client so any PaymentRequired auto-pays via x402 and retries.
	const client = wrapMCPClientWithPayment(raw, paymentClient);

	// ── 1) Discover + reputation-rank (paid $0.01) ──────────────────────────────
	console.log(`[commerce] discovering agents for: "${TASK}"`);
	const discRes = await client.callTool('agent_hire_discover', { task: TASK, limit: 5 });
	const disc = readResult(discRes);
	if (disc.x402Version != null || disc.error === 'Payment required to access this tool') {
		fail('discovery could not be paid — the buyer wallet has insufficient USDC on Solana (fund it and retry)', 1);
	}
	if (!disc.ok || !disc.candidates?.length) {
		fail(`discovery returned no candidates: ${disc.note || disc._raw || 'unknown'}`);
	}
	const chosen =
		process.env.HIRE_AGENT_ID ||
		disc.candidates[0].agentId;
	const chosenName =
		disc.candidates.find((c) => c.agentId === chosen)?.name || chosen;
	console.log(
		`[commerce] top candidate: ${chosenName} (${chosen}) — score ${disc.candidates[0].score}, ` +
			`${disc.candidates[0].evidence}`,
	);

	// ── 2) Hire end to end (paid $0.05, real USDC settlement) ───────────────────
	console.log(`[commerce] hiring ${chosenName} — settling real USDC…`);
	const t0 = Date.now();
	const hireRes = await client.callTool('agent_hire', { agentId: chosen, message: HIRE_MESSAGE });
	const ms = Date.now() - t0;
	const hire = readResult(hireRes);

	if (hireRes.isError || hire.ok === false) {
		fail(`hire failed (payment cancelled, not charged): ${hire.error} — ${hire.message}`, 1);
	}

	// The real on-chain settlement reference is attached by the x402 wrapper.
	const settlement = extractPaymentResponseFromMeta(hireRes._meta) || hireRes._meta?.['x402/payment-response'] || null;
	const txRef =
		settlement?.transaction || settlement?.signature || settlement?.txHash || settlement?.tx || null;

	console.log('\n──────────────── PROVENANCE RECEIPT ────────────────');
	console.log(`  agent:       ${hire.agentName} (${hire.agentId})`);
	if (hire.provenance?.reputation)
		console.log(
			`  reputation:  ${hire.provenance.reputation.average} across ${hire.provenance.reputation.count} on ${hire.provenance.reputation.chain}`,
		);
	console.log(`  paid:        ${hire.provenance?.payment?.amountDisplay} ${hire.provenance?.payment?.asset} on ${hire.provenance?.payment?.networkLabel}`);
	console.log(`  settlement:  ${txRef || '(not found in _meta — see raw payload)'}`);
	if (txRef) console.log(`  explorer:    https://solscan.io/tx/${txRef}`);
	console.log(`  latency:     ${(ms / 1000).toFixed(1)}s`);
	console.log(`  result:      ${(hire.result?.response || '').slice(0, 240)}`);
	console.log('────────────────────────────────────────────────────\n');

	const evidenceDir = process.env.COMMERCE_EVIDENCE_DIR;
	if (evidenceDir) {
		mkdirSync(evidenceDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const out = join(evidenceDir, `settlement-${stamp}.json`);
		writeFileSync(
			out,
			JSON.stringify(
				{
					task: TASK,
					buyer: signer.address,
					discover: disc,
					hire,
					settlement,
					settlementTx: txRef,
					explorer: txRef ? `https://solscan.io/tx/${txRef}` : null,
					capturedAt: new Date().toISOString(),
				},
				null,
				2,
			),
		);
		console.log(`[commerce] evidence written: ${out}`);
	}

	await raw.close();
	if (!txRef) {
		fail('hire succeeded but no on-chain settlement reference was returned — check facilitator config', 1);
	}
	console.log('✓ Real agent-to-agent commerce loop complete: discovered → paid → delegated → settled.');
	process.exit(0);
}

main().catch((e) => fail(e?.stack || e?.message || String(e), 1));
