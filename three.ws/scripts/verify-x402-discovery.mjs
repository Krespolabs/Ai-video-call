#!/usr/bin/env node
// scripts/verify-x402-discovery.mjs
//
// Verifies that our published x402 discovery document is actually indexable —
// i.e. that crawlers (Coinbase CDP Bazaar / agentic.market, x402scan, 402index)
// will accept each resource rather than silently drop it. It mirrors the checks
// those indexers run:
//
//   1. CDP strict validation — each resource's bazaar `info` MUST validate
//      against its own declared `schema` (JSON Schema draft 2020-12). A mismatch
//      is what makes CDP return `EXTENSION-RESPONSES: rejected` and skip the
//      resource. This is the single most common silent-delisting cause.
//   2. Required 402 fields — resource.url + description; every accept needs
//      scheme/network/amount/asset/payTo.
//   3. Network coverage — x402scan indexes Base + Solana only; warn on resources
//      that advertise neither (they won't appear there).
//   4. Listing-quality fields — serviceName (≤32 ASCII), tags (≤5, ≤32 ASCII
//      each), absolute https iconUrl, a non-trivial description (bare names rank
//      poorly), and an output example (agentic.market uses it for result cards).
//
// Usage:
//   node scripts/verify-x402-discovery.mjs                 # checks https://three.ws
//   node scripts/verify-x402-discovery.mjs --base=http://localhost:3000
//   node scripts/verify-x402-discovery.mjs --json          # machine-readable report

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith('--base='))?.slice('--base='.length) || 'https://three.ws').replace(/\/$/, '');
// --file=<path> validates a locally-built catalog JSON instead of fetching a
// live URL, so CI can gate a catalog change BEFORE it deploys (the build:pages /
// pre-push guard) rather than discovering a regression only after we're delisted.
const filePath = args.find((a) => a.startsWith('--file='))?.slice('--file='.length) || null;
const asJson = args.includes('--json');

const NETWORK_BASE = 'eip155:8453';
const SOLANA_PREFIX = 'solana:';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function isAbsoluteHttps(u) {
	try {
		return new URL(u).protocol === 'https:';
	} catch {
		return false;
	}
}
function isPrintableAscii(s, max) {
	return typeof s === 'string' && s.length > 0 && s.length <= max && /^[\x20-\x7e]+$/.test(s);
}

// CDP indexes on a per-(resource,tool) basis; MCP rows carry a toolName.
function label(r) {
	return r.toolName ? `${r.path || r.url} :: ${r.toolName}` : r.path || r.url;
}

function checkResource(r) {
	const errors = [];
	const warnings = [];

	// (2) required 402 fields
	if (!r.url) errors.push('missing resource.url');
	if (!r.description || String(r.description).trim().length < 12)
		warnings.push('description missing or very short (<12 chars) — ranks poorly');
	const accepts = Array.isArray(r.accepts) ? r.accepts : [];
	if (!accepts.length) errors.push('no accepts[] — not payable, will not be cataloged');
	accepts.forEach((a, i) => {
		for (const f of ['scheme', 'network', 'amount', 'asset', 'payTo']) {
			if (a[f] == null || a[f] === '') errors.push(`accepts[${i}] missing ${f}`);
		}
		if (typeof a.payTo === 'string' && /\s/.test(a.payTo))
			errors.push(`accepts[${i}].payTo contains whitespace ("${a.payTo}") — clients fail to parse`);
	});

	// (3) network coverage (x402scan = Base + Solana only)
	const nets = accepts.map((a) => a.network || '');
	const hasBase = nets.includes(NETWORK_BASE);
	const hasSolana = nets.some((n) => n.startsWith(SOLANA_PREFIX));
	if (!hasBase && !hasSolana)
		warnings.push('advertises neither Base nor Solana — invisible to x402scan');

	// (4) listing-quality fields
	if (r.serviceName != null && !isPrintableAscii(r.serviceName, 32))
		warnings.push('serviceName not printable-ASCII ≤32 chars');
	if (r.tags != null) {
		if (!Array.isArray(r.tags) || r.tags.length > 5) warnings.push('tags must be an array of ≤5');
		else if (!r.tags.every((t) => isPrintableAscii(t, 32)))
			warnings.push('a tag is not printable-ASCII ≤32 chars');
	}
	if (r.iconUrl != null && !isAbsoluteHttps(r.iconUrl))
		warnings.push('iconUrl is not an absolute https URL');

	// (1) CDP strict validation — bazaar.info vs bazaar.schema
	const bazaar = r.extensions?.bazaar || r.bazaar;
	if (!bazaar) {
		errors.push('no bazaar extension — CDP/agentic.market will not catalog');
	} else {
		if (bazaar.discoverable !== true) warnings.push('bazaar.discoverable is not true');
		if (!bazaar.info) errors.push('bazaar.info missing');
		if (!bazaar.schema) {
			warnings.push('bazaar.schema missing — cannot self-validate (CDP may reject)');
		} else if (bazaar.info) {
			let validate;
			try {
				validate = ajv.compile(bazaar.schema);
			} catch (e) {
				errors.push(`bazaar.schema does not compile: ${e.message}`);
			}
			if (validate && !validate(bazaar.info)) {
				const detail = (validate.errors || [])
					.map((e) => `${e.instancePath || '/'} ${e.message}`)
					.join('; ');
				errors.push(`bazaar.info FAILS its own schema → CDP rejects: ${detail}`);
			}
		}
		if (!bazaar.info?.output?.example)
			warnings.push('no output.example — agentic.market result cards/ranking degraded');
	}

	return { label: label(r), url: r.url, errors, warnings };
}

async function loadCatalog() {
	if (filePath) {
		const { readFile } = await import('node:fs/promises');
		try {
			return { source: filePath, doc: JSON.parse(await readFile(filePath, 'utf8')) };
		} catch (err) {
			console.error(`failed to read ${filePath}: ${err.message}`);
			process.exit(2);
		}
	}
	const url = `${base}/.well-known/x402.json`;
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`failed to fetch ${url}: HTTP ${res.status}`);
		process.exit(2);
	}
	return { source: url, doc: await res.json() };
}

async function main() {
	const { source: url, doc } = await loadCatalog();
	const resources = doc.resources || doc.items || [];
	const report = resources.map(checkResource);

	const failing = report.filter((r) => r.errors.length);
	const warningOnly = report.filter((r) => !r.errors.length && r.warnings.length);
	const clean = report.filter((r) => !r.errors.length && !r.warnings.length);

	if (asJson) {
		console.log(JSON.stringify({ base, total: report.length, failing, warningOnly, report }, null, 2));
		process.exit(failing.length ? 1 : 0);
	}

	console.log(`x402 discovery check — ${url}`);
	console.log(`service: ${doc.service?.name || '?'}   resources: ${report.length}\n`);

	for (const r of failing) {
		console.log(`✗ ${r.label}`);
		for (const e of r.errors) console.log(`    ERROR  ${e}`);
		for (const w of r.warnings) console.log(`    warn   ${w}`);
	}
	for (const r of warningOnly) {
		console.log(`▲ ${r.label}`);
		for (const w of r.warnings) console.log(`    warn   ${w}`);
	}

	console.log(`\n--- summary ---`);
	console.log(`  ✓ clean:        ${clean.length}`);
	console.log(`  ▲ warnings:     ${warningOnly.length}`);
	console.log(`  ✗ will be DROPPED by CDP/indexers: ${failing.length}`);

	// Aggregate the most common issues so the fix is obvious.
	const tally = {};
	for (const r of report) for (const e of r.errors) {
		const key = e.replace(/\(.*?\)/g, '(…)').replace(/→.*/, '→ …').slice(0, 60);
		tally[key] = (tally[key] || 0) + 1;
	}
	const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8);
	if (top.length) {
		console.log(`\n  top errors:`);
		for (const [k, n] of top) console.log(`    ${String(n).padStart(3)}×  ${k}`);
	}

	process.exit(failing.length ? 1 : 0);
}

main().catch((err) => {
	console.error('fatal:', err.message);
	process.exit(2);
});
