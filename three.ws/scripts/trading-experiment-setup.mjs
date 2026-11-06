#!/usr/bin/env node
// scripts/trading-experiment-setup.mjs
//
// Arm ONE agent with the "10 SOL trading experiment" strategy — the concrete,
// reproducible config that encodes the owner's risk rules:
//
//   - Buy only newer projects: market cap $10k–$100k.
//   - NEVER buy pump.fun "Mayhem" tokens (enforced in the worker; no flag needed
//     here — the gate is on by default).
//   - Take initials at 2× (recover the cost basis), keep a 15% moon bag minimum,
//     let the rest ride on a 25% trailing stop. NEVER a 100% exit on the way up.
//   - Mandatory 35% stop-loss (hard downside cap).
//   - Sized for a ~10 SOL budget: 0.25 SOL/trade, 2 SOL/day, ≤4 concurrent.
//
// It NEVER moves money: it does not fund the wallet (auto_fund stays off — the
// owner funds the agent from the UI deposit tab) and it arms the strategy in
// SIMULATE posture by leaving it disabled unless --enable is passed. Prints the
// exact config and the funding + go-live checklist.
//
// Usage:
//   node scripts/trading-experiment-setup.mjs --agent <agentId> [--user <userId>]
//                                             [--network mainnet|devnet]
//                                             [--budget-sol 10] [--enable] [--dry-run]
//
//   --dry-run   print the strategy JSON and exit (no DB write) — the default when
//               DATABASE_URL is unset.
//   --enable    arm it enabled=true. Omit to stage it disabled (recommended:
//               fund + review, then enable from the UI).

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const SOL = 1_000_000_000n;
const agentId = opt('agent', null);
const userId = opt('user', null);
const network = opt('network', 'mainnet');
const budgetSol = Number(opt('budget-sol', '10'));
const enable = flag('enable');
const dryRun = flag('dry-run') || !process.env.DATABASE_URL;

if (!agentId) {
	console.error('Missing --agent <agentId>. This is the agent whose wallet will trade.');
	process.exit(1);
}

// Sizing derived from the budget: risk ~2.5% of the pot per trade, ~20%/day.
const perTradeSol = Math.max(0.01, Math.round(budgetSol * 0.025 * 1000) / 1000);
const dailyBudgetSol = Math.max(perTradeSol, Math.round(budgetSol * 0.2 * 1000) / 1000);
const toLamports = (sol) => (BigInt(Math.round(sol * 1e9))).toString();

const strategy = {
	agent_id: agentId,
	user_id: userId,
	network,
	enabled: enable,
	kill_switch: false,
	trigger: 'new_mint',
	// Entry universe: newer projects, $10k–$100k market cap.
	min_market_cap_usd: 10_000,
	max_market_cap_usd: 100_000,
	require_socials: true, // skip no-socials launches (a cheap quality filter)
	max_creator_launches: 10, // skip serial launchers
	// Sizing for the ~10 SOL pot.
	per_trade_lamports: toLamports(perTradeSol),
	daily_budget_lamports: toLamports(dailyBudgetSol),
	max_concurrent_positions: 4,
	slippage_bps: 500,
	max_price_impact_pct: 10,
	// The laddered exit: take initials at 2×, keep ≥15% moon bag, trail 25%.
	initials_out_multiple: 2,
	moonbag_min_pct: 15,
	trailing_stop_pct: 25,
	take_profit_pct: null, // no ceiling — let the moon bag run on the trailing stop
	stop_loss_pct: 35, // mandatory hard downside cap
	max_hold_seconds: 86_400, // 24h time-stop
	// Funding stays MANUAL — the owner deposits from the UI; no master auto-fund.
	auto_fund_enabled: false,
};

console.log('\n=== 10 SOL trading experiment — strategy ===\n');
console.log(JSON.stringify(strategy, null, 2));
console.log(`\nBudget ${budgetSol} SOL → ${perTradeSol} SOL/trade, ${dailyBudgetSol} SOL/day, ≤4 concurrent.`);
console.log('Entry: $10k–$100k mcap, socials required, no serial launchers, NO Mayhem tokens.');
console.log('Exit: take initials at 2× (keep ≥15% moon bag), trail 25%, hard stop 35%, 24h timeout.');

if (dryRun) {
	console.log('\n[dry-run] No DB write. Set DATABASE_URL and drop --dry-run to arm.\n');
	printChecklist();
	process.exit(0);
}

const { sql } = await import('../api/_lib/db.js');
const cols = Object.keys(strategy);
const vals = Object.values(strategy);
// Build an INSERT … ON CONFLICT that mirrors the arm API's upsert.
const colList = cols.join(', ');
const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
const updates = cols.filter((c) => !['agent_id', 'network'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
const query = `insert into agent_sniper_strategies (${colList}, updated_at)
	values (${placeholders}, now())
	on conflict (agent_id, network) do update set ${updates}, updated_at = now()
	returning id, enabled`;
const [row] = await sql.query(query, vals);
console.log(`\nArmed strategy ${row.id} (enabled=${row.enabled}) for agent ${agentId} on ${network}.`);
printChecklist();

function printChecklist() {
	console.log('\n=== Before it trades real money ===');
	console.log('  1. Fund the agent wallet from the UI: /agent/' + agentId + '/wallet#deposit (send ~' + budgetSol + ' SOL).');
	console.log('  2. Run the worker in SIMULATE first (SNIPER_MODE=simulate) and watch /api/sniper/journal.');
	console.log('  3. Confirm: 10k–100k mints pass, Mayhem mints are skipped (mayhem_excluded), a 2× position takes initials + keeps a moon bag.');
	console.log('  4. Go live deliberately: SNIPER_MODE=live and enable the strategy. Kill switches: strategy kill_switch, or SNIPER_GLOBAL_KILL=1.');
	console.log('  5. Auto-funding stays OFF (auto_fund_enabled=false) — top up manually from the UI.\n');
}
