// The chart-source switchers on /coin/:id, /launches/<mint>, /trades and
// Mission Control all build their third-party embeds from one provider list. Two
// things in it are easy to break without any page visibly failing until a user
// picks the tab:
//   - DEXTools only allows framing on its /widget-chart/ route. Its /app/ pages
//     answer X-Frame-Options: SAMEORIGIN, so an embed URL that drifts to /app/ is
//     a permanently blank frame.
//   - Pool-keyed providers resolve their pool differently. GeckoTerminal must
//     confirm it indexed the pool (its embed is a 404 page otherwise); DEXTools
//     must NOT inherit that gate, or it goes dark for every young coin
//     GeckoTerminal has not listed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	CHART_CHAINS,
	CHART_EMBEDS,
	chartEmbedsFor,
	chartEmbedUrls,
	resolveChartPool,
} from '../src/shared/chart-embeds.js';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const POOL = 'THREEsyntheticPool11111111111111111111111111';

function mockFetch(routes) {
	const calls = [];
	vi.stubGlobal('fetch', async (url) => {
		calls.push(String(url));
		const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
		if (!hit) throw new Error(`unexpected fetch ${url}`);
		const { status = 200, body = {} } = hit[1];
		return { status, ok: status >= 200 && status < 300, json: async () => body };
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('chart embed providers', () => {
	it('offers DEXTools on every chain the platform charts, Solana included', () => {
		for (const chain of Object.keys(CHART_CHAINS)) {
			expect(chartEmbedsFor(chain).map((p) => p.id)).toContain('dextools');
		}
	});

	it('every pool-keyed provider carries its own pool resolver', () => {
		for (const p of CHART_EMBEDS.filter((x) => x.needs === 'pool')) {
			expect(typeof p.resolvePool).toBe('function');
		}
	});

	it('embeds DEXTools through the frameable widget route, never an /app/ page', () => {
		const urls = chartEmbedUrls('dextools', { chain: 'solana', token: THREE, pool: POOL, theme: 'light' });
		const embed = new URL(urls.embed);
		expect(embed.origin).toBe('https://www.dextools.io');
		expect(embed.pathname).toBe(`/widget-chart/en/solana/pe-light/${POOL}`);
		expect(embed.searchParams.get('theme')).toBe('light');
		expect(urls.embed).not.toContain('/app/');
		expect(urls.page).toBe(`https://www.dextools.io/app/solana/pair-explorer/${POOL}`);
	});

	it("uses DEXTools' own chain slugs, which differ from every other provider's", () => {
		const evm = '0x' + 'a'.repeat(40);
		const slugOf = (chain) =>
			new URL(chartEmbedUrls('dextools', { chain, token: evm, pool: evm }).embed).pathname.split('/')[3];
		expect(slugOf('ethereum')).toBe('ether');
		expect(slugOf('binance-smart-chain')).toBe('bnb');
		expect(slugOf('base')).toBe('base');
	});

	it('returns null for a pool provider until the pool is known', () => {
		expect(chartEmbedUrls('dextools', { chain: 'solana', token: THREE })).toBeNull();
		expect(chartEmbedUrls('geckoterminal', { chain: 'solana', token: THREE })).toBeNull();
	});
});

describe('resolveChartPool', () => {
	it('DEXTools charts the top pool without asking GeckoTerminal whether it indexed it', async () => {
		const calls = mockFetch({ '/api/coin/pool': { body: { pool: POOL } } });
		await expect(resolveChartPool('dextools', 'solana', THREE)).resolves.toEqual({ pool: POOL, indexed: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(`address=${THREE}`);
		expect(calls[0]).toContain('network=solana');
	});

	it('GeckoTerminal reports a pool it has not indexed as not drawable', async () => {
		mockFetch({
			'/api/coin/pool': { body: { pool: POOL } },
			'https://api.geckoterminal.com/': { status: 404 },
		});
		await expect(resolveChartPool('geckoterminal', 'solana', THREE)).resolves.toEqual({ pool: POOL, indexed: false });
	});

	it('a coin with no pool is a normal answer, not an error', async () => {
		mockFetch({ '/api/coin/pool': { status: 404 } });
		await expect(resolveChartPool('dextools', 'solana', THREE)).resolves.toEqual({ pool: null, indexed: false });
	});

	it('an upstream failure rejects so the UI can offer a retry', async () => {
		mockFetch({ '/api/coin/pool': { status: 502 } });
		await expect(resolveChartPool('dextools', 'solana', THREE)).rejects.toThrow(/pool lookup 502/);
	});

	it('a token-keyed provider needs no pool', async () => {
		const calls = mockFetch({});
		await expect(resolveChartPool('dexscreener', 'solana', THREE)).resolves.toEqual({ pool: null, indexed: false });
		expect(calls).toHaveLength(0);
	});
});
