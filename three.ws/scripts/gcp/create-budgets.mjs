#!/usr/bin/env node
// scripts/gcp/create-budgets.mjs — Cloud Billing budget alerts for the credit program.
//
// Creates (idempotently) the budgets that route runaway-spend warnings to the
// team before a lane blows the grant:
//
//   • Overall program budget = the full grant ($GCP_CREDIT_TOTAL_USD), with
//     threshold alerts at 25 / 50 / 75 / 90 / 100 %, measured on GROSS spend
//     (credits excluded) so it tracks consumption of the grant, not net $0.
//   • Per-service budgets for the big lanes (Vertex AI, Cloud Run, Compute
//     Engine) sized from GCP_SERVICE_BUDGETS or sensible defaults.
//
// All budgets publish to a single Pub/Sub topic; api/webhooks/gcp-budget-alert.js
// turns each notification into a Telegram ops ping (the same bot the changelog
// uses, but the PRIVATE ops chat — never the holders' channel).
//
// Idempotent: an existing budget with the same displayName is PATCHed, not
// duplicated. Safe to re-run.
//
// Usage:
//   node scripts/gcp/create-budgets.mjs            # DRY RUN — prints the plan
//   node scripts/gcp/create-budgets.mjs --apply    # create/update the budgets
//
// Env:
//   GCP_BILLING_ACCOUNT_ID   billing account (else first open account from gcloud)
//   GOOGLE_CLOUD_PROJECT     project the budget is scoped to
//   GCP_CREDIT_TOTAL_USD     grant size (overall budget amount), default 100000
//   GCP_BUDGET_PUBSUB_TOPIC  topic name (default: gcp-budget-alerts)
//   GCP_SERVICE_BUDGETS      optional JSON: { "Vertex AI": 50000, "Cloud Run": 20000 }
//
// Auth: GCP_SERVICE_ACCOUNT_JSON if present, else `gcloud auth print-access-token`.
// Budget creation needs billing.budgets.create on the billing account — usually
// an owner identity, so this is an operator-run script.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const { getGcpAccessToken, gcpAuthConfigured } = await import(resolve(REPO_ROOT, 'api/_lib/gcp-auth.js'));

const APPLY = process.argv.includes('--apply');

const DEFAULT_SERVICE_BUDGETS = { 'Vertex AI': 55000, 'Cloud Run': 20000, 'Compute Engine': 15000 };

function fail(msg) {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
}

// User tokens (gcloud fallback) need x-goog-user-project on REST calls or the
// API rejects them with a "requires a quota project" 403. SA tokens must NOT
// send it — they carry their own quota project and may lack serviceusage.use.
let userToken = false;

async function token() {
	if (gcpAuthConfigured()) return getGcpAccessToken();
	try {
		userToken = true;
		return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
	} catch {
		fail('no GCP_SERVICE_ACCOUNT_JSON and `gcloud auth print-access-token` failed. Run `gcloud auth login`.');
	}
}

function gcloudValue(args) {
	try {
		return execFileSync('gcloud', args, { encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

async function gapi(tok, method, url, body) {
	const res = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${tok}`,
			'content-type': 'application/json',
			...(userToken ? { 'x-goog-user-project': project } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`${method} ${url.split('?')[0]} → ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
	}
	return data;
}

// ── Resolve config ──────────────────────────────────────────────────────────
const project = process.env.GOOGLE_CLOUD_PROJECT || gcloudValue(['config', 'get-value', 'project']);
if (!project) fail('no project. Set GOOGLE_CLOUD_PROJECT or `gcloud config set project <id>`.');

let billingAccount = process.env.GCP_BILLING_ACCOUNT_ID || '';
if (!billingAccount) {
	// First OPEN billing account.
	billingAccount = gcloudValue(['billing', 'accounts', 'list', '--filter=open=true', '--format=value(name)', '--limit=1'])
		.replace(/^billingAccounts\//, '');
}
if (!billingAccount) fail('no billing account. Set GCP_BILLING_ACCOUNT_ID.');

const projectNumber = gcloudValue(['projects', 'describe', project, '--format=value(projectNumber)']);
if (!projectNumber) fail(`could not resolve project number for ${project} (check gcloud auth).`);

const creditTotal = Number(process.env.GCP_CREDIT_TOTAL_USD || 100000);
const topicName = process.env.GCP_BUDGET_PUBSUB_TOPIC || 'gcp-budget-alerts';
const pubsubTopic = `projects/${project}/topics/${topicName}`;
const serviceBudgets = process.env.GCP_SERVICE_BUDGETS
	? JSON.parse(process.env.GCP_SERVICE_BUDGETS)
	: DEFAULT_SERVICE_BUDGETS;

const THRESHOLDS = [0.25, 0.5, 0.75, 0.9, 1.0];
const budgetsBase = `https://billingbudgets.googleapis.com/v1/billingAccounts/${billingAccount}/budgets`;

console.log('── GCP credit-program budget alerts ────────────────────────────────');
console.log(`   billing account: ${billingAccount}`);
console.log(`   project: ${project} (#${projectNumber})`);
console.log(`   pub/sub topic: ${pubsubTopic}`);
console.log(`   overall budget: $${creditTotal.toLocaleString()}  thresholds: ${THRESHOLDS.map((t) => t * 100 + '%').join(' ')}`);
console.log(`   per-service: ${Object.entries(serviceBudgets).map(([s, a]) => `${s}=$${Number(a).toLocaleString()}`).join(', ')}`);
console.log(`   mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log('');

const tok = await token();

// ── Ensure the Pub/Sub topic exists ─────────────────────────────────────────
function ensureTopic() {
	const exists = gcloudValue(['pubsub', 'topics', 'describe', topicName, `--project=${project}`, '--format=value(name)']);
	if (exists) {
		console.log(`Pub/Sub topic ${topicName}: exists`);
		return;
	}
	if (!APPLY) {
		console.log(`Pub/Sub topic ${topicName}: would create`);
		return;
	}
	execFileSync('gcloud', ['pubsub', 'topics', 'create', topicName, `--project=${project}`], { stdio: 'inherit' });
	console.log(`Pub/Sub topic ${topicName}: created`);
}
ensureTopic();
console.log('');

// The billing-budgets service account must be allowed to publish to the topic.
// (Owner runs this once; documented in docs/gcp-credits.md.)
console.log('NOTE: grant the budgets publisher SA pub/sub access if not already:');
console.log(`   gcloud pubsub topics add-iam-policy-binding ${topicName} --project=${project} \\`);
console.log('     --member=serviceAccount:billing-budgets.iam.gserviceaccount.com --role=roles/pubsub.publisher');
console.log('');

// ── Fetch existing budgets (for idempotent upsert) ──────────────────────────
async function existingByName() {
	const map = new Map();
	let pageToken = '';
	do {
		const url = `${budgetsBase}?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
		const data = await gapi(tok, 'GET', url);
		for (const b of data.budgets || []) map.set(b.displayName, b.name);
		pageToken = data.nextPageToken || '';
	} while (pageToken);
	return map;
}

function budgetBody({ displayName, amountUnits, services }) {
	const filter = {
		projects: [`projects/${projectNumber}`],
		// GROSS spend against the grant size — credits excluded so the budget
		// actually fires as the grant is consumed (net-of-credits would sit ~$0).
		creditTypesTreatment: 'EXCLUDE_ALL_CREDITS',
	};
	if (services && services.length) filter.services = services;
	return {
		displayName,
		budgetFilter: filter,
		amount: { specifiedAmount: { currencyCode: 'USD', units: String(Math.round(amountUnits)) } },
		thresholdRules: THRESHOLDS.map((t) => ({ thresholdPercent: t, spendBasis: 'CURRENT_SPEND' })),
		notificationsRule: { pubsubTopic, schemaVersion: '1.0' },
	};
}

async function upsertBudget(existing, body) {
	const name = existing.get(body.displayName);
	if (!APPLY) {
		console.log(`   ${name ? 'would PATCH' : 'would CREATE'} budget "${body.displayName}" ($${Number(body.amount.specifiedAmount.units).toLocaleString()})`);
		return;
	}
	if (name) {
		await gapi(tok, 'PATCH', `https://billingbudgets.googleapis.com/v1/${name}?updateMask=displayName,budgetFilter,amount,thresholdRules,notificationsRule`, body);
		console.log(`   updated budget "${body.displayName}"`);
	} else {
		const created = await gapi(tok, 'POST', budgetsBase, body);
		console.log(`   created budget "${body.displayName}" (${created.name})`);
	}
}

// ── Resolve service ids from the billing catalog (for per-service budgets) ───
async function resolveServiceIds(displayNames) {
	const want = new Set(displayNames);
	const found = new Map();
	let pageToken = '';
	do {
		const url = `https://cloudbilling.googleapis.com/v1/services?pageSize=5000${pageToken ? `&pageToken=${pageToken}` : ''}`;
		const data = await gapi(tok, 'GET', url);
		for (const s of data.services || []) {
			if (want.has(s.displayName)) found.set(s.displayName, s.name); // name = "services/XXXX-..."
		}
		pageToken = data.nextPageToken || '';
	} while (pageToken && found.size < want.size);
	return found;
}

try {
	const existing = await existingByName();

	console.log('Budgets:');
	await upsertBudget(existing, budgetBody({ displayName: 'gcp-credits — program', amountUnits: creditTotal }));

	const serviceIds = await resolveServiceIds(Object.keys(serviceBudgets));
	for (const [svc, amount] of Object.entries(serviceBudgets)) {
		const sid = serviceIds.get(svc);
		if (!sid) {
			console.log(`   ⚠️  service "${svc}" not found in billing catalog — skipped`);
			continue;
		}
		await upsertBudget(existing, budgetBody({ displayName: `gcp-credits — ${svc}`, amountUnits: amount, services: [sid] }));
	}

	console.log('');
	console.log(`── Done.${APPLY ? '' : ' DRY RUN — re-run with --apply to create the budgets.'}`);
	console.log('   Alert handler: api/webhooks/gcp-budget-alert.js  (subscribe the topic to it)');
} catch (err) {
	fail(err?.message || String(err));
}
