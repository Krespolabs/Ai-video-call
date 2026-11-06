// One-time setup for the agent-wallet demo.
//
// Dogfoods the real MCP server: calls the `wallet_create` tool to grind a
// vanity `www…` Solana wallet, then writes it to wallet.local.json (gitignored)
// and prints the address you fund with ~$1 of SOL before recording.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { connectAvatarAgent, callTool, REPO_ROOT, RPC_URL } from './mcp.mjs';

const OUT = resolve(REPO_ROOT, 'scripts/agent-wallet-demo/wallet.local.json');
const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;

const { client, transport } = await connectAvatarAgent({ stderr: 'inherit' });

console.log(c('36', '\n▸ Asking the MCP server to grind a vanity www… wallet (wallet_create)…\n'));
const { data, isError } = await callTool(client, 'wallet_create', {
	vanityPrefix: 'www',
	caseSensitive: false,
	maxAttempts: 2_000_000,
});

if (isError || !data.ok) {
	console.error(c('31', 'wallet_create failed:'), data);
	await transport.close();
	process.exit(1);
}

const record = {
	pubkey: data.pubkey,
	secret: data.secret,
	rpc: RPC_URL,
	createdBy: 'wallet_create (vanity www, case-insensitive)',
	vanity: data.vanity,
};
writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');

console.log(c('32', '✓ Wallet created and saved to scripts/agent-wallet-demo/wallet.local.json (gitignored)\n'));
console.log('  Address :', c('1', data.pubkey));
console.log('  Vanity  :', `${data.vanity?.attempts?.toLocaleString?.() ?? '?'} attempts in ${data.vanity?.durationMs ?? '?'}ms`);
console.log('  Explorer:', `https://solscan.io/account/${data.pubkey}`);
console.log(c('33', '\n  ▶ Fund this address with ~$1 of SOL on MAINNET, then run:  node scripts/agent-wallet-demo/demo.mjs\n'));

await transport.close();
process.exit(0);
