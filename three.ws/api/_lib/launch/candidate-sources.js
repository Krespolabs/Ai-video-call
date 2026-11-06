// @ts-check
// Candidate sources — adapters that turn three.ws's REAL trend providers into a
// uniform "launch candidate" the use-case engine can name and reward. Every
// source here is live: GitHub Search (github-trending.js) and the narrative
// engine (launcher-trends.js). No fixtures, no hardcoded subjects.
//
// A candidate is the raw subject of a potential launch:
//   { id, kind, subject, title, description, image, url, score, signal,
//     attribution?, themes?, raw }
// `id` is a stable idempotency key so the executor can dedupe against prior
// launches. `attribution` drives reward routing for attribution-mode use cases.

import { fetchTrendingRepos, fetchTrendingCreators } from '../github-trending.js';
import { rankNarratives } from '../launcher-trends.js';

function repoCandidate(r) {
	return {
		id: `gh:repo:${r.full_name}`,
		kind: 'github-repo',
		subject: r.full_name,
		title: r.name,
		description: r.description || `${r.name} — a trending project on GitHub.`,
		image: r.owner.avatar_url,
		url: r.html_url,
		score: r.stars,
		signal: { source: 'github', detail: `★${r.stars}${r.language ? ` · ${r.language}` : ''}`, owner_type: r.owner.type },
		attribution: { kind: 'owner', github_username: r.owner.login, github_user_id: r.owner.id != null ? String(r.owner.id) : undefined },
		raw: r,
	};
}

function creatorCandidate(c) {
	const top = c.top_repo;
	return {
		id: `gh:creator:${c.login}`,
		kind: 'github-creator',
		subject: `@${c.login}`,
		title: `@${c.login}`,
		description: top
			? `${c.login} is trending on GitHub for ${top.name}${top.description ? ` — ${top.description}` : ''}.`
			: `${c.login} is a trending GitHub creator.`,
		image: c.avatar_url,
		url: c.html_url,
		score: c.trending_stars,
		signal: { source: 'github', detail: `★${c.trending_stars} · ${c.repo_count} repo${c.repo_count === 1 ? '' : 's'}`, owner_type: c.type },
		attribution: { kind: 'creator', github_username: c.login, github_user_id: c.id != null ? String(c.id) : undefined },
		raw: c,
	};
}

function themeCandidate(t) {
	return {
		id: `theme:${t.term}`,
		kind: 'theme',
		subject: t.term,
		title: t.term,
		description: '',
		image: null,
		url: null,
		score: t.score,
		signal: { source: 'narratives', detail: (t.sources || []).join(' + '), kind: t.kind },
		themes: [t.term],
		raw: t,
	};
}

/**
 * Fetch candidates for a source kind. Reads provider-specific params off `params`.
 * Never throws — a dead provider yields []. Used by planLaunch().
 *
 * @param {string} kind
 * @param {object} params
 * @returns {Promise<Array<object>>}
 */
export async function sourceCandidates(kind, params = {}) {
	try {
		switch (kind) {
			case 'github-repos': {
				const repos = await fetchTrendingRepos({
					window: params.window || 'new',
					sinceDays: params.sinceDays ?? 30,
					minStars: params.minStars ?? 50,
					language: params.language,
					limit: params.limit ?? 12,
				});
				return repos.map(repoCandidate);
			}
			case 'github-creators': {
				const creators = await fetchTrendingCreators({
					window: params.window || 'new',
					sinceDays: params.sinceDays ?? 60,
					minStars: params.minStars ?? 50,
					language: params.language,
					creatorLimit: params.limit ?? 12,
				});
				return creators.map(creatorCandidate);
			}
			case 'narratives': {
				const res = await rankNarratives({
					network: params.network || 'mainnet',
					sources: params.sources,
					categories: params.categories || [],
					limit: params.limit ?? 12,
				});
				return (res.terms || []).map(themeCandidate);
			}
			default:
				return [];
		}
	} catch {
		return [];
	}
}

export { repoCandidate, creatorCandidate, themeCandidate };
