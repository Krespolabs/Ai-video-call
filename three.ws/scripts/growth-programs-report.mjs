#!/usr/bin/env node
// Print the trading growth programs' dry-run report against the real database:
// which big win the X lane would post (and the exact text), which accounts the
// first-rug softener would pay and why the rest are ineligible, and the
// early-leader standings and slot assignment. Read-only: it never posts, never
// writes a ledger row, never signs. See docs/growth-programs.md.
//
//   node --env-file=.env.local scripts/growth-programs-report.mjs            summary
//   node --env-file=.env.local scripts/growth-programs-report.mjs --json     full report

import { growthProgramsReport } from '../api/_lib/growth-programs/index.js';

const asJson = process.argv.includes('--json');
const report = await growthProgramsReport();

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}

const line = (s = '') => console.log(s);
line(`Growth programs dry run, ${report.generated_at}`);
line(`Flags: ${Object.entries(report.flags).map(([k, v]) => `${k}=${v ? 'ARMED' : 'off'}`).join('  ')}`);
line();

const bw = report.big_win_x;
line('Big-win X lane');
line(`  thresholds: >= ${bw.thresholds.min_pct}% on >= ${bw.thresholds.min_entry_sol} SOL in, >= ${bw.thresholds.min_pnl_sol} SOL realized, last ${bw.thresholds.lookback_hours}h`);
line(`  account posts in 24h: ${bw.budget.total} (lane ${bw.budget.lane}/${bw.budget.daily_cap}, account cap ${bw.budget.account_daily_cap})`);
line(`  would post: ${bw.would_post ? `\n    ${bw.would_post.text.replace(/\n/g, '\n    ')}` : 'nothing'}`);
if (bw.blocked) line(`  blocked: ${bw.blocked}`);
const reasons = {};
for (const c of bw.considered) reasons[c.reason || 'eligible'] = (reasons[c.reason || 'eligible'] || 0) + 1;
line(`  considered ${bw.considered.length} closes >= 50%: ${Object.entries(reasons).map(([k, v]) => `${v} ${k.replace(/ \(.*/, '')}`).join(', ') || 'none'}`);
line();

const rs = report.rug_softener;
line('First-rug softener');
line(`  SOL/USD: ${rs.sol_usd ?? 'unavailable'}; pays ${rs.config.reimbursePct}% of the loss, max $${rs.config.maxPerClaimUsd}/claim, $${rs.config.dailyCapUsd}/day`);
line(`  accounts evaluated: ${rs.candidates.length}; eligible: ${rs.eligible.length}; would pay: $${rs.would_pay_usd}`);
for (const c of rs.candidates) {
	const tag = c.eligible ? `ELIGIBLE $${c.amount.usd}` : c.unmet.map((u) => u.criterion).join(', ');
	line(`    ${c.user_id.slice(0, 8)}  first trade ${c.evidence.symbol || '?'} ${c.evidence.realized_pnl_sol ?? '?'} SOL  ${tag}`);
}
line();

const el = report.early_leader;
line('Early-leader program');
line(`  ${el.config.slots} slots, $${el.config.bonusUsd} each, $${el.config.weeklyCapUsd}/week; open slots: ${el.open_slots}`);
line(`  would enroll: ${el.would_enroll.length ? el.would_enroll.map((w) => w.name).join(', ') : 'nobody yet'}`);
for (const s of el.standings) {
	line(`    ${String(s.name).slice(0, 24).padEnd(24)} ${String(s.stats.settled).padStart(4)} trades  ${String(s.stats.win_rate_pct).padStart(6)}% win  ${String(s.stats.realized_pnl_sol).padStart(9)} SOL  unmet: ${s.unmet.map((u) => u.criterion).join(', ') || 'none'}`);
}
line();
line(`Ledger: ${JSON.stringify(report.ledger)}`);
