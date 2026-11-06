// Real-funds agreement gate: pure logic + storage and network behavior of
// public/risk-ack.js. The DOM dialog itself is exercised in the browser; these
// tests pin down what decides whether a person gets prompted and what a
// signature sends: record parsing, version currency, signature validation, the
// server-status cross-check, the degraded signing path, and fetchWithRiskAck.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function load() {
	vi.resetModules();
	return import('../public/risk-ack.js');
}

function fakeStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		_map: map,
	};
}

function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const saved = {};
beforeEach(() => {
	for (const k of ['localStorage', 'fetch', 'confirm', 'prompt', 'alert', 'document']) saved[k] = globalThis[k];
	delete globalThis.document;
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete globalThis[k];
		else globalThis[k] = v;
	}
});

describe('pure helpers', () => {
	it('parseAckRecord parses a valid record and rejects garbage', async () => {
		const { parseAckRecord } = await load();
		expect(parseAckRecord(JSON.stringify({ version: 2, acceptedAt: '2026-09-17T12:00:00.000Z', context: 'trade' }))).toEqual({
			version: 2,
			acceptedAt: '2026-09-17T12:00:00.000Z',
			context: 'trade',
		});
		for (const raw of [null, '', 'not json', '42', JSON.stringify({ version: 0, acceptedAt: '2026-01-01' }), JSON.stringify({ version: 1.5, acceptedAt: '2026-01-01' }), JSON.stringify({ version: 2 })]) {
			expect(parseAckRecord(raw)).toBeNull();
		}
	});

	it('isAckCurrent: a version-1 acknowledgment no longer counts after the bump to the signature bundle', async () => {
		const { isAckCurrent, RISK_ACK_VERSION } = await load();
		expect(RISK_ACK_VERSION).toBeGreaterThanOrEqual(2);
		expect(isAckCurrent({ version: 1 })).toBe(false);
		expect(isAckCurrent({ version: RISK_ACK_VERSION })).toBe(true);
		expect(isAckCurrent(null)).toBe(false);
	});

	it('normalizeSignatureName accepts real names and refuses non-signatures', async () => {
		const { normalizeSignatureName, SIGNATURE_NAME_MAX } = await load();
		expect(normalizeSignatureName('  Ada   Lovelace ')).toBe('Ada Lovelace');
		expect(normalizeSignatureName('李小龙')).toBe('李小龙');
		expect(normalizeSignatureName('Zoë O’Brien')).toBe('Zoë O’Brien');
		expect(normalizeSignatureName('A')).toBeNull();
		expect(normalizeSignatureName('12345')).toBeNull();
		expect(normalizeSignatureName('   ')).toBeNull();
		expect(normalizeSignatureName('x'.repeat(SIGNATURE_NAME_MAX + 1))).toBeNull();
		expect(normalizeSignatureName(42)).toBeNull();
	});

	it('buildSignaturePayload covers every document and attestation at the current versions', async () => {
		const { buildSignaturePayload, AGREEMENT_DOCUMENTS, AGREEMENT_ATTESTATIONS, RISK_ACK_VERSION } = await load();
		const p = buildSignaturePayload({ name: 'Ada Lovelace', context: 'deposit', path: '/agents/x' });
		expect(p.version).toBe(RISK_ACK_VERSION);
		expect(Object.keys(p.documents).sort()).toEqual(AGREEMENT_DOCUMENTS.map((d) => d.key).sort());
		for (const d of AGREEMENT_DOCUMENTS) expect(p.documents[d.key]).toBe(d.version);
		for (const a of AGREEMENT_ATTESTATIONS) expect(p.attestations[a.key]).toBe(true);
		expect(p).toMatchObject({ signatureName: 'Ada Lovelace', context: 'deposit', path: '/agents/x' });
	});

	it('the documents are exactly the Terms, the Risk Disclosure, and the Agent Wallet Agreement', async () => {
		const { AGREEMENT_DOCUMENTS } = await load();
		expect(AGREEMENT_DOCUMENTS.map((d) => d.path)).toEqual(['/legal/tos', '/legal/risk', '/legal/agent-wallet']);
	});

	it('isRiskAckRequiredError recognizes only the server refusal', async () => {
		const { isRiskAckRequiredError } = await load();
		expect(isRiskAckRequiredError({ error: 'risk_ack_required' })).toBe(true);
		expect(isRiskAckRequiredError({ error: 'forbidden' })).toBe(false);
		expect(isRiskAckRequiredError(null)).toBe(false);
	});
});

describe('hasRiskAck / ensureRiskAck', () => {
	it('a current local signature with no session passes without prompting', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage({
			[m.RISK_ACK_STORAGE_KEY]: JSON.stringify({ version: m.RISK_ACK_VERSION, acceptedAt: '2026-09-17T00:00:00.000Z' }),
		});
		globalThis.fetch = vi.fn(async () => jsonResponse(200, { authenticated: false, signed: false, version: m.RISK_ACK_VERSION }));
		await expect(m.ensureRiskAck({ context: 'trade' })).resolves.toBe(true);
	});

	it('a local signature does not stand in for a signed-in account the server says is unsigned', async () => {
		const m = await load();
		const storage = fakeStorage({
			[m.RISK_ACK_STORAGE_KEY]: JSON.stringify({ version: m.RISK_ACK_VERSION, acceptedAt: '2026-09-17T00:00:00.000Z' }),
		});
		globalThis.localStorage = storage;
		globalThis.fetch = vi.fn(async () => jsonResponse(200, { authenticated: true, signed: false, version: m.RISK_ACK_VERSION }));
		// No DOM in Node: the gate must fail CLOSED and drop the stale local record.
		await expect(m.ensureRiskAck({ context: 'trade' })).resolves.toBe(false);
		expect(storage.getItem(m.RISK_ACK_STORAGE_KEY)).toBeNull();
	});

	it('an unreachable status endpoint falls back to the local record (the server still enforces)', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage({
			[m.RISK_ACK_STORAGE_KEY]: JSON.stringify({ version: m.RISK_ACK_VERSION, acceptedAt: '2026-09-17T00:00:00.000Z' }),
		});
		globalThis.fetch = vi.fn(async () => {
			throw new Error('offline');
		});
		await expect(m.hasRiskAckVerified()).resolves.toBe(true);
	});

	it('no signature and no DOM resolves false', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage();
		await expect(m.ensureRiskAck({ context: 'trade' })).resolves.toBe(false);
		await expect(m.hasRiskAckVerified()).resolves.toBe(false);
	});

	it('hasRiskAck survives a throwing localStorage', async () => {
		const m = await load();
		globalThis.localStorage = {
			getItem() {
				throw new Error('denied');
			},
		};
		expect(m.hasRiskAck()).toBe(false);
	});
});

describe('fallbackConfirmAck: signing when the dialog cannot render', () => {
	it('records a full signature and persists it only after the server stored it', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage();
		globalThis.confirm = () => true;
		globalThis.prompt = () => '  Ada Lovelace ';
		const calls = [];
		globalThis.fetch = vi.fn(async (url, init) => {
			calls.push({ url: String(url), init });
			return jsonResponse(200, { ok: true, recorded: true, version: m.RISK_ACK_VERSION });
		});
		await expect(m.fallbackConfirmAck({ context: 'swap' })).resolves.toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].init.method).toBe('POST');
		const body = JSON.parse(calls[0].init.body);
		expect(body).toMatchObject({ version: m.RISK_ACK_VERSION, signatureName: 'Ada Lovelace', context: 'swap' });
		const rec = m.parseAckRecord(globalThis.localStorage.getItem(m.RISK_ACK_STORAGE_KEY));
		expect(m.isAckCurrent(rec)).toBe(true);
	});

	it('an unrecorded signature is not treated as signed', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage();
		globalThis.confirm = () => true;
		globalThis.prompt = () => 'Ada Lovelace';
		globalThis.alert = vi.fn();
		globalThis.fetch = vi.fn(async () => jsonResponse(503, { error: 'signature_not_recorded', error_description: 'db down' }));
		await expect(m.fallbackConfirmAck({ context: 'trade' })).resolves.toBe(false);
		expect(globalThis.localStorage.getItem(m.RISK_ACK_STORAGE_KEY)).toBeNull();
		expect(globalThis.alert).toHaveBeenCalled();
	});

	it('cancelling, an empty name, or a missing confirm() all fail closed and send nothing', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage();
		globalThis.fetch = vi.fn();
		globalThis.confirm = () => false;
		await expect(m.fallbackConfirmAck()).resolves.toBe(false);
		globalThis.confirm = () => true;
		globalThis.prompt = () => '';
		await expect(m.fallbackConfirmAck()).resolves.toBe(false);
		delete globalThis.confirm;
		await expect(m.fallbackConfirmAck()).resolves.toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('a throwing confirm() cannot break the caller', async () => {
		const m = await load();
		globalThis.confirm = () => {
			throw new Error('blocked');
		};
		await expect(m.fallbackConfirmAck()).resolves.toBe(false);
	});
});

describe('fetchWithRiskAck', () => {
	it('passes through anything that is not a risk_ack_required refusal', async () => {
		const m = await load();
		globalThis.fetch = vi.fn(async () => jsonResponse(403, { error: 'forbidden' }));
		const res = await m.fetchWithRiskAck('/api/x', { method: 'POST' });
		expect(res.status).toBe(403);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('returns the refusal untouched when the person does not sign', async () => {
		const m = await load();
		globalThis.localStorage = fakeStorage();
		globalThis.fetch = vi.fn(async () => jsonResponse(403, { error: 'risk_ack_required' }));
		const res = await m.fetchWithRiskAck('/api/x', { method: 'POST' });
		expect(res.status).toBe(403);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});
