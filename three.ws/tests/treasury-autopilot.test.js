// Unit tests for api/_lib/treasury-autopilot.js — the engine behind the agent
// that funds its own existence. These cover the parts that must be correct
// before any real custodial money moves:
//
//   - rule normalization (bounds, $THREE-only DCA target, sweep-dest validation)
//   - NL → structured-rules compilation (deterministic heuristic + model path)
//   - contradiction / warning detection in the owner-approval preview
//   - the executor's safety gates (kill switch, disarmed, frozen, price-feed gap)
//   - the dry-run path (evaluates without spending)
//   - owner-only persistence + sweep-destination stamping
//   - the honest runway math (net-negative vs self-sustaining)
//
// The DB, SOL price feed, chain RPC, wallet key recovery, and LLM are all mocked,
// so these are deterministic and fast — no real Solana, no real model call.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

// ── mocks ─────────────────────────────────────────────────────────────────────
const sqlState = { queue: [], calls: [] };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const walletState = { price: 150, balances: { sol: 0, usdc: 0 }, priceThrows: false };
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	solUsdPrice: vi.fn(async () => {
		if (walletState.priceThrows) throw new Error('price feed down');
		return walletState.price;
	}),
	sendSol: vi.fn(async () => 'SIG_sendSol_test'),
	explorerTxUrl: (sig, net) => `https://solscan.io/tx/${sig}${net === 'devnet' ? '?cluster=devnet' : ''}`,
	explorerAccountUrl: (addr, net) => `https://solscan.io/account/${addr}${net === 'devnet' ? '?cluster=devnet' : ''}`,
}));

vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => ({
		getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
		sendRawTransaction: vi.fn(async () => 'SIG_swap'),
		getLatestBlockhash: vi.fn(async () => ({ blockhash: 'bh', lastValidBlockHeight: 1 })),
		confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
		getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 1 }], context: { slot: 1 } })),
		getBlockHeight: vi.fn(async () => 1),
	})),
}));

vi.mock('../api/_lib/agent-wallet.js', () => ({
	getSolanaAddressBalances: vi.fn(async () => walletState.balances),
	recoverSolanaAgentKeypair: vi.fn(async () => Keypair.generate()),
}));

const llmState = { configured: false, complete: { text: '' } };
vi.mock('../api/_lib/llm.js', () => ({
	llmConfigured: vi.fn(() => llmState.configured),
	llmComplete: vi.fn(async () => llmState.complete),
}));

vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));

const ap = await import('../api/_lib/treasury-autopilot.js');
const {
	normalizeRule,
	normalizeAutopilot,
	getAutopilot,
	compilePolicyFromText,
	runAutopilotCycle,
	setAutopilot,
	computeRunway,
	AUTOPILOT_RULE_KINDS,
} = ap;
const { THREE_MINT } = await import('../api/_lib/networth-model.js');

const newAddr = () => Keypair.generate().publicKey.toBase58();

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	walletState.price = 150;
	walletState.balances = { sol: 0, usdc: 0 };
	walletState.priceThrows = false;
	llmState.configured = false;
	llmState.complete = { text: '' };
});

// ── rule normalization ──────────────────────────────────────────────────────────
describe('normalizeRule', () => {
	it('rejects an unknown rule kind', () => {
		expect(normalizeRule({ kind: 'rug' })).toBeNull();
		expect(normalizeRule(null)).toBeNull();
		expect(normalizeRule({})).toBeNull();
	});

	it('locks the DCA target to $THREE and is never owner-overridable', () => {
		const r = normalizeRule({ kind: 'dca', params: { target_mint: 'EVILtoken1111111111111111111111111111111111', pct: 10, basis: 'income' } });
		expect(r.params.target_mint).toBe(THREE_MINT);
	});

	it('clamps a DCA percentage into 0..100 and defaults the basis', () => {
		expect(normalizeRule({ kind: 'dca', params: { pct: 250 } }).params.pct).toBe(100);
		expect(normalizeRule({ kind: 'dca', params: { pct: 10 } }).params.basis).toBe('surplus');
		expect(normalizeRule({ kind: 'dca', params: { pct: 10, basis: 'income' } }).params.basis).toBe('income');
	});

	it('supports a fixed-SOL DCA (amount_sol) with pct cleared and bounded', () => {
		const r = normalizeRule({ kind: 'dca', params: { amount_sol: 0.5 } });
		expect(r.params.amount_sol).toBe(0.5);
		expect(r.params.pct).toBeNull();
		expect(normalizeRule({ kind: 'dca', params: { amount_sol: 99999 } }).params.amount_sol).toBe(1000);
	});

	it('clamps slippage into a safe band', () => {
		expect(normalizeRule({ kind: 'dca', params: { pct: 5, slippage_bps: 99999 } }).params.slippage_bps).toBe(2000);
		expect(normalizeRule({ kind: 'dca', params: { pct: 5, slippage_bps: 1 } }).params.slippage_bps).toBe(50);
	});

	it('validates a sweep destination and drops an invalid one', () => {
		const dest = newAddr();
		expect(normalizeRule({ kind: 'sweep', params: { destination: dest, threshold_sol: 3 } }).params.destination).toBe(dest);
		expect(normalizeRule({ kind: 'sweep', params: { destination: 'not-an-address', threshold_sol: 3 } }).params.destination).toBeNull();
	});

	it('coerces cadence + weekday (Sun=0..Sat=6, else null)', () => {
		expect(normalizeRule({ kind: 'sweep', params: { cadence: 'fortnightly' } }).params.cadence).toBe('weekly');
		expect(normalizeRule({ kind: 'sweep', params: { weekday: 5 } }).params.weekday).toBe(5);
		expect(normalizeRule({ kind: 'sweep', params: { weekday: 9 } }).params.weekday).toBeNull();
	});

	it('defaults enabled true, paused false, and synthesizes a human label', () => {
		const r = normalizeRule({ kind: 'self_fund' });
		expect(r.enabled).toBe(true);
		expect(r.paused).toBe(false);
		expect(typeof r.label).toBe('string');
		expect(r.label.length).toBeGreaterThan(0);
	});

	it('every advertised kind normalizes', () => {
		for (const kind of AUTOPILOT_RULE_KINDS) {
			expect(normalizeRule({ kind })?.kind).toBe(kind);
		}
	});
});

// ── policy normalization ──────────────────────────────────────────────────────────
describe('normalizeAutopilot / getAutopilot', () => {
	it('defaults to disarmed, no kill switch, no rules', () => {
		const a = normalizeAutopilot(undefined);
		expect(a.armed).toBe(false);
		expect(a.kill_switch).toBe(false);
		expect(a.rules).toEqual([]);
	});

	it('only literal true arms / kills (defense against truthy junk)', () => {
		expect(normalizeAutopilot({ armed: 'yes', kill_switch: 1 }).armed).toBe(false);
		expect(normalizeAutopilot({ armed: 'yes', kill_switch: 1 }).kill_switch).toBe(false);
		expect(normalizeAutopilot({ armed: true, kill_switch: true }).armed).toBe(true);
	});

	it('drops invalid rules and caps the list at 20', () => {
		const rules = Array.from({ length: 40 }, () => ({ kind: 'self_fund' }));
		rules.push({ kind: 'garbage' });
		expect(normalizeAutopilot({ rules }).rules.length).toBe(20);
	});

	it('validates the sweep destination at the policy level', () => {
		const dest = newAddr();
		expect(normalizeAutopilot({ sweep_destination: dest }).sweep_destination).toBe(dest);
		expect(normalizeAutopilot({ sweep_destination: 'bad' }).sweep_destination).toBeNull();
	});

	it('getAutopilot reads off meta.autopilot', () => {
		expect(getAutopilot({ autopilot: { armed: true } }).armed).toBe(true);
		expect(getAutopilot({}).armed).toBe(false);
	});
});

// ── NL compile (deterministic heuristic path) ─────────────────────────────────────
describe('compilePolicyFromText — heuristic', () => {
	it('rejects an empty policy', async () => {
		const r = await compilePolicyFromText('   ');
		expect(r.ok).toBe(false);
		expect(r.error).toBe('empty_policy');
	});

	it('compiles the canonical example into the five expected rules', async () => {
		const dest = newAddr();
		const r = await compilePolicyFromText(
			'Pay your own compute. Keep a 1 SOL buffer. Put 10% of tips into $THREE. Compound coin fees into buybacks weekly. Sweep anything over 3 SOL to me on Fridays.',
			{ sweepDestination: dest },
		);
		expect(r.ok).toBe(true);
		expect(r.via).toBe('heuristic');
		const kinds = r.rules.map((x) => x.kind).sort();
		expect(kinds).toEqual(['buffer', 'buyback', 'dca', 'self_fund', 'sweep']);
		expect(r.buffer_sol).toBe(1);

		const dca = r.rules.find((x) => x.kind === 'dca');
		expect(dca.params.basis).toBe('income');
		expect(dca.params.pct).toBe(10);
		expect(dca.params.target_mint).toBe(THREE_MINT);

		const sweep = r.rules.find((x) => x.kind === 'sweep');
		expect(sweep.params.threshold_sol).toBe(3);
		expect(sweep.params.weekday).toBe(5); // Friday
		expect(sweep.params.destination).toBe(dest); // stamped at compile time
	});

	it('parses a fixed-SOL daily DCA', async () => {
		const r = await compilePolicyFromText('Settle your own LLM bills, hold a 0.5 SOL floor, and DCA 0.1 SOL a day into $THREE.');
		const dca = r.rules.find((x) => x.kind === 'dca');
		expect(dca.params.amount_sol).toBe(0.1);
		expect(dca.params.cadence).toBe('daily');
		expect(r.buffer_sol).toBe(0.5);
	});

	it('flags a sweep threshold at/below the buffer as a contradiction', async () => {
		const r = await compilePolicyFromText('Keep a 3 SOL buffer and sweep anything over 1 SOL to me.', { sweepDestination: newAddr() });
		expect(r.contradictions.length).toBeGreaterThan(0);
		expect(r.contradictions.join(' ')).toMatch(/buffer/i);
	});

	it('warns when a sweep has no destination set', async () => {
		const r = await compilePolicyFromText('Sweep everything over 5 SOL to me weekly.');
		expect(r.warnings.join(' ')).toMatch(/destination/i);
	});

	it('never invents a coin other than $THREE', async () => {
		const r = await compilePolicyFromText('Put 25% of income into $THREE every day.');
		for (const rule of r.rules) {
			if (rule.kind === 'dca') expect(rule.params.target_mint).toBe(THREE_MINT);
		}
		expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-f]{40}/i);
	});
});

// ── NL compile (model path + graceful fallback) ───────────────────────────────────
describe('compilePolicyFromText — model path', () => {
	it('uses the model output when an LLM is configured and returns valid JSON', async () => {
		llmState.configured = true;
		llmState.complete = {
			text: '```json\n{"buffer_sol":2,"rules":[{"kind":"self_fund"},{"kind":"buffer"}],"warnings":[],"contradictions":[]}\n```',
		};
		const r = await compilePolicyFromText('pay your compute and keep 2 sol');
		expect(r.via).toBe('model');
		expect(r.buffer_sol).toBe(2);
		expect(r.rules.map((x) => x.kind).sort()).toEqual(['buffer', 'self_fund']);
	});

	it('falls back to the heuristic when the model returns unparseable text', async () => {
		llmState.configured = true;
		llmState.complete = { text: 'I think you should keep some SOL, friend.' };
		const r = await compilePolicyFromText('pay your own compute and keep a 1 sol buffer');
		expect(r.via).toBe('heuristic');
		expect(r.rules.map((x) => x.kind)).toContain('self_fund');
	});
});

// ── executor safety gates ─────────────────────────────────────────────────────────
describe('runAutopilotCycle — safety gates', () => {
	const armedMeta = (over = {}) => ({
		solana_address: newAddr(),
		encrypted_solana_secret: 'enc',
		autopilot: { armed: true, rules: [{ kind: 'self_fund' }], ...over },
	});

	it('does not run when the agent is missing', async () => {
		sqlState.queue.push([]); // SELECT agent → none
		const r = await runAutopilotCycle({ agentId: 'x' });
		expect(r.ran).toBe(false);
		expect(r.reason).toBe('not_found');
	});

	it('does not run when the kill switch is on', async () => {
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta: armedMeta({ kill_switch: true }) }]);
		const r = await runAutopilotCycle({ agentId: 'a' });
		expect(r).toMatchObject({ ran: false, reason: 'kill_switch' });
	});

	it('does not run when disarmed', async () => {
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta: { ...armedMeta(), autopilot: { armed: false, rules: [{ kind: 'self_fund' }] } } }]);
		const r = await runAutopilotCycle({ agentId: 'a' });
		expect(r).toMatchObject({ ran: false, reason: 'disarmed' });
	});

	it('does not run when there are no rules', async () => {
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta: { solana_address: newAddr(), autopilot: { armed: true, rules: [] } } }]);
		const r = await runAutopilotCycle({ agentId: 'a' });
		expect(r).toMatchObject({ ran: false, reason: 'no_rules' });
	});

	it('does not run when the wallet is frozen (kill-switch-equivalent)', async () => {
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta: { ...armedMeta(), spend_limits: { frozen: true } } }]);
		const r = await runAutopilotCycle({ agentId: 'a' });
		expect(r).toMatchObject({ ran: false, reason: 'wallet_frozen' });
	});

	it('pauses the whole cycle when the price feed is down — never guesses with real money', async () => {
		walletState.priceThrows = true;
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta: armedMeta() }]);
		const r = await runAutopilotCycle({ agentId: 'a' });
		expect(r).toMatchObject({ ran: false, reason: 'price_feed_unavailable' });
	});
});

// ── executor dry-run (evaluate, do not spend) ─────────────────────────────────────
describe('runAutopilotCycle — dry run', () => {
	it('reports what a DCA rule would do without moving funds or touching the key', async () => {
		walletState.balances = { sol: 5, usdc: 0 }; // well above the buffer
		const meta = {
			solana_address: newAddr(),
			encrypted_solana_secret: 'enc',
			autopilot: { armed: true, buffer_sol: 1, rules: [{ kind: 'dca', params: { amount_sol: 0.2, cadence: 'daily' } }] },
		};
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta }]);

		const wallet = await import('../api/_lib/agent-wallet.js');
		const avatar = await import('../api/_lib/avatar-wallet.js');

		const r = await runAutopilotCycle({ agentId: 'a', dryRun: true });
		expect(r.ran).toBe(true);
		const dca = r.results.find((x) => x.kind === 'dca');
		expect(dca.last_status).toBe('would_run');
		// dry run must never recover the signing key or send a transaction
		expect(wallet.recoverSolanaAgentKeypair).not.toHaveBeenCalled();
		expect(avatar.sendSol).not.toHaveBeenCalled();
	});

	it('windows income-basis DCA from the last settled DCA, not the last cron tick', async () => {
		walletState.balances = { sol: 5, usdc: 0 };
		const lastDca = '2026-06-01T00:00:00.000Z';
		const meta = {
			solana_address: newAddr(),
			encrypted_solana_secret: 'enc',
			autopilot: { armed: true, buffer_sol: 1, rules: [{ kind: 'dca', params: { basis: 'income', pct: 10, cadence: 'daily' } }] },
		};
		sqlState.queue.push([{ id: 'a', user_id: 'u', meta }]); // SELECT agent
		sqlState.queue.push([{ created_at: lastDca }]); // lastConfirmedActionAt
		sqlState.queue.push([{ usd: 8 }]); // getTipIncomeUsd over that window

		const r = await runAutopilotCycle({ agentId: 'a', dryRun: true });
		const dca = r.results.find((x) => x.kind === 'dca');
		expect(dca.last_status).toBe('would_run');
		// the tip-income query must carry the last-settled-DCA timestamp as its window
		const tipCall = sqlState.calls.find((c) => c.query.includes("'tip'"));
		expect(tipCall).toBeTruthy();
		expect(tipCall.values).toContain(lastDca);
	});
});

// ── owner-only persistence ────────────────────────────────────────────────────────
describe('setAutopilot', () => {
	it('refuses a non-owner', async () => {
		sqlState.queue.push([{ id: 'a', user_id: 'owner', meta: {} }]);
		await expect(setAutopilot('a', 'intruder', { armed: true })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
	});

	it('stamps the policy sweep destination onto sweep rules that lack one', async () => {
		const dest = newAddr();
		sqlState.queue.push([{ id: 'a', user_id: 'owner', meta: {} }]); // SELECT
		sqlState.queue.push([]); // UPDATE
		sqlState.queue.push([{ id: 1 }]); // recordCustodyEvent INSERT
		const next = await setAutopilot('a', 'owner', {
			sweep_destination: dest,
			rules: [{ kind: 'sweep', params: { threshold_sol: 3 } }],
		});
		const sweep = next.rules.find((r) => r.kind === 'sweep');
		expect(sweep.params.destination).toBe(dest);
		expect(next.updated_at).toBeTruthy();
	});
});

// ── the honest runway math ────────────────────────────────────────────────────────
describe('computeRunway', () => {
	const baseMeta = (over = {}) => ({ solana_address: newAddr(), autopilot: { armed: true, buffer_sol: 1, rules: [] }, ...over });

	// queue order: getComputeCostUsd, getTipIncomeUsd, breakdown
	function queueRunway({ costUsd, tipUsd, breakdown = [] }) {
		sqlState.queue.push([{ micro: String(Math.round(costUsd * 1e6)) }]);
		sqlState.queue.push([{ usd: tipUsd }]);
		sqlState.queue.push(breakdown);
	}

	it('reports an honest finite runway for a net-negative agent', async () => {
		walletState.price = 100;
		walletState.balances = { sol: 2, usdc: 0 }; // $200 balance, $100 buffer → $100 spendable
		queueRunway({ costUsd: 30, tipUsd: 10 }); // burns $30, earns $10 over 30d
		const r = await computeRunway({ agentId: 'a', meta: baseMeta() });
		expect(r.net_positive).toBe(false);
		expect(r.self_sustaining).toBe(false);
		expect(r.cost_usd).toBe(30);
		expect(r.income_usd).toBe(10);
		expect(r.runway_days).toBeGreaterThan(0);
		expect(Number.isFinite(r.runway_days)).toBe(true);
	});

	it('reports self-sustaining (no finite runway) when income covers the burn', async () => {
		walletState.price = 100;
		walletState.balances = { sol: 2, usdc: 0 };
		queueRunway({ costUsd: 30, tipUsd: 40 });
		const r = await computeRunway({ agentId: 'a', meta: baseMeta() });
		expect(r.net_positive).toBe(true);
		expect(r.self_sustaining).toBe(true);
		expect(r.runway_days).toBeNull(); // Infinity is surfaced as null (no burn)
	});

	it('breaks autopilot spend out by action for the dashboard', async () => {
		walletState.price = 100;
		walletState.balances = { sol: 1, usdc: 0 };
		queueRunway({
			costUsd: 5,
			tipUsd: 50,
			breakdown: [
				{ action: 'dca', usd: 12, lamports: '120000000', n: 3 },
				{ action: 'sweep', usd: 40, lamports: '400000000', n: 2 },
			],
		});
		const r = await computeRunway({ agentId: 'a', meta: baseMeta() });
		expect(r.dca_usd).toBe(12);
		expect(r.dca_count).toBe(3);
		expect(r.swept_sol).toBeCloseTo(0.4, 6);
		expect(r.sweep_count).toBe(2);
	});
});
