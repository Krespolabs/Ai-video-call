#!/usr/bin/env node
/**
 * Record that a doc was read against the code and found correct.
 *
 * `npm run docs:freshness` measures drift from the doc's last commit, which is
 * the only clock git gives it. That clock is wrong in one common case: someone
 * reads a page end to end, checks every claim against the source, and finds
 * nothing to fix. The work happened, the doc is verified, and the measurement
 * still says stale. The last full sweep ended with 8 docs in exactly that state,
 * and the only ways out were a cosmetic edit (a lie in the history) or leaving a
 * permanent false positive that teaches people to ignore the dashboard.
 *
 * A review stamp is the missing clock. It records WHO checked WHAT against WHICH
 * commit, and freshness is then measured from whichever is newer, the doc's last
 * edit or its last review.
 *
 * Usage:
 *   npm run docs:review -- docs/forge.md --note "checked lanes and timeouts"
 *   npm run docs:review -- docs/a.md docs/b.md --at 1a2b3c4d5   stamp at a specific commit
 *   npm run docs:review -- docs/security/review-2026-06-24.md --snapshot
 *   npm run docs:review -- --list          what is stamped, newest first
 *   npm run docs:review -- --prune         drop stamps for docs that no longer exist
 *
 * `--snapshot` is for a doc that records a moment rather than describing current
 * behavior: a dated audit, an incident writeup, a finished work order, an
 * upstream issue draft. Rewriting one to match today's code would destroy the
 * record, so it is never counted as drift.
 *
 * Writes data/docs-freshness-reviews.json, read by scripts/doc-freshness.mjs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(ROOT, 'data/docs-freshness-reviews.json');

const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const opt = (name) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const git = (args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();

function loadStore() {
	const raw = JSON.parse(readFileSync(STORE, 'utf8'));
	raw.reviews ||= {};
	return raw;
}

/** Stable on disk: sorted by path, so two agents stamping different docs never fight. */
function saveStore(store) {
	const sorted = {};
	for (const key of Object.keys(store.reviews).sort()) sorted[key] = store.reviews[key];
	store.reviews = sorted;
	writeFileSync(STORE, JSON.stringify(store, null, '\t') + '\n');
}

function commitInfo(ref) {
	try {
		const [sha, ts] = git(['show', '-s', '--format=%h|%ct', '--abbrev=9', ref]).split('|');
		return { sha, date: new Date(Number(ts) * 1000).toISOString().slice(0, 10) };
	} catch {
		console.error(`Not a commit in this repository: ${ref}`);
		process.exit(2);
	}
}

function list(store) {
	const rows = Object.entries(store.reviews).map(([docPath, r]) => ({
		docPath,
		...r,
		...commitInfo(r.commit),
	}));
	if (!rows.length) {
		console.log('No doc has been stamped yet. Stamp one with `npm run docs:review -- <doc>`.');
		return;
	}
	rows.sort((a, b) => b.date.localeCompare(a.date) || a.docPath.localeCompare(b.docPath));
	console.log(`${rows.length} stamped doc(s):\n`);
	for (const row of rows) {
		console.log(`  ${row.date}  ${row.kind.padEnd(9)} ${row.docPath}`);
		if (row.note) console.log(`              ${row.note}`);
	}
}

function prune(store) {
	const gone = Object.keys(store.reviews).filter((p) => !existsSync(path.join(ROOT, p)));
	if (!gone.length) {
		console.log('Every stamped doc still exists. Nothing to prune.');
		return;
	}
	for (const p of gone) delete store.reviews[p];
	saveStore(store);
	console.log(`Pruned ${gone.length} stamp(s) for deleted docs:\n  ${gone.join('\n  ')}`);
}

const store = loadStore();

if (has('list')) {
	list(store);
	process.exit(0);
}
if (has('prune')) {
	prune(store);
	process.exit(0);
}

// Everything that is not a flag or a flag's value is a doc to stamp.
const flagValues = new Set([opt('note'), opt('at'), opt('by')].filter(Boolean));
const docs = argv.filter((a) => !a.startsWith('--') && !flagValues.has(a));

if (!docs.length) {
	console.error(
		'Nothing to stamp. Usage: npm run docs:review -- <doc.md> [more docs] [--note "..."] ' +
			'[--at <commit>] [--snapshot]\n' +
			'       npm run docs:review -- --list | --prune',
	);
	process.exit(2);
}

const missing = docs.filter((d) => !existsSync(path.join(ROOT, d)));
if (missing.length) {
	console.error(`No such doc:\n  ${missing.join('\n  ')}`);
	process.exit(2);
}

const notMarkdown = docs.filter((d) => !d.endsWith('.md'));
if (notMarkdown.length) {
	console.error(`Only markdown docs can be stamped:\n  ${notMarkdown.join('\n  ')}`);
	process.exit(2);
}

const at = commitInfo(opt('at') || 'HEAD');
const kind = has('snapshot') ? 'snapshot' : 'verified';
const note = opt('note');
const by = opt('by') || 'agent';

// A doc with uncommitted edits is stamped against the commit the reviewer read,
// which is what `--at` is for, but the edit itself is not in that commit yet.
// Freshness takes the newer of the doc's last commit and its review, so the
// stamp cannot mask the pending edit. Saying so keeps the reviewer honest about
// which one they are recording.
const dirty = docs.filter((d) => {
	try {
		return git(['status', '--porcelain', '--', d]).length > 0;
	} catch {
		return false;
	}
});

for (const docPath of docs) {
	store.reviews[docPath] = {
		commit: at.sha,
		kind,
		by,
		...(note ? { note } : {}),
	};
}
saveStore(store);

console.log(
	`Stamped ${docs.length} doc(s) as ${kind} at ${at.sha} (${at.date}):\n  ${docs.join('\n  ')}`,
);
if (dirty.length) {
	console.log(
		`\n${dirty.length} of them have uncommitted edits. Commit those too: freshness reads the ` +
			`newer of the doc's last commit and this stamp, so an uncommitted fix still measures as ` +
			`pending work.`,
	);
}
console.log('\nRe-measure with `npm run docs:freshness`.');
