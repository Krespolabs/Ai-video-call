#!/usr/bin/env node
// Rank the open backlog (everything the triage did NOT mark DONE) by a
// transparent composite priority score, so "what to do first" is reproducible
// rather than vibes. Consumes the triage written by verify-task-completion.mjs.
// Run `npm run prioritize` (triage + rank) or this directly after a triage pass.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Prefer a human/agent-adjudicated override if one exists; else the heuristic pass.
// Both must use verify-task-completion.mjs's schema ({ file, bucket, why, ... }).
const REPORT = existsSync('reports/task-completion-verified.json')
  ? 'reports/task-completion-verified.json'
  : 'reports/task-completion.json';

if (!existsSync(REPORT)) {
  console.error(`No triage report at ${REPORT}.  Run:  npm run triage`);
  process.exit(1);
}

const all = JSON.parse(readFileSync(REPORT, 'utf8')).filter(x => existsSync(x.file));

// --- priority model (transparent, grounded in repo focus) ------------------
// 1) actionability — how much undone work the triage actually detected.
const ACTION = { PENDING: 4, REVIEW: 2, DONE: 0 };

// 2) launch-criticality / value, keyed on the REAL current tree (not stale paths).
function valueWeight(file) {
  // launch-gating + must-run-first audits — break these and nothing else matters
  if (/(production-readiness|dead-paths|console-errors|routing-and-404|build-deploy-artifact|security-review|e2e-critical-flows|error-handling-failsafes|final-launch-checklist)/.test(file)) return 5;
  // money & trust: payments, wallets, on-chain, auth, abuse, SSRF
  if (/(x402-payments|wallet-connect|pumpfun-launches|three-holder-gating|onchain-contracts|solana-base-parity|api-rate-limiting|ssrf|passkey|proof-of-reserves|proof-of-custody|session-keys|threshold|sealed)/.test(file)) return 4;
  // cross-cutting quality + infra/ops that gate a credible launch
  if (/(test-coverage|accessibility|responsive|performance|seo|design-system|caching|observability|ci-cd|database-migrations|uptime|load-stress)/.test(file)) return 3;
  // core product surfaces (forge..dashboard == prompts/15-26)
  if (/prompts\/(1[5-9]|2[0-6])-/.test(file)) return 2;
  // growth / GTM
  if (/(homepage-conversion|docs-completeness|legal-compliance|analytics|notifications|i18n|pricing-monetization|pwa-extension)/.test(file)) return 1;
  // innovation tracks (vanity, living-wallet, agent-wallets, embodiment, autorig, ...) — post-launch reach
  return 0;
}

// 3) optional explicit override — honor a `Priority:` line if a prompt declares one.
const LABEL = /priority[:*\s]*\**\s*(critical|high|medium|low|p0|p1|p2|p3)/i;
const labelWeight = { critical: 3, p0: 3, high: 2, p1: 2, medium: 0, p2: 0, p3: -2, low: -2 };

for (const r of all) {
  const m = readFileSync(r.file, 'utf8').match(LABEL);
  r.label = m ? m[1].toLowerCase() : '';
  // uncertainty bump: a REVIEW backed by weak git evidence is more worth checking
  const uncertain = r.bucket === 'REVIEW' && (r.gitSignal ?? 0) < 0.5 ? 1 : 0;
  r.value = valueWeight(r.file);
  r.score = (ACTION[r.bucket] ?? 0) + r.value + (r.label ? labelWeight[r.label] : 0) + uncertain;
}

// Open backlog = anything not heuristically DONE. DONE-by-git stays out of the action list.
const open = all
  .filter(r => r.bucket !== 'DONE')
  .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

writeFileSync('reports/task-priority.csv',
  'rank,score,bucket,value,label,gitSignal,file,why\n' +
  open.map((r, i) => [i + 1, r.score, r.bucket, r.value, r.label || '-', r.gitSignal ?? '-', r.file,
    JSON.stringify((r.why || '').replace(/\s+/g, ' ').slice(0, 160))].join(',')).join('\n'));

const missingOf = (r) => [...new Set([...(r.newMissing || []), ...(r.refMissing || [])].filter(Boolean))];
const show = (r) => {
  const miss = missingOf(r);
  const tail = miss.length ? `missing: ${miss.slice(0, 4).join(', ')}` : (r.why || '');
  return `  [${r.score}] ${r.bucket}${r.label ? ' ·' + r.label : ''} (value ${r.value})  ${r.file}` +
    (tail ? `\n        ↳ ${tail}` : '');
};

const pending = open.filter(r => r.bucket === 'PENDING');
const review = open.filter(r => r.bucket === 'REVIEW');

console.log(`scanned ${all.length} prompt(s) — open backlog: ${open.length}  (DONE-by-triage: ${all.length - open.length})\n`);
console.log(`=== TIER 1 — MISSING DELIVERABLES (build, or prove an equivalent already ships): ${pending.length} ===`);
pending.forEach(r => console.log(show(r)));
console.log(`\n=== TIER 2 — BUILT BUT UNVERIFIED (behavior check / e2e before trusting): ${review.length} ===`);
review.forEach(r => console.log(show(r)));
console.log(`\nFull ranking incl. scores: reports/task-priority.csv`);
console.log(`Note: "DONE" means the declared files exist (git-slug heuristic) — not a verified behavior pass.`);
