// paidEndpoint() normalizes whatever a route declares as `bazaar` into a v2
// entry whose info validates against its own schema. That self-validation is
// the strict check CDP runs before cataloging, and marketplace validators read
// it off the live 402. Before this, 48 routes shipped a flat pre-v2 block with
// no `info` at all and 12 more shipped an info their own schema rejected.

import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { declareHttpDiscovery, declareMcpDiscovery, normalizeBazaarEntry } from '../../api/_lib/x402/bazaar-helpers.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function expectSelfValid(entry) {
	const validate = ajv.compile(entry.schema);
	const ok = validate(entry.info);
	expect(validate.errors || []).toEqual([]);
	expect(ok).toBe(true);
}

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const MINT_SCHEMA = { type: 'object', properties: { mint: { type: 'string' } }, required: ['mint'] };

describe('normalizeBazaarEntry', () => {
	it('lifts a flat query block into a self-valid v2 entry', () => {
		const entry = normalizeBazaarEntry(
			{
				description: 'token intel',
				useCases: ['signal'],
				input: { type: 'query', example: { mint: MINT }, schema: MINT_SCHEMA },
				output: { type: 'json', example: { symbol: 'THREE' } },
			},
			{ method: 'GET' },
		);
		expect(Object.keys(entry).sort()).toEqual(['discoverable', 'info', 'schema']);
		expect(entry.info.input).toEqual({ type: 'http', method: 'GET', queryParams: { mint: MINT } });
		expect(entry.info.output).toEqual({ type: 'json', example: { symbol: 'THREE' } });
		expectSelfValid(entry);
	});

	it('lifts a flat json block on a POST route into a body entry', () => {
		const entry = normalizeBazaarEntry(
			{ input: { type: 'json', example: { report: 'clubs' }, schema: { type: 'object' } }, output: { type: 'json', example: { ok: true } } },
			{ method: 'POST' },
		);
		expect(entry.info.input).toEqual({ type: 'http', method: 'POST', bodyType: 'json', body: { report: 'clubs' } });
		expectSelfValid(entry);
	});

	it('rebuilds a hybrid entry whose info wraps the legacy input', () => {
		const valid = declareHttpDiscovery({ method: 'POST', input: {}, inputSchema: { type: 'object' } });
		const hybrid = { ...valid, info: { input: { type: 'json', method: 'POST', example: { mode: 'canary' } }, output: { type: 'json', example: { ok: true } } } };
		const entry = normalizeBazaarEntry(hybrid, { method: 'POST' });
		expect(entry.info.input.type).toBe('http');
		expect(entry.info.input.body).toEqual({ mode: 'canary' });
		expect(entry.info.output.example).toEqual({ ok: true });
		expectSelfValid(entry);
	});

	it('repairs a hand-written v2 entry that drifted from its schema', () => {
		const valid = declareHttpDiscovery({ method: 'POST', input: { url: 'https://three.ws/avatars/cesium-man.glb' }, inputSchema: { type: 'object' } });
		const drifted = structuredClone(valid);
		delete drifted.info.input.bodyType;
		const entry = normalizeBazaarEntry(drifted, { method: 'POST' });
		expect(entry.info.input.bodyType).toBe('json');
		expect(entry.info.input.body).toEqual({ url: 'https://three.ws/avatars/cesium-man.glb' });
		expectSelfValid(entry);
	});

	it('returns an already-valid v2 entry untouched', () => {
		const valid = declareHttpDiscovery({ method: 'GET', input: { mint: MINT }, inputSchema: MINT_SCHEMA, output: { example: { ok: true } } });
		expect(normalizeBazaarEntry(valid, { method: 'GET' })).toBe(valid);
	});

	it('never rebuilds an MCP entry as HTTP', () => {
		const mcp = declareMcpDiscovery({ toolName: 'validate_model', inputSchema: { type: 'object' } });
		expect(normalizeBazaarEntry(mcp, { method: 'POST' })).toBe(mcp);
	});

	it('keeps a route that opted out of discovery opted out', () => {
		const entry = normalizeBazaarEntry({ discoverable: false, input: { type: 'query', example: { mint: MINT } } }, { method: 'GET' });
		expect(entry.discoverable).toBe(false);
		expectSelfValid(entry);
	});

	it('gives an empty block a minimal self-valid entry', () => {
		const entry = normalizeBazaarEntry({}, { method: 'GET' });
		expect(entry.info.input).toMatchObject({ type: 'http', method: 'GET' });
		expectSelfValid(entry);
	});
});

describe('declareHttpDiscovery', () => {
	it('describes queryParams in the schema whenever info carries them, even with no param schema', () => {
		expectSelfValid(declareHttpDiscovery({ method: 'GET', input: { mint: MINT } }));
	});
});
