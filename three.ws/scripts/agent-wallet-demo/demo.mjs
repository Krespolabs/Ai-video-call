// Agent-wallet demo — record this terminal session.
//
// A scripted agent speaks the real MCP protocol to the @three-ws/avatar-agent
// server (registry: io.github.nirholas/3D-AI-Agent-Avatar) and, from a single
// natural-language goal, gives a 3D avatar a Solana wallet and pays another
// agent a real, on-chain amount of SOL on mainnet. Every tool result is live.
//
//   node scripts/agent-wallet-demo/setup.mjs   # once: grind + print fund addr
//   <fund the printed www… address with ~$1 of SOL>
//   node scripts/agent-wallet-demo/demo.mjs    # record this

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { connectAvatarAgent, callTool, REPO_ROOT, RPC_URL } from './mcp.mjs';

const WALLET_FILE = resolve(REPO_ROOT, 'scripts/agent-wallet-demo/wallet.local.json');
const SEND_SOL = Number(process.env.SEND_SOL || 0.001);
const PACE = Number(process.env.PACE ?? 650); // ms between narration lines (recording cadence; real work is unthrottled)

// ── tiny terminal UI ────────────────────────────────────────────────────────
const C = {
	reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
	purple: '\x1b[38;5;141m', green: '\x1b[38;5;120m', cyan: '\x1b[38;5;87m',
	yellow: '\x1b[38;5;221m', gray: '\x1b[38;5;245m', white: '\x1b[97m',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function say(line, color = C.white) {
	process.stdout.write(`${color}${line}${C.reset}\n`);
	if (PACE) await sleep(PACE);
}
async function think(line) {
	process.stdout.write(`${C.gray}  ${C.dim}🧠 ${line}${C.reset}\n`);
	if (PACE) await sleep(PACE);
}
function rule() {
	console.log(C.dim + '─'.repeat(68) + C.reset);
}
async function toolCall(client, name, args, note) {
	console.log(`\n${C.purple}  ▸ MCP tool call ${C.bold}${name}${C.reset}`);
	console.log(`${C.dim}    args: ${JSON.stringify(args)}${C.reset}`);
	if (note) console.log(`${C.gray}    ${note}${C.reset}`);
	const t0 = Date.now();
	const { data, isError } = await callTool(client, name, args);
	const ms = Date.now() - t0;
	const ok = !isError && data?.ok !== false;
	console.log(`${ok ? C.green : '\x1b[31m'}    ${ok ? '✓' : '✗'} ${name} ${C.dim}(${ms}ms)${C.reset}`);
    if (PACE) await sleep(Math.min(PACE, 400));
	return data;
}

// ── preflight ───────────────────────────────────────────────────────────────
if (!existsSync(WALLET_FILE)) {
	console.error(`${C.yellow}No wallet yet. Run:  node scripts/agent-wallet-demo/setup.mjs${C.reset}`);
	process.exit(1);
}
const sender = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));

console.clear();
console.log(`${C.purple}${C.bold}
  ╔══════════════════════════════════════════════════════════════════╗
  ║   three.ws · 3D AI Agent Avatar — MCP server                      ║
  ║   registry: io.github.nirholas/3D-AI-Agent-Avatar                 ║
  ║   an AI agent with a 3D body, a voice, and its own Solana wallet  ║
  ╚══════════════════════════════════════════════════════════════════╝${C.reset}`);
await sleep(PACE);

const { client, transport } = await connectAvatarAgent({ stderr: 'ignore' });
const tools = (await client.listTools()).tools;
const walletTools = tools.filter((t) => t.name.startsWith('wallet_')).map((t) => t.name);

await say(`\n  Connected to the MCP server over stdio — ${tools.length} live tools.`, C.cyan);
await say(`  Wallet tools available: ${walletTools.join(', ')}`, C.gray);
rule();
await say(`\n  ${C.bold}GOAL${C.reset}${C.white} (given to the agent in plain English):`);
await say(`  "Spawn your 3D avatar, check your wallet, then pay a brand-new agent ${SEND_SOL} SOL."`, C.yellow);
rule();

// ── 1. the agent gets a face ─────────────────────────────────────────────────
await think('First I should give myself a body so a human can see me.');
const avatar = await toolCall(client, 'spawn_avatar', { preset: 'cz', name: 'three.ws agent' });
if (avatar?.viewerUrl) await say(`    → my 3D avatar is live: ${C.cyan}${avatar.viewerUrl}${C.reset}`, C.white);

// ── 2. the agent reads its own wallet ────────────────────────────────────────
await think('Now, do I actually hold funds? Let me read my own Solana balance.');
const bal = await toolCall(client, 'wallet_balance', { pubkey: sender.pubkey, includeTokens: false },
	`my address: ${sender.pubkey}`);
const haveSol = Number(bal?.sol || 0);
await say(`    → balance: ${C.bold}${haveSol} SOL${C.reset}  ${C.dim}(solscan.io/account/${sender.pubkey})${C.reset}`, C.white);

if (haveSol < SEND_SOL + 0.0006) {
	rule();
	await say(`\n  ${C.yellow}My wallet needs funding. Send ~$1 of SOL (mainnet) to:${C.reset}`);
	await say(`    ${C.bold}${sender.pubkey}${C.reset}`, C.cyan);
	await say(`  Then re-run:  node scripts/agent-wallet-demo/demo.mjs`, C.gray);
	await transport.close();
	process.exit(0);
}

// ── 3. the agent spins up a counterparty wallet ──────────────────────────────
await think('I will pay a fresh agent. Let me mint it a vanity ws… wallet on the fly.');
const recipient = await toolCall(client, 'wallet_create', { vanityPrefix: 'ws', caseSensitive: false },
	'grinding a new keypair locally — no key is ever persisted by the server');
await say(`    → new agent wallet: ${C.bold}${recipient.pubkey}${C.reset} ${C.dim}(${recipient.vanity?.attempts} attempts)${C.reset}`, C.white);

// ── 4. the real on-chain payment ─────────────────────────────────────────────
rule();
await say(`\n  ${C.bold}Sending ${SEND_SOL} SOL on Solana mainnet…${C.reset}`, C.yellow);
await think('Signing with my own secret and broadcasting. This is a real transfer.');
const sent = await toolCall(client, 'wallet_send',
	{ to: recipient.pubkey, sol: SEND_SOL, secret: sender.secret },
	'building → signing → broadcasting → confirming on mainnet');

if (sent?.signature) {
	await say(`\n  ${C.green}${C.bold}✓ Confirmed on-chain.${C.reset}`);
	await say(`    signature: ${sent.signature}`, C.gray);
	await say(`    ${C.cyan}${C.bold}${sent.explorer}${C.reset}`);
} else {
	await say(`\n  ✗ send failed: ${JSON.stringify(sent)}`, '\x1b[31m');
	await transport.close();
	process.exit(1);
}

// ── 5. confirm the counterparty received it ──────────────────────────────────
await think('Did the other agent actually receive it? Verifying its balance.');
const rbal = await toolCall(client, 'wallet_balance', { pubkey: recipient.pubkey, includeTokens: false });
await say(`    → new agent now holds ${C.bold}${rbal?.sol ?? '?'} SOL${C.reset}`, C.white);

rule();
await say(`\n  ${C.purple}${C.bold}An AI agent — 3D body, own wallet — just paid another agent, autonomously,${C.reset}`);
await say(`  ${C.purple}${C.bold}through one MCP server from the official registry. All real. All on-chain.${C.reset}`);
await say(`\n  ${C.cyan}npx -y @three-ws/avatar-agent${C.reset}  ${C.dim}· three.ws${C.reset}\n`);

await transport.close();
process.exit(0);
