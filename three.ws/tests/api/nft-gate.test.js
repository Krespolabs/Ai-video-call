// Unit tests for the NFT-gate verification lib (api/_lib/nft-gate.js).
//
// The module's job is to answer "does this wallet/user hold ≥1 NFT from a
// collection?" via the Helius DAS searchAssets RPC, FAIL-CLOSED: a transport or
// JSON-RPC error must throw (never return a false "held"), so the access layer
// denies on error. These tests stub the DAS HTTP call via the `fetchImpl`
// override and the DB via a vi.mock so no network or database is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Counting SQL stub for getUserSolanaWallets ───────────────────────────────
let walletRows = [];
const sql = vi.fn(async () => walletRows);
vi.mock('../../api/_lib/db.js', () => ({ sql, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const {
	isValidSolanaAddress,
	dasRpcUrl,
	nftGateEnabled,
	walletHoldsCollectionNft,
	anyWalletHoldsCollection,
	viewerNftGatedSkills,
} = await import('../../api/_lib/nft-gate.js');

const WALLET = '5wXp1t4Y3kP7sQ9rN2mJ8vK6dF4hG1aB3cE5tU7wZ9x';
const WALLET2 = '7mNq2vR4tX8pL3kJ6yH9dG5sF1aB4cE7uW2zY8nM5qP';
const COLLECTION = 'THREEsynthetic1111111111111111111111111111';
const RPC = 'https://mainnet.helius-rpc.com/?api-key=test';

// Build a fetchImpl that returns a canned DAS result (or error envelope/HTTP).
function dasFetch({ items = [], error = null, status = 200 } = {}) {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => (error ? { error } : { result: { items, total: items.length } }),
	}));
}

beforeEach(() => {
	sql.mockClear();
	walletRows = [];
});

describe('isValidSolanaAddress', () => {
	it('accepts a base58 address of valid length', () => {
		expect(isValidSolanaAddress(WALLET)).toBe(true);
		expect(isValidSolanaAddress(COLLECTION)).toBe(true);
	});
	it('rejects junk, EVM hex, and non-strings', () => {
		expect(isValidSolanaAddress('0xabc')).toBe(false);
		expect(isValidSolanaAddress('not an address!')).toBe(false);
		expect(isValidSolanaAddress('')).toBe(false);
		expect(isValidSolanaAddress(null)).toBe(false);
		expect(isValidSolanaAddress(123)).toBe(false);
	});
});

describe('dasRpcUrl / nftGateEnabled', () => {
	const ORIG = { ...process.env };
	beforeEach(() => {
		delete process.env.HELIUS_API_KEY;
		delete process.env.SOLANA_RPC_URL;
	});
	afterEach(() => {
		process.env = { ...ORIG };
	});
	it('prefers HELIUS_API_KEY', () => {
		process.env.HELIUS_API_KEY = 'abc';
		expect(dasRpcUrl()).toContain('mainnet.helius-rpc.com');
		expect(nftGateEnabled()).toBe(true);
	});
	it('falls back to a Helius SOLANA_RPC_URL only', () => {
		process.env.SOLANA_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=xyz';
		expect(dasRpcUrl()).toContain('helius-rpc.com');
	});
	it('ignores a non-Helius SOLANA_RPC_URL', () => {
		process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
		expect(dasRpcUrl()).toBeNull();
		expect(nftGateEnabled()).toBe(false);
	});
});

describe('walletHoldsCollectionNft', () => {
	it('returns true when the owner holds an asset in the collection', async () => {
		const fetchImpl = dasFetch({ items: [{ id: 'asset1' }] });
		const held = await walletHoldsCollectionNft(WALLET, COLLECTION, { fetchImpl, rpcUrl: RPC });
		expect(held).toBe(true);
		// One indexed read, with the owner + collection grouping filter.
		const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(body.method).toBe('searchAssets');
		expect(body.params.ownerAddress).toBe(WALLET);
		expect(body.params.grouping).toEqual(['collection', COLLECTION]);
		expect(body.params.burnt).toBe(false);
	});

	it('returns false when the owner holds nothing in the collection', async () => {
		const fetchImpl = dasFetch({ items: [] });
		expect(await walletHoldsCollectionNft(WALLET, COLLECTION, { fetchImpl, rpcUrl: RPC })).toBe(false);
	});

	it('returns false for an invalid wallet or collection without calling DAS', async () => {
		const fetchImpl = dasFetch({ items: [{ id: 'x' }] });
		expect(await walletHoldsCollectionNft('0xbad', COLLECTION, { fetchImpl, rpcUrl: RPC })).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('throws (fail-closed) on a DAS error envelope', async () => {
		const fetchImpl = dasFetch({ error: { code: -32000, message: 'boom' } });
		await expect(walletHoldsCollectionNft(WALLET, COLLECTION, { fetchImpl, rpcUrl: RPC })).rejects.toThrow();
	});

	it('throws (fail-closed) on a non-200 HTTP status', async () => {
		const fetchImpl = dasFetch({ status: 500 });
		await expect(walletHoldsCollectionNft(WALLET, COLLECTION, { fetchImpl, rpcUrl: RPC })).rejects.toThrow();
	});
});

describe('anyWalletHoldsCollection', () => {
	it('is true when any wallet holds the collection', async () => {
		// First wallet empty, second holds it.
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: { items: [] } }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: { items: [{ id: 'a' }] } }) });
		expect(await anyWalletHoldsCollection([WALLET, WALLET2], COLLECTION, { fetchImpl, rpcUrl: RPC })).toBe(true);
	});

	it('is false when no wallet holds it but checks completed', async () => {
		const fetchImpl = dasFetch({ items: [] });
		expect(await anyWalletHoldsCollection([WALLET, WALLET2], COLLECTION, { fetchImpl, rpcUrl: RPC })).toBe(false);
	});

	it('returns false with no valid wallets', async () => {
		const fetchImpl = dasFetch({ items: [{ id: 'x' }] });
		expect(await anyWalletHoldsCollection(['0xbad'], COLLECTION, { fetchImpl, rpcUrl: RPC })).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('throws (fail-closed) when every check errors', async () => {
		const fetchImpl = dasFetch({ status: 500 });
		await expect(anyWalletHoldsCollection([WALLET, WALLET2], COLLECTION, { fetchImpl, rpcUrl: RPC })).rejects.toThrow();
	});
});

describe('viewerNftGatedSkills', () => {
	// The display helper guards on nftGateEnabled() (a configured DAS endpoint);
	// set the env so the guard passes, then inject the stub RPC per call.
	const ORIG = process.env.HELIUS_API_KEY;
	beforeEach(() => {
		process.env.HELIUS_API_KEY = 'test';
	});
	afterEach(() => {
		if (ORIG === undefined) delete process.env.HELIUS_API_KEY;
		else process.env.HELIUS_API_KEY = ORIG;
	});

	it('returns the gated skills whose collection the viewer holds (deduped per collection)', async () => {
		walletRows = [{ address: WALLET }];
		const priceRows = [
			{ skill: 'alpha', gate_type: 'nft', nft_collection_mint: COLLECTION },
			{ skill: 'beta', gate_type: 'nft', nft_collection_mint: COLLECTION },
			{ skill: 'gamma', gate_type: 'price', nft_collection_mint: null },
		];
		const fetchImpl = dasFetch({ items: [{ id: 'a' }] });
		const skills = await viewerNftGatedSkills(priceRows, 'user-1', { fetchImpl, rpcUrl: RPC });
		expect(skills.sort()).toEqual(['alpha', 'beta']);
		// Two skills share one collection → one DAS call (deduped).
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('fails soft (returns []) when the on-chain check errors', async () => {
		walletRows = [{ address: WALLET }];
		const priceRows = [{ skill: 'alpha', gate_type: 'nft', nft_collection_mint: COLLECTION }];
		const fetchImpl = dasFetch({ status: 500 });
		expect(await viewerNftGatedSkills(priceRows, 'user-1', { fetchImpl, rpcUrl: RPC })).toEqual([]);
	});

	it('returns [] for a user with no linked Solana wallet', async () => {
		walletRows = [];
		const priceRows = [{ skill: 'alpha', gate_type: 'nft', nft_collection_mint: COLLECTION }];
		expect(await viewerNftGatedSkills(priceRows, 'user-1', { rpcUrl: RPC })).toEqual([]);
	});

	it('returns [] when there are no NFT-gated skills', async () => {
		const priceRows = [{ skill: 'gamma', gate_type: 'price', nft_collection_mint: null }];
		expect(await viewerNftGatedSkills(priceRows, 'user-1', { rpcUrl: RPC })).toEqual([]);
	});
});
