// @ts-check
// GitHub trending — the data layer for "reward coins for trending GitHub
// creators". Where launcher-trends.js mines abstract cultural THEMES (and the
// LLM invents an original coin), this module surfaces CONCRETE, attributable
// subjects: the specific repos breaking out right now and the people behind
// them. A coin minted from this is *for* a real project, and its creator fees
// route to that project's GitHub owner via the fee-sharing system.
//
// Source: the GitHub REST Search API (api.github.com/search/repositories), which
// is the canonical "most-starred repos in a window" query — no scraping, no
// unofficial endpoint. Key-OPTIONAL: a GITHUB_TOKEN raises the rate limit from
// 10 to 30 req/min and is used when present, but the module works unauthenticated.
// Every fetch is time-bounded, cached, and degrades to [] — it never throws and
// never blocks a launcher tick.
//
// Two views over the same fetch:
//   fetchTrendingRepos()    — ranked individual repos (the "new trending repos" feed)
//   rankTrendingCreators()  — repos aggregated by owner (the "trending creators" feed)
//
// No specific repo, owner, or mint is ever hardcoded: the inputs are a live query
// and the outputs are runtime data. This is coin-agnostic plumbing — the subject
// of any launch is supplied by live GitHub data at runtime, not baked in.

import { cacheGet, cacheSet } from './cache.js';

const FETCH_TIMEOUT_MS = 7_000;
const CACHE_TTL_S = 600; // trending shifts slowly; 10 min is plenty and saves rate limit
const MAX_LIMIT = 50;

// ── pure helpers (tested, network-free) ──────────────────────────────────────

/**
 * Format a Date as the `YYYY-MM-DD` GitHub search qualifier expects.
 * @param {Date} d
 */
export function ghDate(d) {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Build a GitHub repository-search query string for trending repos.
 *
 * @param {{ since?: string, window?: 'new'|'active', minStars?: number, language?: string }} [opts]
 *  - window 'new'    → repos CREATED since the date (fresh projects breaking out).
 *  - window 'active' → repos PUSHED since the date (established projects with a fresh surge).
 *  - since           → `YYYY-MM-DD` lower bound; caller supplies (keeps this pure).
 * @returns {string} the `q=` value (un-encoded)
 */
export function buildSearchQuery({ since, window = 'new', minStars = 10, language } = {}) {
	const parts = [];
	const dateField = window === 'active' ? 'pushed' : 'created';
	if (since) parts.push(`${dateField}:>=${since}`);
	parts.push(`stars:>=${Math.max(0, Math.floor(minStars))}`);
	if (language) {
		const lang = String(language).trim();
		parts.push(`language:${/\s/.test(lang) ? `"${lang}"` : lang}`);
	}
	// Exclude obvious non-project noise that pollutes star-sorted results.
	parts.push('is:public');
	return parts.join(' ');
}

/**
 * Normalise a GitHub search-API repo item into the shape the launcher consumes.
 * Returns null for items missing the fields a launch needs (owner, name).
 * @param {any} item
 */
export function normalizeRepo(item) {
	if (!item || !item.owner?.login || !item.name) return null;
	return {
		repo_id: item.id,
		full_name: item.full_name,
		name: item.name,
		description: typeof item.description === 'string' ? item.description.trim() : '',
		html_url: item.html_url,
		homepage: item.homepage || null,
		stars: Number(item.stargazers_count || 0),
		forks: Number(item.forks_count || 0),
		language: item.language || null,
		topics: Array.isArray(item.topics) ? item.topics.slice(0, 8) : [],
		created_at: item.created_at || null,
		pushed_at: item.pushed_at || null,
		owner: {
			login: item.owner.login,
			id: item.owner.id,
			avatar_url: item.owner.avatar_url || `https://github.com/${item.owner.login}.png`,
			html_url: item.owner.html_url || `https://github.com/${item.owner.login}`,
			type: item.owner.type || 'User', // 'User' | 'Organization'
		},
	};
}

/**
 * Aggregate normalized repos by owner into ranked "trending creators". Each
 * creator carries their summed trending stars and the repos that put them on the
 * list — so a launch attributed to a creator can name their strongest project.
 * @param {ReturnType<typeof normalizeRepo>[]} repos
 * @param {{ limit?: number }} [opts]
 */
export function rankTrendingCreators(repos, { limit = MAX_LIMIT } = {}) {
	/** @type {Map<string, any>} */
	const byOwner = new Map();
	for (const r of repos) {
		if (!r) continue;
		const key = r.owner.login.toLowerCase();
		const cur = byOwner.get(key);
		if (cur) {
			cur.trending_stars += r.stars;
			cur.repos.push(r);
		} else {
			byOwner.set(key, { ...r.owner, trending_stars: r.stars, repos: [r] });
		}
	}
	return [...byOwner.values()]
		.map((c) => ({
			...c,
			repo_count: c.repos.length,
			// Top repo = the creator's most-starred trending project (the natural
			// subject of an attribution launch).
			top_repo: c.repos.slice().sort((a, b) => b.stars - a.stars)[0] || null,
		}))
		.sort((a, b) => b.trending_stars - a.trending_stars)
		.slice(0, limit);
}

// ── live fetch (key-optional, time-bounded, never throws) ─────────────────────

function ghHeaders() {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
	return {
		accept: 'application/vnd.github+json',
		'user-agent': 'three.ws-launcher/1.0 (+https://three.ws)',
		'x-github-api-version': '2022-11-28',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

/**
 * Fetch trending repos from the GitHub Search API. Cached, key-optional, bounded.
 * Returns [] on any failure (rate limit, timeout, outage) — never throws.
 *
 * @param {{ window?: 'new'|'active', sinceDays?: number, minStars?: number, language?: string, limit?: number, fresh?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof normalizeRepo>[]>}
 */
export async function fetchTrendingRepos({
	window = 'new',
	sinceDays = 30,
	minStars = 50,
	language,
	limit = 25,
	fresh = false,
} = {}) {
	const lim = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
	const since = ghDate(new Date(Date.now() - Math.max(1, sinceDays) * 86_400_000));
	const q = buildSearchQuery({ since, window, minStars, language });
	const cacheKey = `gh:trending:${window}:${since}:${minStars}:${language || 'any'}:${lim}`;

	if (!fresh) {
		try {
			const hit = await cacheGet(cacheKey);
			if (hit) return hit;
		} catch { /* compute live */ }
	}

	const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${lim}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	let repos = [];
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: ghHeaders() });
		if (res.ok) {
			const data = await res.json();
			const items = Array.isArray(data?.items) ? data.items : [];
			repos = items.map(normalizeRepo).filter(Boolean);
		}
	} catch {
		/* timeout / network — degrade to [] */
	} finally {
		clearTimeout(timer);
	}

	if (repos.length) {
		try { await cacheSet(cacheKey, repos, CACHE_TTL_S); } catch { /* ignore */ }
	}
	return repos;
}

/**
 * Convenience: fetch trending repos and roll them up into ranked creators.
 * @param {Parameters<typeof fetchTrendingRepos>[0] & { creatorLimit?: number }} [opts]
 */
export async function fetchTrendingCreators({ creatorLimit = 25, ...opts } = {}) {
	// Pull a wider repo set than the creator limit so aggregation has material.
	const repos = await fetchTrendingRepos({ ...opts, limit: Math.min(MAX_LIMIT, Math.max(opts.limit || 0, creatorLimit * 2)) });
	return rankTrendingCreators(repos, { limit: creatorLimit });
}

export { MAX_LIMIT };
