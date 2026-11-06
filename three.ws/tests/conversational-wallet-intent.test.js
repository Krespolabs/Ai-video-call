// Unit tests for the Conversational Wallet parser's safety-critical pure logic:
// api/agents/solana-intent.js → resolveAssetToken + normalizeWalletIntent.
//
// These functions are the boundary between a fuzzy LLM tool output and a real,
// executable wallet intent. The rules they must never break: $THREE is the only
// coin resolved by name; a malformed/ambiguous parse collapses to a clarify (money
// never moves on a guess); amounts and slippage are clamped. The LLM HTTP path and
// DB/auth are not exercised here — only the deterministic normalization.

import { describe, it, expect, vi } from 'vitest';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Stub the heavy server-only imports so importing the handler module is cheap and
// side-effect-free. The pure functions under test don't call any of them.
vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(), authenticateBearer: vi.fn(), extractBearer: vi.fn(),
}));
vi.mock('../api/_lib/http.js', () => ({
	cors: vi.fn(), json: vi.fn(), method: vi.fn(), error: vi.fn(), readJson: vi.fn(), rateLimited: vi.fn(),
}));
vi.mock('../api/_lib/rate-limit.js', () => ({ limits: { chatUser: vi.fn() }, clientIp: vi.fn() }));
vi.mock('../api/_lib/provider-keys.js', () => ({ loadUserProviderKeys: vi.fn(async () => ({})) }));
vi.mock('../src/solana/sns.js', () => ({ resolveSolanaRecipient: vi.fn(async () => ({ address: null })) }));
vi.mock('../api/_lib/networth-model.js', () => ({ THREE_MINT: THREE }));
vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	getSpendLimits: vi.fn(() => ({})), getTradeLimits: vi.fn(() => ({})),
}));

const { resolveAssetToken, normalizeWalletIntent } = await import('../api/agents/solana-intent.js');

describe('resolveAssetToken', () => {
	it('resolves $THREE / three by name to the canonical mint', () => {
		expect(resolveAssetToken('$THREE')).toMatchObject({ kind: 'three', mint: THREE, symbol: '$THREE' });
		expect(resolveAssetToken('three')).toMatchObject({ kind: 'three', mint: THREE });
		expect(resolveAssetToken('THREE')).toMatchObject({ kind: 'three', mint: THREE });
	});

	it('recognises SOL and USDC', () => {
		expect(resolveAssetToken('SOL').kind).toBe('sol');
		expect(resolveAssetToken('solana').kind).toBe('sol');
		expect(resolveAssetToken('usdc').kind).toBe('usdc');
	});

	it('passes a base58 mint through as a runtime target', () => {
		const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
		expect(resolveAssetToken(mint)).toMatchObject({ kind: 'mint', mint });
	});

	it('flags the canonical mint string as $THREE even when pasted raw', () => {
		expect(resolveAssetToken(THREE)).toMatchObject({ kind: 'three', symbol: '$THREE' });
	});

	it('returns unknown for an unrecognised symbol', () => {
		expect(resolveAssetToken('DOGE').kind).toBe('unknown');
		expect(resolveAssetToken('').kind).toBe('none');
	});
});

describe('normalizeWalletIntent', () => {
	it('maps swap → buy and resolves the $THREE target', () => {
		const out = normalizeWalletIntent({
			action: 'swap', amount: 0.5, amount_unit: 'SOL', destination_or_mint: '$THREE',
			confidence: 0.9, readback: 'Buy $THREE with 0.5 SOL.',
		});
		expect(out.action).toBe('buy');
		expect(out.target).toMatchObject({ kind: 'three', mint: THREE });
		expect(out.amount).toBe(0.5);
		expect(out.amount_unit).toBe('SOL');
	});

	it('keeps snipe distinct and carries the runtime mint', () => {
		const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
		const out = normalizeWalletIntent({
			action: 'snipe', amount: 0.5, amount_unit: 'SOL', destination_or_mint: mint,
			confidence: 0.8, readback: 'Snipe with 0.5 SOL.',
		});
		expect(out.action).toBe('snipe');
		expect(out.target.mint).toBe(mint);
	});

	it('normalises a withdraw with destination + asset', () => {
		const out = normalizeWalletIntent({
			action: 'withdraw', amount: 2, amount_unit: 'SOL', asset: 'SOL',
			destination_or_mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
			confidence: 0.95, readback: 'Withdraw 2 SOL.',
		});
		expect(out.action).toBe('withdraw');
		expect(out.asset.kind).toBe('sol');
		expect(out.destination).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
		expect(out.amount).toBe(2);
	});

	it('collapses an unknown action to none', () => {
		const out = normalizeWalletIntent({ action: 'launch', confidence: 0.9, readback: '' });
		expect(out.action).toBe('none');
	});

	it('preserves a clarify with its question', () => {
		const out = normalizeWalletIntent({
			action: 'clarify', confidence: 0.3, readback: '',
			clarifying_question: 'Which token?',
		});
		expect(out.action).toBe('clarify');
		expect(out.clarifying_question).toBe('Which token?');
	});

	it('supplies a default clarify question when the model omits one', () => {
		const out = normalizeWalletIntent({ action: 'clarify', confidence: 0.3, readback: '' });
		expect(out.clarifying_question).toBeTruthy();
	});

	it('clamps slippage to [0,50] and drops non-positive amounts', () => {
		const out = normalizeWalletIntent({
			action: 'buy', amount: -5, amount_unit: 'SOL', destination_or_mint: '$THREE',
			slippage_pct: 999, confidence: 1.2, readback: 'x',
		});
		expect(out.amount).toBeNull();
		expect(out.slippage_pct).toBe(50);
		expect(out.confidence).toBe(1); // clamped to [0,1]
	});

	it('never throws on garbage input — degrades to none', () => {
		expect(normalizeWalletIntent(null).action).toBe('none');
		expect(normalizeWalletIntent({}).action).toBe('none');
		expect(normalizeWalletIntent('nope').action).toBe('none');
	});
});
