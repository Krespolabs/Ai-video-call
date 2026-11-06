// requireRealFundsAgreement(): the server-side refusal every custodial money
// endpoint calls. These tests pin what it lets through, what it refuses, how it
// fails when the database does, and that the served agreement pages carry the
// versions the signature records.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';

const sqlState = { queue: [], calls: [] };

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		const next = sqlState.queue.shift();
		if (next instanceof Error) throw next;
		return next;
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const {
	requireRealFundsAgreement,
	resetRealFundsAgreementCache,
	fingerprintDocumentHtml,
	validateSignatureBody,
	agreementRequirement,
} = await import('../api/_lib/real-funds-agreement.js');
const { AGREEMENT_DOCUMENTS, RISK_ACK_VERSION, buildSignaturePayload } = await import('../public/risk-ack.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

const req = { headers: {}, url: '/api/agents/abc/solana/withdraw' };

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	resetRealFundsAgreementCache();
});

describe('requireRealFundsAgreement', () => {
	it('lets a signed account through', async () => {
		sqlState.queue = [[{ created_at: new Date(), signature_name: 'Ada', context: 'trade' }]];
		const res = makeRes();
		await expect(requireRealFundsAgreement(req, res, { userId: 'u1', network: 'mainnet', context: 'withdraw' })).resolves.toBe(true);
		expect(res.writableEnded).toBe(false);
		expect(sqlState.calls[0].values).toEqual(['u1', RISK_ACK_VERSION]);
	});

	it('refuses an unsigned account with 403 risk_ack_required and a sign_url', async () => {
		sqlState.queue = [[]];
		const res = makeRes();
		await expect(requireRealFundsAgreement(req, res, { userId: 'u1', context: 'withdraw' })).resolves.toBe(false);
		expect(res.statusCode).toBe(403);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('risk_ack_required');
		expect(body.context).toBe('withdraw');
		expect(body.version).toBe(RISK_ACK_VERSION);
		expect(body.sign_url).toMatch(/\/legal\/agreements$/);
		expect(body.documents.map((d) => d.key)).toEqual(['tos', 'risk', 'agentWallet']);
		expect(body.error_description).toMatch(/Nothing was sent/);
	});

	it('exempts devnet without a lookup', async () => {
		const res = makeRes();
		await expect(requireRealFundsAgreement(req, res, { userId: 'u1', network: 'devnet' })).resolves.toBe(true);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('refuses with 401 when no user resolved', async () => {
		const res = makeRes();
		await expect(requireRealFundsAgreement(req, res, { userId: null })).resolves.toBe(false);
		expect(res.statusCode).toBe(401);
	});

	it('fails CLOSED with 503 when the lookup fails', async () => {
		sqlState.queue = [new Error('relation "legal_signatures" does not exist')];
		const res = makeRes();
		await expect(requireRealFundsAgreement(req, res, { userId: 'u1' })).resolves.toBe(false);
		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body).error).toBe('agreement_check_unavailable');
	});

	it('caches a signed result but never an unsigned one', async () => {
		sqlState.queue = [[]];
		await requireRealFundsAgreement(req, makeRes(), { userId: 'u2' });
		sqlState.queue = [[{ created_at: new Date(), signature_name: 'Ada', context: null }]];
		await expect(requireRealFundsAgreement(req, makeRes(), { userId: 'u2' })).resolves.toBe(true);
		const lookups = sqlState.calls.length;
		await expect(requireRealFundsAgreement(req, makeRes(), { userId: 'u2' })).resolves.toBe(true);
		expect(sqlState.calls.length).toBe(lookups);
	});
});

describe('validateSignatureBody', () => {
	it('accepts exactly what the dialog sends', () => {
		const parsed = validateSignatureBody(buildSignaturePayload({ name: 'Ada Lovelace', context: 'trade', path: '/x' }));
		expect(parsed.ok).toBe(true);
		expect(parsed.value.signatureName).toBe('Ada Lovelace');
	});
});

describe('the served agreements', () => {
	const files = { tos: 'public/legal/tos.html', risk: 'public/legal/risk.html', agentWallet: 'public/legal/agent-wallet.html' };

	it.each(AGREEMENT_DOCUMENTS.map((d) => [d.key, d]))('%s shows the version the signature records', (key, doc) => {
		const html = readFileSync(files[key], 'utf8');
		expect(html).toMatch(new RegExp(`Version ${doc.version}\\b`));
	});

	it('the Agent Wallet Agreement states deposits are uninsured and three.ws is not responsible', () => {
		const html = readFileSync(files.agentWallet, 'utf8');
		expect(html).toMatch(/not insured/i);
		expect(html).toMatch(/not responsible for any loss of funds/i);
		expect(html).toMatch(/Deposit/);
	});

	it('fingerprints ignore whitespace but change with wording', () => {
		const a = fingerprintDocumentHtml('<main>\n  <p>Funds can be lost.</p>\n</main>');
		const b = fingerprintDocumentHtml('<main><p>Funds   can be lost.</p></main>');
		const c = fingerprintDocumentHtml('<main><p>Funds cannot be lost.</p></main>');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it('agreementRequirement links every document on the app origin', () => {
		const r = agreementRequirement();
		expect(r.documents).toHaveLength(AGREEMENT_DOCUMENTS.length);
		for (const d of r.documents) expect(d.url).toMatch(/^https?:\/\/.+\/legal\//);
	});
});
