// Avatar Marketplace Dynamic Pricing — autonomous pipeline branch coverage.
//
// Exercises run() from api/_lib/x402/pipelines/cosmetic-pricing-audit.js in
// isolation: the DB, the Solana connection, and the x402 payment client are all
// stubbed so no network / no chain is touched. We assert:
//   • wallet unconfigured       → free drift sweep still runs, no payment, skip
//   • happy path (quotes match) → cheapest item purchased, 0 drift/underpriced
//   • underpricing detected     → flagged in findings + value_extracted summary
//   • probe network failure     → recorded per item, never crashes the run

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real, pure catalog helpers — these drive the "expected" prices the audit
// compares quotes against, so we derive test fixtures from the same source.
import { buildCatalog } from '../../api/_lib/cosmetics.js';

const PREMIUM = buildCatalog().filter((c) => c.premium);
const CHEAPEST = [...PREMIUM].sort(
	(a, b) => Number(a.priceUsdcAtomics) - Number(b.priceUsdcAtomics) || a.id.localeCompare(b.id),
)[0];

// ── Mocks ────────────────────────────────────────────────────────────────────
const sqlLog = [];
const sql = vi.fn((strings) => {
	sqlLog.push(strings.join(' ? ').replace(/\s+/g, ' ').trim());
	return Promise.resolve([]);
});

// Quote returned by the live endpoint per cosmetic id. Defaults to the catalog
// price (no drift); a test overrides individual ids to simulate drift.
let quoteFor = {};
let probeThrowsForId = null;

const fetchWithTimeout = vi.fn(async (url) => {
	const id = decodeURIComponent(new URL(url).searchParams.get('id') || '');
	if (probeThrowsForId && id === probeThrowsForId) throw new Error('network_down');
	const item = PREMIUM.find((c) => c.id === id);
	const amount = String(quoteFor[id] ?? item?.priceUsdcAtomics ?? '0');
	return {
		status: 402,
		ok: false,
		headers: new Map(),
		body: { accepts: [{ network: 'solana:mainnet', asset: 'USDCmint', amount, extra: { feePayer: 'FP' }, payTo: 'PT' }] },
	};
});

const parseSolanaAccept = (challenge) =>
	(challenge?.accepts || []).find((a) => typeof a?.network === 'string' && a.network.startsWith('solana')) || null;

let loadSeedKeypairImpl = () => ({ publicKey: { toBase58: () => 'PAYER' } });
const loadSeedKeypair = vi.fn(() => loadSeedKeypairImpl());

let payX402Impl = async () => ({
	paid: true, success: true, free: false, skipped: false,
	amountAtomic: Number(CHEAPEST.priceUsdcAtomics),
	txSig: 'sig_123', status: 200, responseBody: { ok: true }, errorMsg: null,
});
const payX402 = vi.fn((...a) => payX402Impl(...a));
const bootstrapSolanaContext = vi.fn(async () => ({ buyer: {}, conn: {}, blockhash: 'bh', mintInfo: { decimals: 6 } }));

vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sql(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'https://three.ws', X402_ASSET_MINT_SOLANA: 'USDCmint', SOLANA_RPC_URL: 'http://rpc' },
}));
vi.mock('../../api/_lib/usage.js', () => ({ logger: () => ({ info() {}, warn() {} }) }));
vi.mock('../../api/_lib/x402/pay.js', () => ({
	loadSeedKeypair: (...a) => loadSeedKeypair(...a),
	payX402: (...a) => payX402(...a),
	bootstrapSolanaContext: (...a) => bootstrapSolanaContext(...a),
	fetchWithTimeout: (...a) => fetchWithTimeout(...a),
	parseSolanaAccept: (...a) => parseSolanaAccept(...a),
	USDC_MINT: 'USDCmint',
}));

import { run } from '../../api/_lib/x402/pipelines/cosmetic-pricing-audit.js';

// A payment context that avoids any real Solana lookups.
const PAID_CTX = { conn: {}, blockhash: 'bh', mintInfo: { decimals: 6 }, origin: 'https://three.ws', remainingCap: 5_000_000 };

beforeEach(() => {
	sqlLog.length = 0;
	quoteFor = {};
	probeThrowsForId = null;
	loadSeedKeypairImpl = () => ({ publicKey: { toBase58: () => 'PAYER' } });
	payX402Impl = async () => ({
		paid: true, success: true, free: false, skipped: false,
		amountAtomic: Number(CHEAPEST.priceUsdcAtomics),
		txSig: 'sig_123', status: 200, responseBody: { ok: true }, errorMsg: null,
	});
	vi.clearAllMocks();
});

describe('cosmetic pricing audit pipeline', () => {
	it('there is at least one premium item to audit (fixture sanity)', () => {
		expect(PREMIUM.length).toBeGreaterThan(0);
		expect(Number(CHEAPEST.priceUsdcAtomics)).toBeGreaterThan(0);
	});

	it('wallet unconfigured: runs the free drift sweep, never pays, returns skipped', async () => {
		loadSeedKeypairImpl = () => { throw new Error('seed keypair not configured'); };

		const out = await run({ ...PAID_CTX, buyer: undefined });

		expect(payX402).not.toHaveBeenCalled();
		expect(out.skipped).toBe(true);
		expect(out.reason).toBe('wallet_unconfigured');
		expect(out.amountAtomic).toBe(0);
		expect(out.items).toBe(PREMIUM.length);
		// Probed every premium item even without a wallet.
		expect(fetchWithTimeout).toHaveBeenCalledTimes(PREMIUM.length);
		// One audit row per item + one summary row at minimum.
		expect(sqlLog.some((t) => t.includes('INSERT INTO cosmetic_pricing_audit'))).toBe(true);
		expect(sqlLog.some((t) => t.includes('INSERT INTO x402_autonomous_log'))).toBe(true);
	});

	it('happy path: purchases the cheapest item, reports zero drift', async () => {
		const out = await run({ ...PAID_CTX, buyer: loadSeedKeypair() });

		expect(out.ok).toBe(true);
		expect(out.success).toBe(true);
		expect(out.driftCount).toBe(0);
		expect(out.underpricedCount).toBe(0);
		expect(out.purchasedId).toBe(CHEAPEST.id);
		expect(out.amountAtomic).toBe(Number(CHEAPEST.priceUsdcAtomics));
		expect(out.txSig).toBe('sig_123');

		// Exactly one real payment, against the cheapest premium item, over GET.
		expect(payX402).toHaveBeenCalledTimes(1);
		const arg = payX402.mock.calls[0][0];
		expect(arg.method).toBe('GET');
		expect(arg.url).toContain(`id=${encodeURIComponent(CHEAPEST.id)}`);
	});

	it('underpricing detected: a too-low quote is flagged', async () => {
		const victim = PREMIUM.find((c) => c.id !== CHEAPEST.id) || PREMIUM[0];
		quoteFor[victim.id] = Number(victim.priceUsdcAtomics) - 1; // 1 atomic under

		const out = await run({ ...PAID_CTX, buyer: loadSeedKeypair() });

		expect(out.underpricedCount).toBeGreaterThanOrEqual(1);
		expect(out.driftCount).toBeGreaterThanOrEqual(1);
		// The summary signal carries the offending id for alerting.
		expect(out.signalData.underpriced_ids).toContain(victim.id);
	});

	it('probe network failure on one item is recorded, run still completes', async () => {
		probeThrowsForId = PREMIUM[0].id;

		const out = await run({ ...PAID_CTX, buyer: loadSeedKeypair() });

		expect(out.ok).toBe(true);
		// Still wrote an audit row for every item (including the failed probe).
		const auditInserts = sqlLog.filter((t) => t.includes('INSERT INTO cosmetic_pricing_audit')).length;
		expect(auditInserts).toBe(PREMIUM.length);
	});
});
