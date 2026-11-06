import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const users = vi.hoisted(() => new Map());
vi.mock('../api/_lib/db.js', () => ({
	sql: async (strings, ...values) => {
		const email = users.get(values[0]);
		return email ? [{ email }] : [];
	},
}));

const RECIPIENT = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';
const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

describe('three.ws trade fee', () => {
	let fee;
	beforeEach(async () => {
		vi.resetModules();
		process.env.PUMP_PLATFORM_FEE_WALLET = RECIPIENT;
		delete process.env.PUMP_PLATFORM_FEE_BPS;
		users.clear();
		users.set('customer-1', 'creator@example.com');
		users.set('house-1', 'three-ws@users.three.ws.local');
		users.set('house-2', 'sniper-07@agents.three.ws');
		fee = await import('../api/_lib/pump-platform-fee.js');
	});
	afterEach(() => {
		delete process.env.PUMP_PLATFORM_FEE_WALLET;
		delete process.env.PUMP_PLATFORM_FEE_BPS;
	});

	it('charges 1% by default and can be turned off', () => {
		expect(fee.pumpPlatformFeeBps()).toBe(100);
		process.env.PUMP_PLATFORM_FEE_BPS = '0';
		expect(fee.pumpPlatformFeeBps()).toBe(0);
		process.env.PUMP_PLATFORM_FEE_BPS = '900';
		expect(fee.pumpPlatformFeeBps()).toBe(500);
	});

	it('bills a customer agent buy 1% of the SOL spent, to the treasury', async () => {
		const out = await fee.buildAgentTradeFee({ network: 'mainnet', payer: PAYER, userId: 'customer-1', side: 'buy', lamports: 250_000_000n });
		expect(out.disclosure).toMatchObject({ bps: 100, asset: 'SOL', amount: '2500000', recipient: RECIPIENT, basis: 'agent_buy' });
		expect(out.instructions).toHaveLength(1);
	});

	it('bills a sell on its minimum proceeds', async () => {
		const out = await fee.buildAgentTradeFee({ network: 'mainnet', payer: PAYER, userId: 'customer-1', side: 'sell', lamports: '99000000' });
		expect(out.disclosure).toMatchObject({ amount: '990000', basis: 'agent_sell' });
	});

	it('never bills the platform-owned agents', async () => {
		expect(await fee.buildAgentTradeFee({ network: 'mainnet', payer: PAYER, userId: 'house-1', side: 'buy', lamports: 1_000_000_000n })).toBeNull();
		expect(await fee.buildAgentTradeFee({ network: 'mainnet', payer: PAYER, userId: 'house-2', side: 'sell', lamports: 1_000_000_000n })).toBeNull();
	});

	it('bills a USDC-quoted trade in USDC', async () => {
		const out = await fee.buildAgentTradeFee({
			network: 'mainnet', payer: PAYER, userId: 'customer-1', side: 'buy', lamports: 50_000_000n,
			isUsdc: true, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		});
		expect(out.disclosure).toMatchObject({ asset: 'USDC', amount: '500000' });
		expect(out.instructions).toHaveLength(2);
	});
});
