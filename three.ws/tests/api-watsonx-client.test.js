// Unit tests for the shared IBM watsonx.ai client (api/_lib/watsonx.js).
// fetch (the IAM token exchange + the chat/embeddings endpoints) is mocked, so
// these run with no network and no real IBM key. They pin the wire contract that
// every IBM feature (Oracle, Galaxy, Vision, Twin, Proof, the avatar Granite
// brain) depends on, and guard two things that have bitten us:
//   1. decoding params (max_tokens/temperature) must be TOP-LEVEL on the chat
//      endpoint, never nested under a `parameters` wrapper (that silently drops
//      them — a real bug we fixed).
//   2. the IAM bearer token must be cached + coalesced per API key, or every
//      request hammers IBM IAM.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	watsonxConfig,
	watsonxToken,
	watsonxChatComplete,
	watsonxEmbed,
} from '../api/_lib/watsonx.js';

const realFetch = global.fetch;

// Per-test capture of the requests the client made.
let iamCalls = 0;
let lastChat = null; // { url, body }
let lastEmbed = null; // { url, body }

// IAM response knobs so individual tests can force failure / short expiry.
let iam = { ok: true, status: 200, accessToken: 'iam-tok', expiresIn: 3600 };
// Chat/embed response knobs.
let chatResp = { ok: true, status: 200, content: 'hello from granite', usage: { completion_tokens: 5 } };
let embedResp = { ok: true, status: 200, vectors: [[1, 0, 0], [0, 1, 0]] };

function configFor(apiKey) {
	// Build a real config object, but with a caller-supplied key so each test can
	// use a UNIQUE key and never collide with the module-scoped token cache.
	process.env.WATSONX_API_KEY = apiKey;
	process.env.WATSONX_PROJECT_ID = 'proj-123';
	delete process.env.WATSONX_SPACE_ID;
	return watsonxConfig();
}

beforeEach(() => {
	iamCalls = 0;
	lastChat = null;
	lastEmbed = null;
	iam = { ok: true, status: 200, accessToken: 'iam-tok', expiresIn: 3600 };
	chatResp = { ok: true, status: 200, content: 'hello from granite', usage: { completion_tokens: 5 } };
	embedResp = { ok: true, status: 200, vectors: [[1, 0, 0], [0, 1, 0]] };

	global.fetch = vi.fn(async (url, opts) => {
		const u = String(url);
		if (u.includes('iam.cloud.ibm.com')) {
			iamCalls++;
			// widen the inflight window so concurrent callers can coalesce
			await Promise.resolve();
			return {
				ok: iam.ok,
				status: iam.status,
				json: async () => (iam.ok ? { access_token: iam.accessToken, expires_in: iam.expiresIn } : { errorMessage: 'bad key' }),
			};
		}
		if (u.includes('/ml/v1/text/chat')) {
			lastChat = { url: u, body: JSON.parse(opts.body) };
			return {
				ok: chatResp.ok,
				status: chatResp.status,
				text: async () =>
					chatResp.ok
						? JSON.stringify({ model_id: 'ibm/granite-3-8b-instruct', choices: [{ message: { content: chatResp.content }, finish_reason: 'stop' }], usage: chatResp.usage })
						: JSON.stringify({ errors: [{ message: 'model not supported' }] }),
			};
		}
		if (u.includes('/ml/v1/text/embeddings')) {
			lastEmbed = { url: u, body: JSON.parse(opts.body) };
			return {
				ok: embedResp.ok,
				status: embedResp.status,
				text: async () =>
					embedResp.ok
						? JSON.stringify({ model_id: 'ibm/granite-embedding-278m-multilingual', results: embedResp.vectors.map((embedding) => ({ embedding })) })
						: JSON.stringify({ errors: [{ message: 'embed failed' }] }),
			};
		}
		throw new Error(`unexpected fetch: ${u}`);
	});
});

afterEach(() => {
	global.fetch = realFetch;
});

describe('watsonxChatComplete — wire contract', () => {
	it('sends max_tokens and temperature TOP-LEVEL (never nested under parameters)', async () => {
		const cfg = configFor('key-chat-1');
		await watsonxChatComplete(cfg, {
			messages: [{ role: 'user', content: 'hi' }],
			maxTokens: 64,
			temperature: 0.3,
		});
		// The regression guard: the old bug nested these under `parameters`, which
		// the chat endpoint silently ignores.
		expect(lastChat.body.max_tokens).toBe(64);
		expect(lastChat.body.temperature).toBe(0.3);
		expect(lastChat.body.parameters).toBeUndefined();
	});

	it('targets the chat endpoint with version + project scope and the model id', async () => {
		const cfg = configFor('key-chat-2');
		await watsonxChatComplete(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'ibm/granite-3-2b-instruct' });
		expect(lastChat.url).toMatch(/\/ml\/v1\/text\/chat\?version=/);
		expect(lastChat.body.model_id).toBe('ibm/granite-3-2b-instruct');
		expect(lastChat.body.project_id).toBe('proj-123');
		expect(lastChat.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('omits decoding params entirely when not supplied (no empty parameters object)', async () => {
		const cfg = configFor('key-chat-3');
		await watsonxChatComplete(cfg, { messages: [{ role: 'user', content: 'hi' }] });
		expect('max_tokens' in lastChat.body).toBe(false);
		expect('temperature' in lastChat.body).toBe(false);
		expect('parameters' in lastChat.body).toBe(false);
	});

	it('parses the assistant text + usage from the OpenAI-shaped response', async () => {
		const cfg = configFor('key-chat-4');
		chatResp.content = 'granite says hi';
		const out = await watsonxChatComplete(cfg, { messages: [{ role: 'user', content: 'hi' }] });
		expect(out.text).toBe('granite says hi');
		expect(out.finishReason).toBe('stop');
		expect(out.usage).toEqual({ completion_tokens: 5 });
	});

	it('surfaces the real upstream status + message on failure', async () => {
		const cfg = configFor('key-chat-5');
		chatResp = { ok: false, status: 422 };
		await expect(watsonxChatComplete(cfg, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/422|model not supported/);
	});
});

describe('watsonxEmbed — wire contract', () => {
	it('posts inputs + model + scope to the embeddings endpoint and parses vectors', async () => {
		const cfg = configFor('key-embed-1');
		const out = await watsonxEmbed(cfg, { inputs: ['alpha', 'beta'] });
		expect(lastEmbed.url).toMatch(/\/ml\/v1\/text\/embeddings\?version=/);
		expect(lastEmbed.body.inputs).toEqual(['alpha', 'beta']);
		expect(lastEmbed.body.model_id).toBe('ibm/granite-embedding-278m-multilingual');
		expect(lastEmbed.body.project_id).toBe('proj-123');
		expect(out.vectors).toHaveLength(2);
		expect(out.dimensions).toBe(3);
		expect(out.inputCount).toBe(2);
	});

	it('rejects an empty inputs array before making a network call', async () => {
		const cfg = configFor('key-embed-2');
		await expect(watsonxEmbed(cfg, { inputs: [] })).rejects.toThrow(/non-empty/i);
		expect(lastEmbed).toBeNull();
	});
});

describe('watsonxToken — cache, coalescing, expiry, failure', () => {
	it('caches the token per API key (second call makes no IAM round-trip)', async () => {
		const cfg = configFor('key-token-cache');
		const a = await watsonxToken(cfg);
		const b = await watsonxToken(cfg);
		expect(a).toBe('iam-tok');
		expect(b).toBe('iam-tok');
		expect(iamCalls).toBe(1);
	});

	it('coalesces concurrent callers onto a single IAM exchange', async () => {
		const cfg = configFor('key-token-coalesce');
		const [a, b, c] = await Promise.all([watsonxToken(cfg), watsonxToken(cfg), watsonxToken(cfg)]);
		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(iamCalls).toBe(1);
	});

	it('does not cross-pollinate tokens between different API keys', async () => {
		await watsonxToken(configFor('key-token-A'));
		await watsonxToken(configFor('key-token-B'));
		expect(iamCalls).toBe(2);
	});

	it('refreshes before the skew boundary rather than serving a near-expired token', async () => {
		// expires_in shorter than the 5-minute skew → the cached token is treated as
		// already stale, so each call re-mints rather than risk an in-flight expiry.
		iam.expiresIn = 60;
		const cfg = configFor('key-token-skew');
		await watsonxToken(cfg);
		await watsonxToken(cfg);
		expect(iamCalls).toBe(2);
	});

	it('throws a real error when IAM rejects the API key', async () => {
		iam = { ok: false, status: 403 };
		const cfg = configFor('key-token-fail');
		await expect(watsonxToken(cfg)).rejects.toThrow(/IAM auth failed|403/);
	});
});
