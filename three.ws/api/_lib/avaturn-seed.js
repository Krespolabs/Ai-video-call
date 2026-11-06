// @ts-check
// Pure helpers for the avaturn-seed cron — no I/O, fully unit-testable.
//
// The cron drives Avaturn's editor headlessly and randomizes a "look" from the
// account's own catalog (bodies + assets + colors) rather than from AI photos,
// so every export is an on-model, fully-rigged Avaturn avatar. The randomization
// is seeded (mulberry32) so a given seed reproduces a look exactly — handy for
// debugging a bad export and for deterministic tests.

/** @typedef {{ id: string, name?: string, category?: string, type?: string, slot?: string }} CatalogItem */
/** @typedef {{ id: string, name?: string, gender?: string, body_type?: string }} BodyItem */

// ── Seeded RNG ─────────────────────────────────────────────────────────────────

/**
 * Hash an arbitrary string into a 32-bit unsigned int seed.
 * @param {string} str
 * @returns {number}
 */
export function hashSeed(str) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * mulberry32 — tiny, fast, well-distributed seeded PRNG. Returns a function that
 * yields floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Pick one element of `arr` using `rng`. Returns undefined for an empty array.
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T | undefined}
 */
export function pickOne(arr, rng) {
	if (!Array.isArray(arr) || arr.length === 0) return undefined;
	return arr[Math.floor(rng() * arr.length)];
}

// ── Catalog grouping ───────────────────────────────────────────────────────────

// Wearable asset slots we randomize. One asset is chosen per slot the catalog
// actually offers — missing slots are simply skipped, never faked. The Avaturn
// catalog tags each asset with a category/type; we normalize a few common
// spellings so grouping is stable across catalog revisions.
export const WEARABLE_SLOTS = [
	'outfit',
	'top',
	'bottom',
	'shoes',
	'hair',
	'headwear',
	'glasses',
	'outerwear',
];

const SLOT_ALIASES = {
	clothing: 'outfit',
	costume: 'outfit',
	footwear: 'shoes',
	shoe: 'shoes',
	hairstyle: 'hair',
	hat: 'headwear',
	headgear: 'headwear',
	eyewear: 'glasses',
	jacket: 'outerwear',
	coat: 'outerwear',
};

/**
 * Normalize a raw catalog category/type string to one of WEARABLE_SLOTS, or
 * return the lowercased original when it isn't a slot we randomize.
 * @param {string} [raw]
 * @returns {string}
 */
export function normalizeSlot(raw) {
	const k = String(raw || '')
		.trim()
		.toLowerCase();
	return SLOT_ALIASES[k] || k;
}

/**
 * Group a flat asset list into { slot: CatalogItem[] }, keeping only slots we
 * randomize.
 * @param {CatalogItem[]} assets
 * @returns {Record<string, CatalogItem[]>}
 */
export function groupAssetsBySlot(assets) {
	/** @type {Record<string, CatalogItem[]>} */
	const grouped = {};
	for (const asset of Array.isArray(assets) ? assets : []) {
		if (!asset || !asset.id) continue;
		const slot = normalizeSlot(asset.category ?? asset.type ?? asset.slot);
		if (!WEARABLE_SLOTS.includes(slot)) continue;
		(grouped[slot] ||= []).push(asset);
	}
	return grouped;
}

// ── Color randomization ─────────────────────────────────────────────────────────

// Natural hair shades — kept realistic so results stay on-model rather than
// cartoonish. setHairColor takes a `#rrggbb` string.
export const HAIR_COLORS = [
	'#0b0b0b',
	'#1c1310',
	'#2a1a0f',
	'#3b2412',
	'#4a2f1a',
	'#5c3a1e',
	'#6b4423',
	'#7a5230',
	'#8d6239',
	'#a87c4f',
	'#c69a63',
	'#d9b380',
	'#e3c79a',
	'#9a9a9a',
	'#d8d8d8',
];

// Avaturn eye colors are an enum keyed by name; these are the standard set.
export const EYE_COLORS = ['brown', 'dark_brown', 'hazel', 'amber', 'green', 'blue', 'gray'];

/**
 * Build a fully-randomized look from the live catalog. Pure — no I/O. The caller
 * (the headless harness) applies the returned ids/values via the Avaturn SDK.
 *
 * @param {string} seed  - any string (we hash it); same seed → same look
 * @param {{ bodies: BodyItem[], assets: CatalogItem[], bodyType?: 'male'|'female' }} catalog
 * @returns {{
 *   bodyId: string | null,
 *   assetIds: string[],
 *   assetsBySlot: Record<string, string>,
 *   hairColor: string,
 *   eyeColor: string,
 *   skinToneCorrection: number,
 * }}
 */
export function pickRandomLook(seed, { bodies, assets, bodyType }) {
	const rng = mulberry32(hashSeed(String(seed)));

	// Prefer a body matching the requested gender when the catalog tags it;
	// fall back to the whole list so we always pick something real.
	let bodyPool = Array.isArray(bodies) ? bodies.filter((b) => b && b.id) : [];
	if (bodyType) {
		const matched = bodyPool.filter((b) => normalizeSlot(b.gender ?? b.body_type) === bodyType);
		if (matched.length) bodyPool = matched;
	}
	const body = pickOne(bodyPool, rng);

	const grouped = groupAssetsBySlot(assets);
	/** @type {Record<string, string>} */
	const assetsBySlot = {};
	const assetIds = [];
	// Deterministic slot order so the seed reproduces the same look.
	for (const slot of WEARABLE_SLOTS) {
		const choice = pickOne(grouped[slot] || [], rng);
		if (choice) {
			assetsBySlot[slot] = choice.id;
			assetIds.push(choice.id);
		}
	}

	return {
		bodyId: body?.id ?? null,
		assetIds,
		assetsBySlot,
		hairColor: pickOne(HAIR_COLORS, rng) ?? HAIR_COLORS[0],
		eyeColor: pickOne(EYE_COLORS, rng) ?? EYE_COLORS[0],
		// -50..50; 0 = no correction. Keep within a gentle band so skin stays natural.
		skinToneCorrection: Math.round((rng() - 0.5) * 30),
	};
}

/**
 * Pick a body type for a run. Roughly even split, seeded for reproducibility.
 * @param {string} seed
 * @returns {'male'|'female'}
 */
export function pickBodyType(seed) {
	return mulberry32(hashSeed(seed + ':bodytype'))() < 0.5 ? 'male' : 'female';
}

// ── Public editor (no API key) ──────────────────────────────────────────────────
// The seed cron drives Avaturn's *public* editor — the same iframe the demo uses
// — so it needs no API key or per-account session. The SDK opens this URL, the
// catalog is the public one, and exportAvatar() returns a rigged GLB.

export const AVATURN_DEFAULT_EDITOR = 'https://preview.avaturn.dev/editor';
export const AVATURN_DEFAULT_BODY = {
	male: 'https://assets.avaturn.me/editor_resources/default_male.glb',
	female: 'https://assets.avaturn.me/editor_resources/default_female.glb',
};

/**
 * Build the public Avaturn editor URL seeded with a default body for the
 * requested gender. The SDK appends `?sdk=true&noui=true` itself.
 * @param {'male'|'female'} [bodyType]
 * @returns {string}
 */
export function defaultEditorUrl(bodyType = 'male') {
	const link = AVATURN_DEFAULT_BODY[bodyType] || AVATURN_DEFAULT_BODY.male;
	return `${AVATURN_DEFAULT_EDITOR}?avatar_link=${encodeURIComponent(link)}`;
}

// ── Diversity engine (photo-seeded lane) ────────────────────────────────────────
// The public-catalog lane varies outfit/hair/skin-tone over a couple of base
// faces, so its avatars read as similar people in different clothes. To get
// genuinely different humans — girls and guys, young and old, every complexion —
// we seed Avaturn from a generated *face photo*: a described person drawn from a
// diversity matrix, rendered by the text→image lane, then reconstructed by
// Avaturn into a distinct, fully-rigged avatar. These helpers are pure so the
// matrix coverage and prompt wording are unit-testable.

// Age bands carry a gray-hair bias so seniors trend silver without forcing it.
export const AGE_BANDS = [
	{ key: 'young-adult', desc: 'in their early twenties', grayBias: 0 },
	{ key: 'adult', desc: 'in their early thirties', grayBias: 0.05 },
	{ key: 'middle-aged', desc: 'in their late forties, a few soft laugh lines', grayBias: 0.3 },
	{
		key: 'senior',
		desc: 'in their late sixties, natural wrinkles and gentle age lines',
		grayBias: 0.85,
	},
];

// A broad, respectful spread of appearances. `skin` is the gentle Avaturn
// skin-tone correction band (-50..50) applied on top of the photo, kept small
// because the generated face already carries the complexion.
export const ETHNICITIES = [
	{ key: 'east-asian', desc: 'East Asian', skin: [-8, 6] },
	{ key: 'southeast-asian', desc: 'Southeast Asian', skin: [-2, 12] },
	{ key: 'south-asian', desc: 'South Asian', skin: [6, 20] },
	{ key: 'black-african', desc: 'Black African', skin: [14, 28] },
	{ key: 'black-caribbean', desc: 'Afro-Caribbean', skin: [10, 24] },
	{ key: 'latino', desc: 'Latin American', skin: [2, 16] },
	{ key: 'middle-eastern', desc: 'Middle Eastern', skin: [2, 16] },
	{ key: 'white-european', desc: 'White European', skin: [-24, -4] },
	{ key: 'nordic', desc: 'Nordic', skin: [-32, -12] },
	{ key: 'pacific-islander', desc: 'Pacific Islander', skin: [4, 18] },
];

export const BUILDS = ['slim', 'average', 'athletic', 'curvy', 'stocky', 'lean'];

/**
 * Draw one described person from the diversity matrix. Deterministic in `seed`
 * (a different sub-stream than body/look) so a given seed reproduces the same
 * human — handy for reruns and tests.
 * @param {string} seed
 * @returns {{ gender:'male'|'female', ageKey:string, ageDesc:string, grayBias:number,
 *   ethnicityKey:string, ethnicityDesc:string, build:string, skinToneCorrection:number }}
 */
export function pickDiversityProfile(seed) {
	const rng = mulberry32(hashSeed(String(seed) + ':profile'));
	const gender = rng() < 0.5 ? 'male' : 'female';
	const age = pickOne(AGE_BANDS, rng) ?? AGE_BANDS[0];
	const eth = pickOne(ETHNICITIES, rng) ?? ETHNICITIES[0];
	const build = pickOne(BUILDS, rng) ?? BUILDS[0];
	const [lo, hi] = eth.skin;
	return {
		gender,
		ageKey: age.key,
		ageDesc: age.desc,
		grayBias: age.grayBias,
		ethnicityKey: eth.key,
		ethnicityDesc: eth.desc,
		build,
		skinToneCorrection: Math.round(lo + rng() * (hi - lo)),
	};
}

/**
 * Build the three ID-style face prompts (frontal + two three-quarter views) for
 * a profile. Passport-style framing — neutral, evenly lit, unobstructed — is
 * what Avaturn's reconstruction wants.
 * @param {ReturnType<typeof pickDiversityProfile>} profile
 * @returns {{ frontal:string, left:string, right:string }}
 */
export function faceGenPrompts(profile) {
	const noun = profile.gender === 'male' ? 'man' : 'woman';
	const who = `a ${profile.build} ${profile.ethnicityDesc} ${noun} ${profile.ageDesc}`;
	const base =
		`photorealistic studio ID portrait of ${who}, neutral relaxed expression, mouth closed, ` +
		`looking at the camera, plain light-grey seamless background, soft even frontal lighting, ` +
		`sharp focus, natural detailed skin texture, no glasses, no hat, no jewelry, hair kept clear of the face`;
	return {
		frontal: `${base}, head facing the camera straight on, symmetrical framing`,
		left: `${base}, head turned about thirty degrees to their left, three-quarter view`,
		right: `${base}, head turned about thirty degrees to their right, three-quarter view`,
	};
}

/**
 * A short, human-readable label for a profile — used in avatar descriptions and
 * the seeder console (e.g. "East Asian woman, late sixties").
 * @param {ReturnType<typeof pickDiversityProfile>} profile
 * @returns {string}
 */
export function describeProfile(profile) {
	const noun = profile.gender === 'male' ? 'man' : 'woman';
	const age = profile.ageDesc.replace(/,.*$/, ''); // drop the wrinkle clause
	return `${profile.ethnicityDesc} ${noun}, ${age}`;
}
