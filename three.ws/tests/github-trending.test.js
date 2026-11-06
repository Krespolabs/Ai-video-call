import { describe, it, expect } from 'vitest';
import {
	ghDate,
	buildSearchQuery,
	normalizeRepo,
	rankTrendingCreators,
} from '../api/_lib/github-trending.js';

describe('ghDate', () => {
	it('formats a UTC date as YYYY-MM-DD', () => {
		expect(ghDate(new Date('2026-01-05T23:00:00Z'))).toBe('2026-01-05');
		expect(ghDate(new Date('2026-12-31T00:00:00Z'))).toBe('2026-12-31');
	});
});

describe('buildSearchQuery', () => {
	it('uses created:>= for the "new" window', () => {
		const q = buildSearchQuery({ since: '2026-06-01', window: 'new', minStars: 50 });
		expect(q).toContain('created:>=2026-06-01');
		expect(q).toContain('stars:>=50');
		expect(q).toContain('is:public');
	});
	it('uses pushed:>= for the "active" window', () => {
		const q = buildSearchQuery({ since: '2026-06-01', window: 'active', minStars: 100 });
		expect(q).toContain('pushed:>=2026-06-01');
		expect(q).toContain('stars:>=100');
	});
	it('adds a language qualifier when given', () => {
		expect(buildSearchQuery({ since: '2026-06-01', language: 'TypeScript' })).toContain('language:TypeScript');
	});
	it('quotes a multi-word language', () => {
		expect(buildSearchQuery({ since: '2026-06-01', language: 'Jupyter Notebook' })).toContain('language:"Jupyter Notebook"');
	});
	it('floors and clamps minStars to a non-negative integer', () => {
		expect(buildSearchQuery({ since: '2026-06-01', minStars: -5 })).toContain('stars:>=0');
		expect(buildSearchQuery({ since: '2026-06-01', minStars: 12.9 })).toContain('stars:>=12');
	});
});

describe('normalizeRepo', () => {
	const item = {
		id: 42, full_name: 'acme/widget', name: 'widget', description: '  a thing  ',
		html_url: 'https://github.com/acme/widget', homepage: 'https://acme.dev',
		stargazers_count: 1234, forks_count: 56, language: 'Rust', topics: ['cli', 'tool'],
		created_at: '2026-06-10T00:00:00Z', pushed_at: '2026-06-20T00:00:00Z',
		owner: { login: 'acme', id: 7, avatar_url: 'https://x/y.png', html_url: 'https://github.com/acme', type: 'Organization' },
	};
	it('maps the fields a launch needs and trims the description', () => {
		const r = normalizeRepo(item);
		expect(r.full_name).toBe('acme/widget');
		expect(r.stars).toBe(1234);
		expect(r.description).toBe('a thing');
		expect(r.owner.login).toBe('acme');
		expect(r.owner.type).toBe('Organization');
	});
	it('falls back to a derived avatar when missing', () => {
		const r = normalizeRepo({ ...item, owner: { login: 'foo', id: 1 } });
		expect(r.owner.avatar_url).toBe('https://github.com/foo.png');
		expect(r.owner.html_url).toBe('https://github.com/foo');
	});
	it('returns null for items missing owner or name', () => {
		expect(normalizeRepo(null)).toBeNull();
		expect(normalizeRepo({ name: 'x' })).toBeNull();
		expect(normalizeRepo({ owner: { login: 'a' } })).toBeNull();
	});
});

describe('rankTrendingCreators', () => {
	const repo = (login, name, stars) => normalizeRepo({
		id: `${login}/${name}`, full_name: `${login}/${name}`, name, stargazers_count: stars,
		owner: { login, id: login },
	});
	it('aggregates stars per owner and ranks by summed trending stars', () => {
		const repos = [repo('alice', 'a', 100), repo('bob', 'b', 500), repo('alice', 'a2', 300)];
		const ranked = rankTrendingCreators(repos);
		// alice = 100 + 300 = 400; bob = 500 → bob ranks first.
		expect(ranked.map((c) => c.login)).toEqual(['bob', 'alice']);
		const alice = ranked.find((c) => c.login === 'alice');
		expect(alice.trending_stars).toBe(400);
		expect(alice.repo_count).toBe(2);
		expect(alice.top_repo.name).toBe('a2'); // 300 > 100
	});
	it('is case-insensitive on the owner login', () => {
		const ranked = rankTrendingCreators([repo('Alice', 'a', 10), repo('alice', 'b', 20)]);
		expect(ranked).toHaveLength(1);
		expect(ranked[0].trending_stars).toBe(30);
	});
	it('honours the limit', () => {
		const repos = Array.from({ length: 5 }, (_, i) => repo(`u${i}`, 'r', i * 10));
		expect(rankTrendingCreators(repos, { limit: 2 })).toHaveLength(2);
	});
});
