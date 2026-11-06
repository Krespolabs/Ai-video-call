#!/usr/bin/env node
// Aggregate everywhere three.ws shows up across the web into one deduped map.
//
// Pulls from a set of providers, normalizes every hit to {url,title,snippet,source,
// date}, dedupes by canonical URL, and writes:
//   • three-ws-presence.json  — structured results + per-provider run report
//   • three-ws-presence.md    — human-readable report you can paste into X
//
// Keyless providers always run (real data, no signup):
//   • GDELT      — global news index
//   • MCP Registry — your live Model Context Protocol server listings
//   • npm        — package metadata + download counts
//   • GitHub     — repo stats + repos that mention three.ws (anon, rate-limited)
//
// Keyed providers run only when their env var is present (otherwise skipped, logged):
//   • Serper     SERPER_API_KEY     (google.serper.dev)
//   • Exa        EXA_API_KEY        (api.exa.ai)
//   • Brave      BRAVE_API_KEY      (api.search.brave.com)
//   • Tavily     TAVILY_API_KEY     (api.tavily.com)
//   • SerpApi    SERPAPI_API_KEY    (serpapi.com)
//   • GitHub PAT GITHUB_TOKEN       (raises GitHub rate limits, enables code search)
//
// Usage:
//   node scripts/three-ws-presence.mjs
//   node scripts/three-ws-presence.mjs --query "three.ws" --query "trythreews"
//   node scripts/three-ws-presence.mjs --json out.json --md out.md
//
// Add keys to .env (same file the rest of the repo reads) to light up more sources.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// ── Defaults ────────────────────────────────────────────────────────────────
const SITE = 'three.ws';
const HANDLE = 'trythreews';
const CONTRACT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// The brand filter (keepBrand) cleans junk downstream, so queries can be broad enough
// to surface the site + press without an exact-token match (quoting "three.ws" is too
// strict for a .ws domain and hides the homepage). The handle stays quoted because
// unquoted Google reads "trythreews" as "try three ws" and floods music/gov results.
const DEFAULT_QUERIES = [
	SITE,
	`"${HANDLE}"`,
	`${SITE} 3D AI agent Solana`,
	`${SITE} $THREE token`,
	CONTRACT,
];
const NPM_PACKAGES = ['three.ws', '@three-ws/avatar-agent'];
const GITHUB_REPO = 'nirholas/three.ws';
const REQUEST_TIMEOUT_MS = 20_000;
const GDELT_THROTTLE_MS = 5_200; // GDELT allows one request per 5 seconds

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tiny arg parser ───────────────────────────────────────────────────────────
function parseArgs(argv) {
	const out = { queries: [], json: 'three-ws-presence.json', md: 'three-ws-presence.md' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--query' || a === '-q') out.queries.push(argv[++i]);
		else if (a === '--json') out.json = argv[++i];
		else if (a === '--md') out.md = argv[++i];
		else if (a === '--help' || a === '-h') out.help = true;
	}
	if (!out.queries.length) out.queries = DEFAULT_QUERIES;
	return out;
}

async function loadEnv() {
	try {
		const raw = await fs.readFile(ENV_PATH, 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch {
		/* no .env — env vars may still come from the shell */
	}
}

// ── HTTP helper with timeout; never throws past the caller's try ──────────────
async function getJson(url, opts = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			...opts,
			signal: ctrl.signal,
			headers: { 'user-agent': 'three-ws-presence/1.0', ...(opts.headers || {}) },
		});
		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
		if (body === null) throw new Error(`non-JSON response: ${text.slice(0, 120)}`);
		return body;
	} finally {
		clearTimeout(timer);
	}
}

// ── URL canonicalization for dedupe ───────────────────────────────────────────
function canonicalUrl(raw) {
	if (!raw) return '';
	try {
		const u = new URL(raw.trim());
		u.hash = '';
		for (const p of [...u.searchParams.keys()]) {
			if (/^utm_|^ref$|^ref_src$|^s$|^t$/i.test(p)) u.searchParams.delete(p);
		}
		let s = u.toString().replace(/\/$/, '');
		return s.replace(/^http:/, 'https:');
	} catch {
		return raw.trim();
	}
}

function hostOf(url) {
	try {
		return new URL(url).host.replace(/^www\./, '');
	} catch {
		return '';
	}
}

// Web-search engines fuzzy-match the brand into unrelated tokens (try, three, ws),
// so keep only SERP hits that actually name three.ws, the $three coin, the contract,
// or the product category. Deliberately does NOT match bare "three" (catches songs).
const BRAND = /three\.ws|trythreews|\$three\b|3d\s*ai\s*agent|3d\s*agent|FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump/i;
function keepBrand(h) {
	return BRAND.test(`${h.url} ${h.title} ${h.snippet}`);
}

function hit({ url, title, snippet, date, source }) {
	return {
		url: canonicalUrl(url),
		host: hostOf(url),
		title: (title || '').trim(),
		snippet: (snippet || '').trim().slice(0, 280),
		date: date || '',
		source,
	};
}

// ── Providers ─────────────────────────────────────────────────────────────────
// Each returns { name, ran, skippedReason?, hits: [], extra?: {} } and never throws.

async function providerGdelt(queries) {
	const hits = [];
	let rateLimited = false;
	for (let i = 0; i < queries.length; i++) {
		const q = queries[i];
		if (i > 0) await sleep(GDELT_THROTTLE_MS); // stay under the 1-req/5s ceiling
		const url =
			'https://api.gdeltproject.org/api/v2/doc/doc?' +
			new URLSearchParams({
				query: q,
				mode: 'ArtList',
				format: 'json',
				maxrecords: '75',
				sort: 'DateDesc',
			});
		// One retry on 429, since GDELT throttles by source IP (shared on CI/codespaces).
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const body = await getJson(url);
				for (const a of body.articles || [])
					hits.push(
						hit({ url: a.url, title: a.title, snippet: a.domain, date: a.seendate, source: 'gdelt' })
					);
				break;
			} catch (err) {
				if (err.message.includes('429')) {
					rateLimited = true;
					if (attempt === 0) {
						await sleep(GDELT_THROTTLE_MS);
						continue;
					}
				}
				if (process.env.DEBUG) console.error(`  gdelt "${q}": ${err.message}`);
				break;
			}
		}
	}
	const note = rateLimited && !hits.length ? 'rate-limited by GDELT (shared IP); retry from another host' : undefined;
	return { name: 'gdelt', ran: true, note, hits };
}

async function providerMcpRegistry() {
	const hits = [];
	const seen = new Set();
	for (const q of ['threews', 'three.ws', 'nirholas', 'avatar-agent']) {
		try {
			const url =
				'https://registry.modelcontextprotocol.io/v0/servers?' +
				new URLSearchParams({ search: q, limit: '50' });
			const body = await getJson(url);
			const servers = body.servers || body.data || [];
			for (const entry of servers) {
				const s = entry.server || entry;
				const name = s.name || s.id || '';
				if (!name || seen.has(name)) continue;
				seen.add(name);
				const repo = s.repository?.url || s.repository?.source || '';
				hits.push(
					hit({
						url: repo || `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(name)}`,
						title: name,
						snippet: s.description || '',
						date: s.version || s._meta?.['io.modelcontextprotocol.registry/official']?.publishedAt || '',
						source: 'mcp-registry',
					})
				);
			}
		} catch (err) {
			if (process.env.DEBUG) console.error(`  mcp "${q}": ${err.message}`);
		}
	}
	return { name: 'mcp-registry', ran: true, hits };
}

async function providerNpm() {
	const hits = [];
	const extra = {};
	for (const pkg of NPM_PACKAGES) {
		const enc = encodeURIComponent(pkg).replace('%40', '@');
		try {
			const meta = await getJson(`https://registry.npmjs.org/${enc}`);
			const latest = meta['dist-tags']?.latest;
			let downloads = null;
			try {
				const dl = await getJson(
					`https://api.npmjs.org/downloads/point/last-month/${enc}`
				);
				downloads = dl.downloads ?? null;
			} catch {
				/* downloads endpoint 404s for brand-new packages */
			}
			extra[pkg] = { latest, downloads, modified: meta.time?.modified };
			hits.push(
				hit({
					url: `https://www.npmjs.com/package/${pkg}`,
					title: `${pkg}@${latest || '?'}`,
					snippet: `${meta.description || ''}${
						downloads != null ? ` — ${downloads} downloads/mo` : ''
					}`,
					date: meta.time?.modified,
					source: 'npm',
				})
			);
		} catch (err) {
			if (process.env.DEBUG) console.error(`  npm "${pkg}": ${err.message}`);
		}
	}
	return { name: 'npm', ran: true, hits, extra };
}

async function providerGithub(queries) {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	const headers = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
	};
	if (token) headers.authorization = `Bearer ${token}`;
	const hits = [];
	const extra = {};

	try {
		const repo = await getJson(`https://api.github.com/repos/${GITHUB_REPO}`, { headers });
		extra.repo = {
			stars: repo.stargazers_count,
			forks: repo.forks_count,
			watchers: repo.subscribers_count,
			openIssues: repo.open_issues_count,
		};
		hits.push(
			hit({
				url: repo.html_url,
				title: `${repo.full_name} (${repo.stargazers_count}★)`,
				snippet: repo.description || '',
				date: repo.pushed_at,
				source: 'github',
			})
		);
	} catch (err) {
		if (process.env.DEBUG) console.error(`  github repo: ${err.message}`);
	}

	// Repo search on the bare domain is noisy (GitHub loosely tokenizes "three.ws"),
	// so keep only repos that are actually ours or that name the project.
	const RELEVANT = /three\.ws|trythreews|three-ws|3d ai agent/i;
	try {
		const search = await getJson(
			`https://api.github.com/search/repositories?` +
				new URLSearchParams({ q: `"three.ws"`, sort: 'stars', per_page: '30' }),
			{ headers }
		);
		for (const r of search.items || []) {
			if (r.full_name === GITHUB_REPO) continue;
			const relevant = r.owner?.login === 'nirholas' || RELEVANT.test(`${r.full_name} ${r.description || ''}`);
			if (!relevant) continue;
			hits.push(
				hit({
					url: r.html_url,
					title: `${r.full_name} (${r.stargazers_count}★)`,
					snippet: r.description || '',
					date: r.pushed_at,
					source: 'github',
				})
			);
		}
	} catch (err) {
		if (process.env.DEBUG) console.error(`  github repo search: ${err.message}`);
	}

	// Code search finds repos that integrate three.ws. Requires auth. The bare string
	// "three.ws" tokenizes into common words and floods results, so search only the
	// unambiguous identifiers real integrations actually contain.
	if (token) {
		const codeTerms = ['"@three-ws/avatar-agent"', '"three.ws/api/mcp"', 'trythreews'];
		const seenRepo = new Set();
		for (const term of codeTerms) {
			try {
				const code = await getJson(
					`https://api.github.com/search/code?` +
						new URLSearchParams({ q: term, per_page: '30' }),
					{ headers }
				);
				for (const item of code.items || []) {
					const full = item.repository?.full_name;
					if (!full || full === GITHUB_REPO || seenRepo.has(full)) continue;
					seenRepo.add(full);
					hits.push(
						hit({
							url: item.repository.html_url,
							title: `${full} (integrates three.ws)`,
							snippet: item.repository.description || '',
							source: 'github',
						})
					);
				}
			} catch (err) {
				if (process.env.DEBUG) console.error(`  github code search ${term}: ${err.message}`);
			}
			await sleep(2_000); // GitHub code search is rate-limited to ~10 req/min
		}
	}

	return {
		name: 'github',
		ran: true,
		note: token
			? 'authenticated, code search on'
			: 'anonymous (60 req/hr, no code search) — set GITHUB_TOKEN to raise limits',
		hits,
		extra,
	};
}

async function providerSerper(queries) {
	const key = process.env.SERPER_API_KEY;
	if (!key) return { name: 'serper', ran: false, skippedReason: 'SERPER_API_KEY not set', hits: [] };
	const hits = [];
	for (const q of queries) {
		try {
			const body = await getJson('https://google.serper.dev/search', {
				method: 'POST',
				headers: { 'x-api-key': key, 'content-type': 'application/json' },
				body: JSON.stringify({ q, num: 30 }),
			});
			for (const r of body.organic || [])
				hits.push(hit({ url: r.link, title: r.title, snippet: r.snippet, date: r.date, source: 'serper' }));
			for (const r of body.news || [])
				hits.push(hit({ url: r.link, title: r.title, snippet: r.snippet, date: r.date, source: 'serper' }));
		} catch (err) {
			if (process.env.DEBUG) console.error(`  serper "${q}": ${err.message}`);
		}
	}
	return { name: 'serper', ran: true, hits: hits.filter(keepBrand) };
}

async function providerExa(queries) {
	const key = process.env.EXA_API_KEY;
	if (!key) return { name: 'exa', ran: false, skippedReason: 'EXA_API_KEY not set', hits: [] };
	const hits = [];
	for (const q of queries) {
		try {
			const body = await getJson('https://api.exa.ai/search', {
				method: 'POST',
				headers: { 'x-api-key': key, 'content-type': 'application/json' },
				body: JSON.stringify({ query: q, numResults: 25, type: 'auto' }),
			});
			for (const r of body.results || [])
				hits.push(
					hit({ url: r.url, title: r.title, snippet: r.text || r.summary, date: r.publishedDate, source: 'exa' })
				);
		} catch (err) {
			if (process.env.DEBUG) console.error(`  exa "${q}": ${err.message}`);
		}
	}
	return { name: 'exa', ran: true, hits: hits.filter(keepBrand) };
}

async function providerBrave(queries) {
	const key = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
	if (!key) return { name: 'brave', ran: false, skippedReason: 'BRAVE_API_KEY not set', hits: [] };
	const hits = [];
	for (const q of queries) {
		try {
			const url =
				'https://api.search.brave.com/res/v1/web/search?' +
				new URLSearchParams({ q, count: '20' });
			const body = await getJson(url, {
				headers: { 'x-subscription-token': key, accept: 'application/json' },
			});
			for (const r of body.web?.results || [])
				hits.push(hit({ url: r.url, title: r.title, snippet: r.description, date: r.age, source: 'brave' }));
		} catch (err) {
			if (process.env.DEBUG) console.error(`  brave "${q}": ${err.message}`);
		}
	}
	return { name: 'brave', ran: true, hits: hits.filter(keepBrand) };
}

async function providerTavily(queries) {
	const key = process.env.TAVILY_API_KEY;
	if (!key) return { name: 'tavily', ran: false, skippedReason: 'TAVILY_API_KEY not set', hits: [] };
	const hits = [];
	for (const q of queries) {
		try {
			const body = await getJson('https://api.tavily.com/search', {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ query: q, max_results: 20, search_depth: 'advanced' }),
			});
			for (const r of body.results || [])
				hits.push(hit({ url: r.url, title: r.title, snippet: r.content, date: r.published_date, source: 'tavily' }));
		} catch (err) {
			if (process.env.DEBUG) console.error(`  tavily "${q}": ${err.message}`);
		}
	}
	return { name: 'tavily', ran: true, hits: hits.filter(keepBrand) };
}

async function providerSerpApi(queries) {
	const key = process.env.SERPAPI_API_KEY;
	if (!key) return { name: 'serpapi', ran: false, skippedReason: 'SERPAPI_API_KEY not set', hits: [] };
	const hits = [];
	for (const q of queries) {
		try {
			const url =
				'https://serpapi.com/search.json?' +
				new URLSearchParams({ engine: 'google', q, num: '20', api_key: key });
			const body = await getJson(url);
			for (const r of body.organic_results || [])
				hits.push(hit({ url: r.link, title: r.title, snippet: r.snippet, date: r.date, source: 'serpapi' }));
		} catch (err) {
			if (process.env.DEBUG) console.error(`  serpapi "${q}": ${err.message}`);
		}
	}
	return { name: 'serpapi', ran: true, hits: hits.filter(keepBrand) };
}

// ── Dedupe + grouping ─────────────────────────────────────────────────────────
function dedupe(allHits) {
	const byUrl = new Map();
	for (const h of allHits) {
		if (!h.url) continue;
		const existing = byUrl.get(h.url);
		if (!existing) {
			byUrl.set(h.url, { ...h, sources: [h.source] });
		} else {
			if (!existing.sources.includes(h.source)) existing.sources.push(h.source);
			if (!existing.title && h.title) existing.title = h.title;
			if (!existing.snippet && h.snippet) existing.snippet = h.snippet;
			if (!existing.date && h.date) existing.date = h.date;
		}
	}
	return [...byUrl.values()].sort((a, b) => a.host.localeCompare(b.host));
}

function buildMarkdown({ generatedAt, queries, report, results, extras }) {
	const byHost = new Map();
	for (const r of results) {
		if (!byHost.has(r.host)) byHost.set(r.host, []);
		byHost.get(r.host).push(r);
	}
	const hosts = [...byHost.keys()].sort();

	const lines = [];
	lines.push(`# three.ws web presence`);
	lines.push('');
	lines.push(`Generated ${generatedAt}`);
	lines.push(`Queries: ${queries.map((q) => `\`${q}\``).join(', ')}`);
	lines.push(`Unique URLs: ${results.length} across ${hosts.length} domains`);
	lines.push('');

	lines.push(`## Providers`);
	for (const p of report) {
		const status = p.ran ? `ran, ${p.hits} hits${p.note ? ` (${p.note})` : ''}` : `skipped: ${p.skippedReason}`;
		lines.push(`- ${p.name}: ${status}`);
	}
	lines.push('');

	if (extras.npm) {
		lines.push(`## npm`);
		for (const [pkg, v] of Object.entries(extras.npm)) {
			lines.push(`- ${pkg}: v${v.latest || '?'}${v.downloads != null ? `, ${v.downloads} downloads/mo` : ''}`);
		}
		lines.push('');
	}
	if (extras.github?.repo) {
		const r = extras.github.repo;
		lines.push(`## GitHub repo`);
		lines.push(`- ${GITHUB_REPO}: ${r.stars}★, ${r.forks} forks, ${r.watchers} watchers, ${r.openIssues} open issues`);
		lines.push('');
	}

	lines.push(`## Every URL, grouped by domain`);
	for (const host of hosts) {
		lines.push('');
		lines.push(`### ${host}`);
		for (const r of byHost.get(host)) {
			const title = r.title || r.url;
			lines.push(`- [${title}](${r.url})${r.snippet ? ` — ${r.snippet}` : ''} _(${r.sources.join(', ')})_`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log('Usage: node scripts/three-ws-presence.mjs [--query Q]... [--json file] [--md file]');
		return;
	}
	await loadEnv();

	const generatedAt = new Date().toISOString();
	console.log(`three.ws presence sweep — ${generatedAt}`);
	console.log(`Queries: ${args.queries.join(' | ')}\n`);

	const providers = await Promise.all([
		providerGdelt(args.queries),
		providerMcpRegistry(),
		providerNpm(),
		providerGithub(args.queries),
		providerSerper(args.queries),
		providerExa(args.queries),
		providerBrave(args.queries),
		providerTavily(args.queries),
		providerSerpApi(args.queries),
	]);

	const allHits = [];
	const report = [];
	const extras = {};
	for (const p of providers) {
		allHits.push(...p.hits);
		report.push({
			name: p.name,
			ran: p.ran,
			hits: p.hits.length,
			note: p.note,
			skippedReason: p.skippedReason,
		});
		if (p.name === 'npm' && p.extra) extras.npm = p.extra;
		if (p.name === 'github' && p.extra) extras.github = p.extra;
		const label = p.ran
			? `${String(p.hits.length).padStart(3)} hits`
			: `skipped (${p.skippedReason})`;
		console.log(`  ${p.name.padEnd(14)} ${label}`);
	}

	const results = dedupe(allHits);
	console.log(`\nDeduped to ${results.length} unique URLs.`);

	const jsonOut = {
		generatedAt,
		queries: args.queries,
		site: SITE,
		handle: HANDLE,
		contract: CONTRACT,
		providers: report,
		extras,
		results,
	};

	const jsonPath = path.isAbsolute(args.json) ? args.json : path.join(ROOT, args.json);
	const mdPath = path.isAbsolute(args.md) ? args.md : path.join(ROOT, args.md);
	await fs.writeFile(jsonPath, JSON.stringify(jsonOut, null, 2));
	await fs.writeFile(mdPath, buildMarkdown({ generatedAt, queries: args.queries, report, results, extras }));

	console.log(`\nWrote ${path.relative(ROOT, jsonPath)} and ${path.relative(ROOT, mdPath)}`);

	const skipped = report.filter((p) => !p.ran);
	if (skipped.length) {
		console.log(
			`\nDormant providers (add the key to .env to enable): ${skipped
				.map((p) => p.name)
				.join(', ')}`
		);
	}
}

main().catch((err) => {
	console.error('presence sweep failed:', err);
	process.exit(1);
});
