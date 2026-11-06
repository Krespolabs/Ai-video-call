// Shared MCP client helper for the agent-wallet demo.
//
// Boots the real `@three-ws/avatar-agent` MCP server (the one published to
// the official MCP registry as io.github.nirholas/3D-AI-Agent-Avatar) as a
// child process and speaks the real MCP protocol (JSON-RPC over stdio) to it.
// Nothing here is mocked — every tool call hits the live server.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
export const SERVER_ENTRY = resolve(REPO_ROOT, 'packages/avatar-agent-mcp/src/index.js');

// Mainnet by default — the demo moves real SOL. Override with SOLANA_RPC_URL.
export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export async function connectAvatarAgent({ stderr = 'ignore', env = {} } = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_ENTRY],
		cwd: REPO_ROOT,
		env: { ...process.env, SOLANA_RPC_URL: RPC_URL, ...env },
		stderr,
	});
	const client = new Client(
		{ name: 'three-ws-demo-agent', version: '1.0.0' },
		{ capabilities: {} },
	);
	await client.connect(transport);
	return { client, transport };
}

// Call a tool and parse the JSON text payload the avatar-agent tools return.
export async function callTool(client, name, args = {}) {
	const res = await client.callTool({ name, arguments: args });
	const text = (res.content || [])
		.map((c) => (c.type === 'text' ? c.text : ''))
		.filter(Boolean)
		.join('\n');
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text };
	}
	return { data, text, isError: Boolean(res.isError) };
}
