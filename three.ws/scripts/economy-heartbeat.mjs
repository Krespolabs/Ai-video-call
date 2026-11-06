// @ts-check
// scripts/economy-heartbeat.mjs — external failover scheduler for Vercel crons.
//
// Vercel Cron is the primary scheduler for every /api/cron/* endpoint. When the
// Vercel project cannot run crons (account block, paused project, migration),
// this script drives the exact same endpoints on the exact same schedules,
// reading the single source of truth: the `crons` array in vercel.json.
//
// It runs for DURATION_MINUTES (default 5), waking at each UTC minute boundary,
// firing every cron whose schedule matches that minute, concurrently, with the
// same `Authorization: Bearer $CRON_SECRET` header Vercel would send.
//
// Usage:
//   CRON_SECRET=… node scripts/economy-heartbeat.mjs
//   BASE_URL=https://three.ws CRON_SECRET=… DURATION_MINUTES=5 node scripts/economy-heartbeat.mjs
//   ONLY='pulse|x402' CRON_SECRET=… node scripts/economy-heartbeat.mjs   # filter by path regex
//
// Exit codes: 0 = at least one call succeeded (or nothing was due);
//             1 = calls were attempted and every single one failed (outage/bad secret).
//
// Endpoints that 404 are reported but never fail the run — the deployed build
// may lag the repo's vercel.json (new crons exist here before they deploy).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/+$/, '');
const CRON_SECRET = process.env.CRON_SECRET;
const DURATION_MINUTES = Math.max(1, Math.min(30, Number(process.env.DURATION_MINUTES) || 5));
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const CALL_TIMEOUT_MS = 115_000; // Vercel cron maxDuration is 120s

if (!CRON_SECRET) {
	console.error('CRON_SECRET is required (the Vercel cron bearer secret).');
	process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercelConfig = JSON.parse(await readFile(join(repoRoot, 'vercel.json'), 'utf8'));
const crons = (vercelConfig.crons || []).filter((c) => !ONLY || ONLY.test(c.path));

if (!crons.length) {
	console.error(`No crons matched${ONLY ? ` ONLY=${ONLY}` : ''} in vercel.json.`);
	process.exit(1);
}

// Parse one field of a 5-field cron expression into a Set of matching values.
// Supports the forms used in vercel.json: *, */N, A, A-B, A-B/N, and comma lists.
function parseField(field, min, max) {
	const values = new Set();
	for (const part of field.split(',')) {
		const [rangePart, stepPart] = part.split('/');
		const step = stepPart ? Number(stepPart) : 1;
		let lo = min;
		let hi = max;
		if (rangePart !== '*') {
			const [a, b] = rangePart.split('-').map(Number);
			lo = a;
			hi = b === undefined ? (stepPart ? max : a) : b;
		}
		if (!Number.isInteger(step) || step < 1 || !Number.isInteger(lo) || !Number.isInteger(hi)) {
			throw new Error(`unsupported cron field: ${field}`);
		}
		for (let v = lo; v <= hi; v += step) values.add(v);
	}
	return values;
}

function compileSchedule(schedule) {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`unsupported cron expression: ${schedule}`);
	const [minute, hour, dom, month, dow] = fields;
	return {
		minute: parseField(minute, 0, 59),
		hour: parseField(hour, 0, 23),
		dom: parseField(dom, 1, 31),
		month: parseField(month, 1, 12),
		dow: parseField(dow, 0, 6),
	};
}

const compiled = crons.map((c) => ({ path: c.path, schedule: c.schedule, match: compileSchedule(c.schedule) }));

function dueAt(date) {
	const m = date.getUTCMinutes();
	const h = date.getUTCHours();
	const dom = date.getUTCDate();
	const mon = date.getUTCMonth() + 1;
	const dow = date.getUTCDay();
	return compiled.filter(
		(c) => c.match.minute.has(m) && c.match.hour.has(h) && c.match.dom.has(dom) && c.match.month.has(mon) && c.match.dow.has(dow),
	);
}

async function callCron(path) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}${path}`, {
			headers: { authorization: `Bearer ${CRON_SECRET}` },
			signal: controller.signal,
		});
		const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
		return { path, status: res.status, ms: Date.now() - started, body };
	} catch (err) {
		return { path, status: 0, ms: Date.now() - started, body: String(err?.message || err) };
	} finally {
		clearTimeout(timer);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let succeeded = 0;
let missing = 0;
let failed = 0;

console.log(`economy-heartbeat: ${compiled.length} crons from vercel.json → ${BASE_URL}, ${DURATION_MINUTES} minute(s)`);

for (let tick = 0; tick < DURATION_MINUTES; tick++) {
	const now = new Date();
	const due = dueAt(now);
	const stamp = now.toISOString().slice(0, 16) + 'Z';
	if (due.length) {
		console.log(`[${stamp}] firing ${due.length} due cron(s)`);
		const results = await Promise.all(due.map((c) => callCron(c.path)));
		for (const r of results) {
			const tag = r.status >= 200 && r.status < 300 ? 'ok' : r.status === 404 ? 'missing' : 'FAIL';
			if (tag === 'ok') succeeded++;
			else if (tag === 'missing') missing++;
			else failed++;
			console.log(`  ${tag.padEnd(7)} ${String(r.status).padEnd(3)} ${String(r.ms).padStart(6)}ms ${r.path} ${tag === 'ok' ? '' : `— ${r.body}`}`);
		}
	} else {
		console.log(`[${stamp}] nothing due`);
	}
	if (tick < DURATION_MINUTES - 1) {
		const msToNextMinute = 60_000 - (Date.now() % 60_000);
		await sleep(msToNextMinute + 250);
	}
}

console.log(`economy-heartbeat done: ${succeeded} ok, ${missing} not deployed (404), ${failed} failed`);
if (failed > 0 && succeeded === 0) {
	console.error('Every attempted cron call failed — check CRON_SECRET and site availability.');
	process.exit(1);
}
