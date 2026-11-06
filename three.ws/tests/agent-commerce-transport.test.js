/**
 * Agent-to-agent commerce — the transport-layer fixes that make the hire loop
 * actually complete against the live stack. These two behaviours are load-bearing
 * and were both silently broken before:
 *
 *   1. Discovery MUST NOT dead-end on phrasing. The directory's full-text `q` is a
 *      strict pre-filter, so a natural-language task ("help me run a token launch")
 *      routinely matches nothing even when relevant agents exist. fetchCandidates
 *      broadens — retries without `q` — so discovery degrades to "the best agents
 *      we have" instead of an empty shortlist. A `skill` filter is an explicit
 *      constraint and is never widened away.
 *
 *   2. Delegation MUST authenticate. /api/agents/talk requires a principal (it
 *      burns platform LLM credit); the hire tool already collected the x402
 *      payment, so it presents a platform bearer credential. Without a token the
 *      request is anonymous and 401s (which cancels the payment — the caller is
 *      never charged for a hire that could not run).
 *
 * Both are exercised with a mocked global.fetch — no network, no wallet, no model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fetchCandidates } from '../mcp-server/src/lib/agent-registry.js';
import { runDelegation } from '../mcp-server/src/lib/delegate-transport.js';

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const AGENT = { id: 'a1', name: 'Demo Agent', skills: [], chat_count: 3 };

describe('fetchCandidates — discovery never dead-ends on phrasing', () => {
	let origFetch;
	beforeEach(() => {
		origFetch = global.fetch;
	});
	afterEach(() => {
		global.fetch = origFetch;
		delete process.env.THREEWS_BASE_URL;
	});

	it('broadens (drops q) and returns the ranked pool when a q-filtered query is empty', async () => {
		const urls = [];
		global.fetch = vi.fn(async (url) => {
			urls.push(String(url));
			// First call carries the strict full-text q and matches nothing;
			// the broadened retry (no q) returns the real directory.
			const hasQ = new URL(String(url)).searchParams.has('q');
			return json({ agents: hasQ ? [] : [AGENT] });
		});

		const rows = await fetchCandidates({ q: 'help me run a pump.fun token launch', limit: 5 });

		expect(rows).toEqual([AGENT]);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(new URL(urls[0]).searchParams.get('q')).toContain('pump.fun');
		expect(new URL(urls[1]).searchParams.has('q')).toBe(false);
	});

	it('does not make a second call when the q-filtered query already returns rows', async () => {
		global.fetch = vi.fn(async () => json({ agents: [AGENT] }));
		const rows = await fetchCandidates({ q: 'anything', limit: 5 });
		expect(rows).toEqual([AGENT]);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('never widens past an explicit skill filter (an empty skill result stays empty)', async () => {
		const urls = [];
		global.fetch = vi.fn(async (url) => {
			urls.push(String(url));
			return json({ agents: [] });
		});
		const rows = await fetchCandidates({ q: 'task', skill: 'translation', limit: 5 });
		expect(rows).toEqual([]);
		// One broadening retry is allowed, but the skill filter must survive it.
		for (const u of urls) expect(new URL(u).searchParams.get('skill')).toBe('translation');
	});
});

describe('runDelegation — authenticates to the credit-burning talk endpoint', () => {
	let origFetch;
	const TOKEN_KEYS = ['MCP_AGENT_TALK_TOKEN', 'THREE_WS_MCP_TOKEN', 'MCP_SERVICE_TOKEN'];
	beforeEach(() => {
		origFetch = global.fetch;
		for (const k of TOKEN_KEYS) delete process.env[k];
	});
	afterEach(() => {
		global.fetch = origFetch;
		for (const k of TOKEN_KEYS) delete process.env[k];
	});

	it('sends Authorization: Bearer <token> when a service token is configured', async () => {
		process.env.MCP_AGENT_TALK_TOKEN = 'sk_test_service_credential';
		let seenAuth = null;
		global.fetch = vi.fn(async (_url, init) => {
			seenAuth = init.headers.authorization || init.headers.Authorization || null;
			return json({ ok: true, response: 'hi', model: 'claude-haiku-4-5-20251001' });
		});

		const out = await runDelegation({ agentId: 'a1', message: 'hello' });

		expect(out.ok).toBe(true);
		expect(seenAuth).toBe('Bearer sk_test_service_credential');
	});

	it('sends no Authorization header when no token is configured (clean anonymous 401 path)', async () => {
		let hadAuth = true;
		global.fetch = vi.fn(async (_url, init) => {
			hadAuth = 'authorization' in init.headers || 'Authorization' in init.headers;
			return json({ ok: false, code: 'unauthorized', message: 'sign in required' }, 401);
		});

		const out = await runDelegation({ agentId: 'a1', message: 'hello' });

		expect(hadAuth).toBe(false);
		expect(out.ok).toBe(false);
		expect(out.error).toBe('unauthorized');
		expect(out.status).toBe(401);
	});
});
