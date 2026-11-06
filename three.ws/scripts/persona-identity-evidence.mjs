#!/usr/bin/env node
// Evidence capture for prompt 17 — embodied on-chain identity.
//
// Exercises the REAL persona_identity / persona_tip / persona_send MCP tool
// handlers (api/_mcp3d/tools/persona-identity.js) against REAL Solana devnet —
// no mocks, no fabricated signatures. Writes a full JSON transcript of every
// call to prompts/store-submissions/_generated/identity/transcript.json, then
// greps the ENTIRE transcript for any private-key-shaped string as the
// key-never-leaked proof required by the prompt's verification section.
//
// Run: node scripts/persona-identity-evidence.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JWT_SECRET ||= 'evidence-run-jwt-secret-0123456789abcdef';
process.env.PERSONA_WALLET_SECRET ||= 'evidence-run-persona-wallet-secret-0123456789';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'prompts', 'store-submissions', '_generated', 'identity');
mkdirSync(outDir, { recursive: true });

const { createPersona } = await import('../api/_lib/persona-store.js');
const { toolDefs } = await import('../api/_mcp3d/tools/persona-identity.js');
const { personaWalletAddress } = await import('../api/_lib/persona-wallet.js');
const { solanaConnection } = await import('../api/_lib/agent-pumpfun.js');
const { PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');

const handlers = Object.fromEntries(toolDefs.map((t) => [t.name, t.handler]));
const auth = { userId: null, rateKey: 'evidence-script', scope: '' };
const transcript = [];

function log(step, call, result) {
	console.log(`\n=== ${step} ===`);
	console.log(JSON.stringify(result, null, 2));
	transcript.push({ step, call, result, at: new Date().toISOString() });
}

// 1. Mint a real persona (bypasses the MCP glb-fetch validation the same way
//    createPersona always has — no S3/R2 configured locally, so the GLB is
//    referenced, not fetched).
const persona = await createPersona({
	name: 'Evidence Agent',
	glbUrl: 'https://example.invalid/evidence-agent.glb',
	sourcePrompt: 'prompt 17 embodied on-chain identity evidence run',
});
console.log(`Persona minted: ${persona.id} (${persona.name})`);

const derivedAddress = personaWalletAddress(persona.id);
console.log(`Deterministically derived wallet: ${derivedAddress}`);

// 2. Read identity on devnet — BEFORE funding. Real RPC, real (zero) balance.
const before = await handlers.persona_identity({ persona_id: persona.id, network: 'devnet' }, auth);
log('persona_identity — before funding (real devnet RPC)', { persona_id: persona.id, network: 'devnet' }, before.structuredContent);

// 3. Fund the derived wallet with a REAL devnet SOL airdrop (best-effort — the
//    devnet faucet is IP rate-limited; a failure here is reported honestly,
//    not masked).
let airdrop = { ok: false, reason: 'not_attempted' };
try {
	const conn = solanaConnection('devnet');
	const sig = await conn.requestAirdrop(new PublicKey(derivedAddress), LAMPORTS_PER_SOL / 10); // 0.1 SOL
	await conn.confirmTransaction(sig, 'confirmed');
	airdrop = { ok: true, signature: sig, sol: 0.1 };
} catch (e) {
	airdrop = { ok: false, reason: /429|limit/i.test(String(e?.message)) ? 'faucet_rate_limited' : 'faucet_unavailable', message: String(e?.message || e) };
}
log('devnet SOL airdrop to the derived persona wallet (real faucet call)', { to: derivedAddress, sol: 0.1 }, airdrop);

// 4. Read identity again — proves the balance read is LIVE, not cached, when
//    the airdrop landed.
const after = await handlers.persona_identity({ persona_id: persona.id, network: 'devnet' }, auth);
log('persona_identity — after funding attempt (real devnet RPC)', { persona_id: persona.id, network: 'devnet' }, after.structuredContent);

// 5. Guardrail: an absurd amount is blocked by the per-call cap BEFORE any
//    signature is built — no funding required to prove this.
// A second, independently-derived persona wallet as the tip destination — a
// real, valid Solana address distinct from the sender, minted the same way.
const dest = personaWalletAddress('persona_evidencerecipient1');
const overCap = await handlers.persona_tip({ persona_id: persona.id, to: dest, usdc: 999, network: 'devnet' }, auth);
log('persona_tip — over the per-call cap (real guardrail enforcement)', { persona_id: persona.id, to: dest, usdc: 999 }, overCap.structuredContent);

// 6. Guardrail: an in-cap but above-threshold amount requires confirm:true.
const needsConfirm = await handlers.persona_tip({ persona_id: persona.id, to: dest, usdc: 0.5 }, auth);
log('persona_tip — above the confirmation threshold, confirm omitted (real guardrail enforcement)', { persona_id: persona.id, to: dest, usdc: 0.5 }, needsConfirm.structuredContent);

// 7. Real settlement attempt, in-cap, confirmed. With a freshly derived wallet
//    holding no USDC, this is EXPECTED to fail honestly on-chain (insufficient
//    funds) — the documented funding blocker, not a fabricated success.
const attemptSend = await handlers.persona_tip({ persona_id: persona.id, to: dest, usdc: 0.05, confirm: true, network: 'devnet' }, auth);
log('persona_tip — real settlement attempt, confirmed (expected: insufficient USDC — the funding blocker)', { persona_id: persona.id, to: dest, usdc: 0.05, confirm: true }, attemptSend.structuredContent);

// ── write transcript + key-leak grep proof ────────────────────────────────
const transcriptPath = join(outDir, 'transcript.json');
writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
console.log(`\nTranscript written: ${transcriptPath}`);

const fullText = JSON.stringify(transcript);
// A raw Solana secret key is either a 64-byte JSON array or an ~87-88 char
// base58 string. Scan for both shapes, and for any field name that would
// indicate key material, anywhere in the ENTIRE captured transcript.
const suspiciousPatterns = [
	{ label: '64-int JSON byte array (raw secret key)', re: /\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/ },
	{ label: '87-88 char base58 secret-shaped string', re: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/ },
	{ label: 'a field literally named secret/secretKey/privateKey', re: /"(secret|secretKey|privateKey|private_key|seed)"\s*:/i },
];
let clean = true;
for (const { label, re } of suspiciousPatterns) {
	const hit = re.test(fullText);
	console.log(`${hit ? 'FAIL' : 'OK  '} — ${label}: ${hit ? 'MATCH FOUND' : 'no match'}`);
	if (hit) clean = false;
}
console.log(clean ? '\nKEY-NEVER-LEAKED: transcript is clean.' : '\nKEY-NEVER-LEAKED: FAILED — investigate immediately.');
if (!clean) process.exitCode = 1;
