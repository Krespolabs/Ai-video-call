// "Where every $100 goes" on /three-token: the breakdown renders every live
// split policy with numbers taken only from the config, a policy added to
// SPLIT_POLICIES appears with no page change, no split figure is typed into
// the page code, and the wallet snapshot never turns a failed read into a zero.

import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: async () => null,
	cacheSet: async () => {},
}));

const rpcState = { fail: false, balances: {} };
vi.mock('../api/_lib/solana/rpc-fallback.js', () => ({
	rpcFallbackFromEnv: () => ({
		withFallback: async (fn) => {
			if (rpcState.fail) throw new Error('all rpc lanes exhausted');
			return fn({
				getParsedTokenAccountsByOwner: async (owner, { mint }) => {
					const entry = rpcState.balances[`${owner.toBase58()}:${mint.toBase58()}`];
					return {
						value: entry
							? [{ account: { data: { parsed: { info: { tokenAmount: entry } } } } }]
							: [],
					};
				},
			});
		},
	}),
}));

const { publicConfig, SPLIT_POLICIES, TOKEN_MINT } = await import('../api/_lib/token/config.js');
const { SOLANA_USDC_MINT } = await import('../api/payments/_config.js');
const { publicWalletBalances } = await import('../api/_lib/token/wallet-balances.js');
const {
	renderPolicies,
	renderWallets,
	renderBuybackSummary,
	orderedPolicies,
	policyLabel,
	dollarsOfHundred,
} = await import('../src/three-token-fee-flow.js');

// A synthetic, keyless owner address (32 bytes of 7s), not anyone's wallet.
const SYNTHETIC_WALLET = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

const policyKeys = (html) => [...html.matchAll(/data-policy="([^"]+)"/g)].map((m) => m[1]);

describe('fee flow breakdown', () => {
	it('renders every policy the public config publishes, with amounts derived from bps', () => {
		const cfg = publicConfig();
		const html = renderPolicies(cfg);
		expect(policyKeys(html).sort()).toEqual(Object.keys(SPLIT_POLICIES).sort());
		for (const [key, legs] of Object.entries(cfg.split_policies)) {
			const row = html.slice(html.indexOf(`data-policy="${key}"`));
			for (const leg of legs) {
				const dollars = `$${dollarsOfHundred(leg.bps).toFixed(2)}`;
				expect(row).toContain(dollars);
			}
		}
	});

	it('shows a newly added policy with no page change, labelled from its key', () => {
		const cfg = publicConfig();
		const extended = {
			...cfg,
			split_policies: {
				...cfg.split_policies,
				holder_quest_reward: [
					{ role: 'treasury', bps: 6250 },
					{ role: 'rewards', bps: 3750 },
				],
			},
		};
		const html = renderPolicies(extended);
		expect(policyKeys(html)).toContain('holder_quest_reward');
		expect(policyLabel('holder_quest_reward')).toBe('Holder quest reward');
		expect(html).toContain('Of every $100 paid for holder quest reward');
		expect(html).toContain('$62.50');
		expect(html).toContain('$37.50');
		// Known policies keep their curated order ahead of the new one.
		expect(orderedPolicies(extended).at(-1).key).toBe('holder_quest_reward');
	});

	it('gives screen readers the numbers as text, not only the bar shapes', () => {
		const html = renderPolicies(publicConfig());
		const labels = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((m) => m[1]);
		expect(labels).toHaveLength(Object.keys(SPLIT_POLICIES).length);
		for (const l of labels) expect(l).toMatch(/^Of every \$100: \$\d/);
	});

	it('never states a platform burn', () => {
		const html = renderPolicies(publicConfig());
		expect(html.toLowerCase()).not.toContain('burn');
	});

	it('types no split figure from SPLIT_POLICIES into the page code', () => {
		const bps = new Set(Object.values(SPLIT_POLICIES).flat().map((l) => l.bps));
		const feeFlow = readFileSync('src/three-token-fee-flow.js', 'utf8');
		const page = readFileSync('src/three-token-page.js', 'utf8');
		for (const b of bps) {
			const pct = b / 100;
			// The module that renders the splits carries no bps figure at all.
			expect(feeFlow).not.toMatch(new RegExp(`(?<![\\w.])${b}(?![\\w.])`));
			// Neither file states a split as a typed percentage or dollar figure.
			for (const src of [feeFlow, page]) {
				expect(src).not.toMatch(new RegExp(`(?<![\\w.$:(])${pct}%`)); // CSS lengths such as radius:50% are not splits
				expect(src).not.toMatch(new RegExp(`\\$${pct}\\.00`));
			}
		}
	});
});

describe('fee flow wallets', () => {
	const saved = {};
	beforeEach(() => {
		for (const k of ['THREE_TREASURY_WALLET', 'THREE_REWARDS_WALLET']) saved[k] = process.env[k];
		rpcState.fail = false;
		rpcState.balances = {};
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it('lists unset wallets as not yet published instead of hiding them', async () => {
		delete process.env.THREE_TREASURY_WALLET;
		delete process.env.THREE_REWARDS_WALLET;
		const snap = await publicWalletBalances();
		expect(snap.wallets.map((w) => [w.role, w.configured, w.balances])).toEqual([
			['treasury', false, null],
			['rewards', false, null],
		]);
		const html = renderWallets(snap);
		expect(html.match(/Not yet published/g)).toHaveLength(2);
	});

	it('reads real balances for a configured wallet and a real zero for an empty one', async () => {
		const treasury = SYNTHETIC_WALLET;
		process.env.THREE_TREASURY_WALLET = treasury;
		delete process.env.THREE_REWARDS_WALLET;
		rpcState.balances[`${treasury}:${TOKEN_MINT}`] = { amount: '1234500000', decimals: 6 };
		const snap = await publicWalletBalances();
		const t = snap.wallets.find((w) => w.role === 'treasury');
		expect(t.configured).toBe(true);
		expect(t.balances.three).toMatchObject({ ok: true, amount: 1234.5, atomics: '1234500000' });
		expect(t.balances.usdc).toMatchObject({ ok: true, amount: 0 });
		expect(SOLANA_USDC_MINT).toBeTruthy();
		const html = renderWallets(snap);
		expect(html).toContain(`https://solscan.io/account/${treasury}`);
		expect(html).toContain(`data-ff-copy="${treasury}"`);
	});

	it('reports an RPC failure as unavailable, never as a zero balance', async () => {
		process.env.THREE_TREASURY_WALLET = SYNTHETIC_WALLET;
		rpcState.fail = true;
		const snap = await publicWalletBalances();
		const t = snap.wallets.find((w) => w.role === 'treasury');
		expect(t.balances.three).toMatchObject({ ok: false, amount: null });
		expect(renderWallets(snap)).toContain('Balance unavailable');
	});

	it('summarizes the buyback history the page already loads', () => {
		expect(renderBuybackSummary(null)).toBe('');
		expect(renderBuybackSummary({ runs: 0 })).toContain('No treasury buyback has run yet');
		expect(renderBuybackSummary({ runs: 3, three_bought: 2500000 })).toContain('3 buybacks so far, 2.50M $THREE');
	});
});
