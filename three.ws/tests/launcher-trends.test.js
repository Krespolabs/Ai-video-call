import { describe, it, expect } from 'vitest';
import { decodeEntities, parseRssItems, normTerm, parseGoogleTrends, isSensitive } from '../api/_lib/launcher-trends.js';

describe('decodeEntities', () => {
	it('unwraps CDATA', () => {
		expect(decodeEntities('<![CDATA[Drooling Cat]]>')).toBe('Drooling Cat');
	});
	it('decodes named + numeric entities', () => {
		expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
		expect(decodeEntities('Don&#39;t Swear')).toBe("Don't Swear");
		expect(decodeEntities('Don&apos;t')).toBe("Don't");
	});
	it('strips unknown entities to a space rather than leaking "amp"-style garbage', () => {
		expect(decodeEntities('A&nbsp;B')).toBe('A B');
	});
});

describe('parseRssItems', () => {
	const xml = `<?xml version="1.0"?><rss><channel>
		<title>Know Your Meme Entries - Confirmed</title>
		<link>https://knowyourmeme.com</link>
		<item><title>Drooling Cat / Crowd of Drooling Cats</title>
			<link>https://knowyourmeme.com/memes/drooling-cat</link></item>
		<item><title><![CDATA[Train Dog]]></title>
			<link>https://knowyourmeme.com/memes/train-dog</link></item>
	</channel></rss>`;

	it('reads only <item> blocks, skipping the channel-level title', () => {
		const items = parseRssItems(xml);
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.title)).toEqual([
			'Drooling Cat / Crowd of Drooling Cats',
			'Train Dog',
		]);
	});
	it('captures item links for slug de-referencing', () => {
		const items = parseRssItems(xml);
		expect(items[1].link).toBe('https://knowyourmeme.com/memes/train-dog');
	});
	it('returns [] for empty / malformed input, never throws', () => {
		expect(parseRssItems('')).toEqual([]);
		expect(parseRssItems(null)).toEqual([]);
		expect(parseRssItems('<rss>no items here</rss>')).toEqual([]);
	});
});

describe('KYM theme extraction shape', () => {
	it('takes the first clean variant from a "Primary / Variant" title', () => {
		const variant = 'Drooling Cat / Crowd of Drooling Cats'
			.split(/\s*\/\s*/).map((v) => normTerm(v)).find(Boolean);
		expect(variant).toBe('Drooling Cat');
	});
	it('falls through an emoticon variant to the readable one', () => {
		const variant = '( ͡° ͜ʖ ͡°) / Lenny Face'
			.split(/\s*\/\s*/).map((v) => normTerm(v)).find(Boolean);
		expect(variant).toBe('Lenny Face');
	});
	it('drops overlong meme titles (no usable ticker theme)', () => {
		expect(normTerm('She Had No Idea They Was Gonna Play In Her Face')).toBeNull();
	});
	it('de-slugs a /memes/<slug> link into a theme phrase', () => {
		const m = 'https://knowyourmeme.com/memes/subcultures/chimptopia'
			.match(/\/memes\/(?:[a-z-]+\/)?([a-z0-9-]+)\b/i);
		expect(normTerm(m[1].replace(/-/g, ' '))).toBe('chimptopia');
	});
});

describe('parseGoogleTrends', () => {
	const item = (title, traffic, news) => `
		<item>
			<title>${title}</title>
			<ht:approx_traffic>${traffic}</ht:approx_traffic>
			${(news || []).map((n) => `<ht:news_item><ht:news_item_title>${n}</ht:news_item_title></ht:news_item>`).join('')}
		</item>`;
	const wrap = (items) => `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel><title>Daily Search Trends</title>${items}</channel></rss>`;

	it('extracts clean trends as lowercased event themes', () => {
		const rows = parseGoogleTrends(wrap(item('Labubu Craze', '50,000+', ['Labubu dolls sell out worldwide'])));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ term: 'labubu craze', kind: 'event' });
		expect(rows[0].weight).toBeGreaterThan(0.6);
		expect(rows[0].weight).toBeLessThanOrEqual(1.6);
	});

	it('weights higher traffic above lower traffic', () => {
		const hi = parseGoogleTrends(wrap(item('Big Wave', '2,000,000+', ['Big Wave goes viral'])))[0];
		const lo = parseGoogleTrends(wrap(item('Small Wave', '1,000+', ['Small Wave noticed'])))[0];
		expect(hi.weight).toBeGreaterThan(lo.weight);
	});

	it('drops a trend whose NEWS context is sensitive even when the term is clean', () => {
		// Bare "John Smith" passes normTerm; the news reveals a tragedy → must be dropped.
		const rows = parseGoogleTrends(wrap(item('John Smith', '20,000+', ['John Smith dies in fatal car crash'])));
		expect(rows).toHaveLength(0);
	});

	it('drops sensitive bare terms', () => {
		const rows = parseGoogleTrends(wrap(item('Earthquake', '100,000+', ['Magnitude 7 earthquake hits'])));
		expect(rows).toHaveLength(0);
	});

	it('returns [] for empty / malformed input, never throws', () => {
		expect(parseGoogleTrends('')).toEqual([]);
		expect(parseGoogleTrends(null)).toEqual([]);
	});
});

describe('isSensitive', () => {
	it('catches death/disaster words and naive plurals', () => {
		expect(isSensitive('a deadly shooting')).toBe(true);
		expect(isSensitive('earthquakes today')).toBe(true);
		expect(isSensitive('celebrity dies')).toBe(true);
	});
	it('passes ordinary culture terms', () => {
		expect(isSensitive('drooling cat')).toBe(false);
		expect(isSensitive('labubu craze')).toBe(false);
	});
});
