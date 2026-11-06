// The generated animation collection as a marketplace product line
// (api/_lib/generated-clip-market.js): listing rows, the rotating free subset,
// and the two routes that honour it, the marketplace feed and the x402 paid
// download. Driven through the real handlers with the database and object
// storage mocked, so the suite stays offline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '../_helpers/monetization.js';
import { freeClipNames, FREE_ROTATION } from '../../api/_lib/motion-seed.js';

const PLATFORM_ID = '0a0a0a0a-0000-4000-8000-000000000001';
const CREATOR_ID = '0b0b0b0b-0000-4000-8000-000000000002';
const CLIP_ID = '11111111-2222-4333-8444-555555555555';

// Twenty generated slugs: more than the free subset, so some are paid.
const SLUGS = Array.from({ length: 20 }, (_, i) => `gen-wave-hello-${String(i).padStart(12, '0')}`);

let platformExists = true;
let listingRow = null;
let lastFeedQuery = null;
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/from users where lower\(email::text\)/i.test(q)) {
		return Promise.resolve(platformExists ? [{ id: PLATFORM_ID }] : []);
	}
	if (/select slug from animation_clips/i.test(q)) return Promise.resolve(SLUGS.map((slug) => ({ slug })));
	if (/creator_payto_base/i.test(q)) return Promise.resolve(listingRow ? [listingRow] : []);
	if (/from animation_clips c/i.test(q)) {
		lastFeedQuery = { q, params: values[0] };
		return Promise.resolve([]);
	}
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock }));
vi.mock('../../api/_lib/r2.js', () => ({
	presignGet: vi.fn(async ({ key }) => `https://storage.example/${key}?signed=1`),
	thumbnailUrl: (key) => (key ? `https://cdn.example/${key}` : null),
}));

const market = await import('../../api/_lib/generated-clip-market.js');
const { __test__: feed } = await import('../../api/marketplace/animations.js');
const { default: marketplaceAnimations } = await import('../../api/marketplace/animations.js');
const { default: animationDownload } = await import('../../api/x402/animation-download.js');

const freeNow = () => new Set(freeClipNames(SLUGS));

beforeEach(() => {
	platformExists = true;
	listingRow = null;
	lastFeedQuery = null;
	market.resetGeneratedRotationCache();
});

describe('generatedListingRow', () => {
	const clip = {
		duration: 4,
		tracks: [{ name: 'Hips.quaternion', times: Array.from({ length: 121 }, (_, i) => i / 30), values: [] }],
		userData: { prompt: 'a person waves hello', category: 'emote', prompt_id: 'wave-hello' },
	};

	it('lists a clip under the platform account, public, priced, with the generated tag', () => {
		const row = market.generatedListingRow(
			{ name: SLUGS[0], label: 'Wave Hello', category: 'emote', loop: false },
			clip,
			{ ownerId: PLATFORM_ID, price: 0.01, artifactKey: 'k.glb', artifactBytes: 1234, tags: ['wave'] },
		);
		expect(row).toMatchObject({
			owner_id: PLATFORM_ID,
			slug: SLUGS[0],
			name: 'Wave Hello',
			kind: 'animation',
			loop: false,
			duration_ms: 4000,
			frame_count: 121,
			fps: 30,
			visibility: 'public',
			price_amount: 0.01,
			price_currency: 'USDC',
			artifact_key: 'k.glb',
			artifact_bytes: 1234,
			artifact_mime: 'model/gltf-binary',
			listed: true,
		});
		expect(row.tags).toEqual(['generated', 'emote', 'wave']);
		expect(row.description).toContain('a person waves hello');
	});

	it('marks loops as loops and a zero price as free', () => {
		const row = market.generatedListingRow({ name: SLUGS[1], loop: true }, clip, {
			ownerId: PLATFORM_ID,
			price: 0,
			artifactKey: 'k.glb',
			artifactBytes: 1,
		});
		expect(row.kind).toBe('loop');
		expect(row.price_amount).toBeNull();
		expect(row.price_currency).toBeNull();
		expect(row.name).toBe(SLUGS[1]);
	});

	it('numbers later takes of one prompt so they stay distinguishable', () => {
		const listing = { ownerId: PLATFORM_ID, price: 0.01, artifactKey: 'k.glb', artifactBytes: 1 };
		const entry = { name: SLUGS[2], label: 'Wave Hello' };
		expect(market.generatedListingRow(entry, clip, listing).name).toBe('Wave Hello');
		expect(market.generatedListingRow(entry, clip, { ...listing, take: 2 }).name).toBe('Wave Hello (take 2)');
	});

	it('prices at the Animation Bazaar advertised price, overridable by env', () => {
		expect(market.generatedListingPrice()).toBe(0.01);
		process.env.X402_PRICE_ANIMATION_DOWNLOAD = '250000';
		try {
			expect(market.generatedListingPrice()).toBe(0.25);
		} finally {
			delete process.env.X402_PRICE_ANIMATION_DOWNLOAD;
		}
	});
});

describe('generatedRotation', () => {
	it('frees exactly the hashed subset of the whole collection', async () => {
		const rotation = await market.generatedRotation();
		expect(rotation.platformId).toBe(PLATFORM_ID);
		expect(rotation.free.size).toBe(FREE_ROTATION.SIZE);
		expect(rotation.free).toEqual(freeNow());
	});

	it('rotates to a different subset next epoch', async () => {
		const now = Date.now();
		const here = await market.generatedRotation(now);
		const next = await market.generatedRotation(now + FREE_ROTATION.EPOCH_MS);
		expect(next.epoch).toBe(here.epoch + 1);
		expect([...next.free]).not.toEqual([...here.free]);
	});

	it('has nothing to rotate when the platform account is missing', async () => {
		platformExists = false;
		const rotation = await market.generatedRotation();
		expect(rotation.platformId).toBeNull();
		expect(rotation.free.size).toBe(0);
	});

	it('only a platform-owned, generated-tagged listing can be free', async () => {
		const rotation = await market.generatedRotation();
		const slug = [...rotation.free][0];
		const row = { owner_id: PLATFORM_ID, slug, tags: ['generated', 'emote'] };
		expect(market.isFreeGeneratedListing(row, rotation)).toBe(true);
		// A creator tagging their own clip "generated" is not in the rotation.
		expect(market.isFreeGeneratedListing({ ...row, owner_id: CREATOR_ID }, rotation)).toBe(false);
		// Nothing the platform lists by hand is given away by accident.
		expect(market.isFreeGeneratedListing({ ...row, tags: ['emote'] }, rotation)).toBe(false);
		const paidSlug = SLUGS.find((s) => !rotation.free.has(s));
		expect(market.isFreeGeneratedListing({ ...row, slug: paidSlug }, rotation)).toBe(false);
	});
});

describe('marketplace feed', () => {
	const baseRow = {
		id: CLIP_ID,
		owner_id: PLATFORM_ID,
		name: 'Wave Hello',
		kind: 'animation',
		duration_ms: 4000,
		tags: ['generated', 'emote'],
		price_amount: '0.010000000',
		price_currency: 'USDC',
		creator_name: 'three-ws',
	};

	it('reports a rotating clip as free with its regular price and end date', async () => {
		const rotation = await market.generatedRotation();
		const slug = [...rotation.free][0];
		const out = feed.shape({ ...baseRow, slug }, rotation);
		expect(out.free).toBe(true);
		expect(out.price).toBeNull();
		expect(out.generated).toBe(true);
		expect(out.free_rotation.regular_price).toEqual({ amount: '0.010000000', currency: 'USDC' });
		expect(new Date(out.free_rotation.until).getTime()).toBeGreaterThan(Date.now());
	});

	it('reports the rest of the collection at its price', async () => {
		const rotation = await market.generatedRotation();
		const slug = SLUGS.find((s) => !rotation.free.has(s));
		const out = feed.shape({ ...baseRow, slug }, rotation);
		expect(out.free).toBe(false);
		expect(out.price).toEqual({ amount: '0.010000000', currency: 'USDC' });
		expect(out.free_rotation).toBeNull();
		expect(out.generated).toBe(true);
	});

	it('leaves creator listings untouched', async () => {
		const rotation = await market.generatedRotation();
		const out = feed.shape({ ...baseRow, owner_id: CREATOR_ID, slug: [...rotation.free][0] }, rotation);
		expect(out.free).toBe(false);
		expect(out.generated).toBe(false);
	});

	it('builds a parameterised rotation predicate, constant false without a rotation', () => {
		const params = ['x'];
		const sqlText = feed.rotationFreeSql({ platformId: PLATFORM_ID, free: new Set(['a', 'b']) }, params);
		expect(sqlText).toBe('(c.owner_id = $2 and $3 = any(c.tags) and c.slug = any($4::text[]))');
		expect(params).toEqual(['x', PLATFORM_ID, 'generated', ['a', 'b']]);
		expect(feed.rotationFreeSql({ platformId: null, free: new Set() }, [])).toBe('false');
	});

	it('treats rotating clips as free in the ?price= filter', async () => {
		const { status } = await invoke(marketplaceAnimations, { url: '/api/marketplace/animations?price=free' });
		expect(status).toBe(200);
		expect(lastFeedQuery.q).toMatch(/case when \(c\.owner_id = \$1 and \$2 = any\(c\.tags\) and c\.slug = any\(\$3::text\[\]\)\) then null else c\.price_amount end\) is null/);
		expect(lastFeedQuery.params.slice(0, 3)).toEqual([PLATFORM_ID, 'generated', [...freeNow()]]);
	});
});

describe('x402 animation download', () => {
	// The paid path needs a platform payout address to quote in its challenge.
	// A synthetic one: the challenge is only built, nothing is ever settled.
	let prevPayTo;
	beforeEach(() => {
		prevPayTo = process.env.X402_PAY_TO_SOLANA;
		process.env.X402_PAY_TO_SOLANA = 'THREEsynthetic111111111111111111111111111111';
	});
	afterEach(() => {
		if (prevPayTo === undefined) delete process.env.X402_PAY_TO_SOLANA;
		else process.env.X402_PAY_TO_SOLANA = prevPayTo;
	});

	const listing = (slug, ownerId = PLATFORM_ID) => ({
		id: CLIP_ID,
		owner_id: ownerId,
		slug,
		tags: ['generated', 'emote'],
		name: 'Wave Hello',
		listed: true,
		price_amount: '0.010000000',
		price_currency: 'USDC',
		artifact_key: `animations/library/generated/glb/${slug}.glb`,
		artifact_mime: 'model/gltf-binary',
		artifact_bytes: '4096',
		creator_payto_base: null,
		creator_payto_solana: null,
		creator_payto_bsc: null,
	});

	it('hands a rotating clip over without payment', async () => {
		const slug = [...freeNow()][0];
		listingRow = listing(slug);
		const { status, body } = await invoke(animationDownload, {
			url: `/api/x402/animation-download?id=${CLIP_ID}`,
			query: { id: CLIP_ID },
		});
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.downloadUrl).toContain(`${slug}.glb`);
	});

	it('charges for a generated clip outside the rotation', async () => {
		const slug = SLUGS.find((s) => !freeNow().has(s));
		listingRow = listing(slug);
		const { status } = await invoke(animationDownload, {
			url: `/api/x402/animation-download?id=${CLIP_ID}`,
			query: { id: CLIP_ID },
		});
		expect(status).toBe(402);
	});

	it('charges a creator listing even when its slug collides with a free one', async () => {
		listingRow = listing([...freeNow()][0], CREATOR_ID);
		const { status } = await invoke(animationDownload, {
			url: `/api/x402/animation-download?id=${CLIP_ID}`,
			query: { id: CLIP_ID },
		});
		expect(status).toBe(402);
	});
});
