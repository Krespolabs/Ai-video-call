/**
 * Tests for the legacy agent-skill x402 helper (emit402 / manifestOnly).
 *
 * Both resolve the recipient through resolveSkillRecipient, which reads the
 * owner's payout wallet (agent_payout_wallets) and the agent's own wallet
 * before falling back to meta.payments.receiver. The DB is mocked with a tiny
 * table of those two lookups so each test states which wallets exist.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const walletState = { payout: null, agentWallet: null };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const q = strings.join('?');
		if (q.includes('agent_payout_wallets')) {
			return walletState.payout ? [{ address: walletState.payout }] : [];
		}
		if (q.includes('from agent_identities')) {
			return walletState.agentWallet ? [{ wallet_address: walletState.agentWallet }] : [];
		}
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { emit402, manifestOnly, manifestUrl, X402_VERSION } = await import('../../api/_lib/x402.js');

beforeEach(() => {
	walletState.payout = null;
	walletState.agentWallet = null;
});

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value;
		},
		end(body) {
			this.body = body;
		},
	};
}

// Both fixture strings must be valid base58 (32-44 chars, no 0/O/I/l) so
// resolveSolanaRecipient() short-circuits on the "raw address" branch and
// never makes a SNS RPC call. Earlier fixtures used 'OwnerWallet111…' which
// fails the base58 charset (contains 'l'), fell through to the SNS path, and
// hit the real Solana RPC — the test then 429-looped under load.
function makeAgent(overrides = {}) {
	return {
		id: 'agent-uuid',
		name: 'Test Agent',
		meta: {
			payments: {
				configured: true,
				provider: 'pumpfun',
				mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				receiver: 'THREEsynthetic1111111111111111111111111PayTo',
				cluster: 'mainnet',
			},
			...overrides,
		},
	};
}

describe('emit402', () => {
	it('returns 402 with a canonical manifest', async () => {
		const res = makeRes();
		await emit402(res, {
			agent: makeAgent(),
			skill: 'summarize',
			amount: '10000',
			currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		});
		expect(res.statusCode).toBe(402);
		expect(res.headers['content-type']).toBe('application/json');
		expect(res.headers['cache-control']).toBe('no-store');
		expect(res.headers['link']).toMatch(/payment-manifest/);

		const body = JSON.parse(res.body);
		expect(body.version).toBe(X402_VERSION);
		expect(body.kind).toBe('agent-skill');
		expect(body.agent_id).toBe('agent-uuid');
		expect(body.skill).toBe('summarize');
		expect(body.amount).toBe('10000');
		expect(body.currency).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
		expect(body.recipient).toBe('THREEsynthetic1111111111111111111111111PayTo');
		expect(body.intent_url).toBe('/api/agents/payments/pay-prep');
		expect(body.verify_url).toBe('/api/agents/payments/pay-confirm');
		expect(body.retry_with_header).toBe('x-payment-intent');
		expect(typeof body.valid_until).toBe('number');
		expect(body.valid_until).toBeGreaterThan(Date.now() / 1000);
	});

	it('refuses to 402 when payments are not configured', async () => {
		const res = makeRes();
		const agent = { id: 'x', name: 'x', meta: { payments: { configured: false } } };
		// emit402 should fall through to error() — we just assert it didn't 402.
		await emit402(res, { agent, skill: 's', amount: '1', currency: 'X' });
		expect(res.statusCode).not.toBe(402);
	});

	it('surfaces meta.sns_domain as recipient_name when set', async () => {
		const res = makeRes();
		await emit402(res, {
			agent: makeAgent({
				sns_domain: 'vernington.threews.sol',
				payments: {
					configured: true,
					provider: 'pumpfun',
					mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
					receiver: 'THREEsynthetic1111111111111111111111111PayTo',
					cluster: 'mainnet',
				},
			}),
			skill: 's',
			amount: '1',
			currency: 'X',
		});
		const body = JSON.parse(res.body);
		expect(body.recipient).toBe('THREEsynthetic1111111111111111111111111PayTo');
		expect(body.recipient_name).toBe('vernington.threews.sol');
	});

	it('appends .sol when meta.sns_domain is stored without the suffix', async () => {
		const res = makeRes();
		await emit402(res, {
			agent: makeAgent({
				sns_domain: 'vernington.threews',
				payments: {
					configured: true,
					provider: 'pumpfun',
					mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
					receiver: 'THREEsynthetic1111111111111111111111111PayTo',
					cluster: 'mainnet',
				},
			}),
			skill: 's',
			amount: '1',
			currency: 'X',
		});
		const body = JSON.parse(res.body);
		expect(body.recipient_name).toBe('vernington.threews.sol');
	});

	it('leaves recipient_name null when no SNS identity is attached', async () => {
		const res = makeRes();
		await emit402(res, {
			agent: makeAgent(),
			skill: 's',
			amount: '1',
			currency: 'X',
		});
		const body = JSON.parse(res.body);
		expect(body.recipient_name).toBeNull();
	});

	it('honors validForSec', async () => {
		const res = makeRes();
		const before = Math.floor(Date.now() / 1000);
		await emit402(res, {
			agent: makeAgent(),
			skill: 's',
			amount: '1',
			currency: 'X',
			validForSec: 60,
		});
		const body = JSON.parse(res.body);
		expect(body.valid_until - before).toBeGreaterThanOrEqual(59);
		expect(body.valid_until - before).toBeLessThanOrEqual(61);
	});
});

describe('manifestOnly', () => {
	it('returns the same manifest shape with status 200', async () => {
		// We mock just enough of the http json() helper to get a captured body.
		const captured = {};
		const res = {
			statusCode: 0,
			headers: {},
			setHeader(k, v) {
				this.headers[k.toLowerCase()] = v;
			},
			end(body) {
				captured.body = body;
				captured.status = this.statusCode;
			},
		};
		await manifestOnly(res, {
			agent: makeAgent(),
			skill: 'echo',
			amount: '5000',
			currency: 'CURRENCY-MINT',
		});
		expect(captured.status).toBe(200);
		const body = JSON.parse(captured.body);
		expect(body.version).toBe(X402_VERSION);
		expect(body.skill).toBe('echo');
		expect(body.amount).toBe('5000');
	});
});

function captureRes() {
	return {
		statusCode: 0,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(body) {
			this.body = body;
		},
	};
}

// Legacy defect: emit402 advertised /api/agents/:id/x402/:skill/manifest in its
// Link header, a path no route serves, so a client that prefetched the
// manifest got a 404. The link must be a URL the live route table resolves.
describe('emit402 manifest link', () => {
	it('points at the manifest route vercel.json actually serves', async () => {
		const res = captureRes();
		await emit402(res, { agent: makeAgent(), skill: 'summarize', amount: '1', currency: 'X' });
		const link = res.headers['link'];
		const target = link.match(/<([^>]+)>; rel="payment-manifest"/)[1];
		const pathOnly = target.split('?')[0];
		const routes = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).routes;
		const served = routes.some((r) => r.src && new RegExp(`^${r.src}$`).test(pathOnly) && String(r.dest).includes('action=manifest'));
		expect(served).toBe(true);
		expect(target).toBe(manifestUrl('agent-uuid', 'summarize'));
		expect(new URL(target, 'https://three.ws').searchParams.get('agent_id')).toBe('agent-uuid');
		expect(new URL(target, 'https://three.ws').searchParams.get('skill')).toBe('summarize');
	});
});

// Legacy defect: the 402 named meta.payments.receiver while the manifest named
// the owner's payout wallet, so one skill advertised two different recipients.
describe('emit402 and manifestOnly agree on the recipient', () => {
	async function bothRecipients() {
		const r402 = captureRes();
		await emit402(r402, { agent: makeAgent(), skill: 's', amount: '1', currency: 'X' });
		const rManifest = captureRes();
		await manifestOnly(rManifest, { agent: makeAgent(), skill: 's', amount: '1', currency: 'X' });
		return [JSON.parse(r402.body).recipient, JSON.parse(rManifest.body).recipient];
	}

	it('both use the owner payout wallet when one is configured', async () => {
		walletState.payout = 'PayoutWa11et1111111111111111111111111111111';
		const [a, b] = await bothRecipients();
		expect(a).toBe('PayoutWa11et1111111111111111111111111111111');
		expect(b).toBe(a);
	});

	it('both fall back to the agent wallet, then the meta receiver', async () => {
		walletState.agentWallet = 'AgentOwnWa11et11111111111111111111111111111';
		const [a, b] = await bothRecipients();
		expect(a).toBe('AgentOwnWa11et11111111111111111111111111111');
		expect(b).toBe(a);

		walletState.agentWallet = null;
		const [c, d] = await bothRecipients();
		expect(c).toBe('THREEsynthetic1111111111111111111111111PayTo');
		expect(d).toBe(c);
	});
});
