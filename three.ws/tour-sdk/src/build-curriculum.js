// build-curriculum.js — turn a "pages" document into a tour curriculum.
// =====================================================================
// The tour is driven by a curriculum (see curriculum.schema.json): an ordered
// list of stops, each a route to visit + a line to say, grouped into chapters
// with optional spoken intros, and split into tracks (Full / Quick). You can
// hand-author that JSON, or generate it from a description of your site's pages
// with this pure function — no filesystem, so it runs in a build step or the
// browser. The companion CLI (bin/tour-build-curriculum.mjs) wraps it to read a
// JSON file and write the curriculum out.
//
// Input shape (a superset of a typical sitemap/pages manifest):
//   {
//     sections: [
//       { id: 'main', title: 'Overview', pages: [
//         { path: '/', title: 'Home', description: 'The front door.', added: '2024-01-02', auth: 'public' },
//         ...
//       ] },
//       ...
//     ]
//   }
//
// Everything host-specific (section order, chapter intros, hero ordering, denied
// paths, per-page anchors) is an option with a sensible default.

const DEFAULT_CONNECTORS = [
	'Here we have',
	'Next up,',
	'This is',
	'Take a look at',
	'Now,',
	"Let's visit",
	'Over here is',
	"Here's",
	'Meet',
	'And this —',
	'Check out',
	'This one is',
];

// Words-per-minute for synthesized speech, plus per-stop overhead for the
// walk-in, the point gesture, and a beat to read the bubble.
const DEFAULT_WPM = 150;
const DEFAULT_STOP_OVERHEAD_S = 9;

/**
 * Build a tour curriculum from a pages document.
 *
 * @param {{sections: Array<{id:string,title:string,pages:Array<object>}>}} pagesDoc
 * @param {object} [opts]
 * @param {string[]} [opts.sectionOrder]   Section ids in render order. Defaults
 *        to the order they appear in pagesDoc.
 * @param {Object<string,string>} [opts.sectionIntros]  Spoken chapter bridges,
 *        keyed by section id. The first stop of a section carries its intro.
 * @param {Object<string,string[]>} [opts.sectionHeroes]  Per-section ordered
 *        list of hero paths shown first (and used to seed the Quick track).
 * @param {Object<string,string[]>} [opts.targets]  Per-path CSS selector lists
 *        the guide should point at; falls back to a heuristic at runtime.
 * @param {string[]} [opts.deny]           Exact paths to skip.
 * @param {string[]} [opts.denyPrefix]     Path prefixes to skip wholesale.
 * @param {boolean} [opts.skipAuthRequired] Skip pages with auth==='required'
 *        (default true).
 * @param {number} [opts.quickPerSection]  Leading stops per chapter in the Quick
 *        track (default 3).
 * @param {string[]} [opts.connectors]     Spoken openers, cycled per stop.
 * @param {string} [opts.title]            Curriculum title.
 * @param {string} [opts.tagline]          Curriculum tagline.
 * @param {number} [opts.wpm]              Narration words-per-minute estimate.
 * @param {number} [opts.stopOverheadS]    Per-stop overhead seconds estimate.
 * @returns {object} a curriculum object matching curriculum.schema.json
 */
export function buildCurriculum(pagesDoc, opts = {}) {
	const sectionsIn = Array.isArray(pagesDoc?.sections) ? pagesDoc.sections : [];
	const sectionIntros = opts.sectionIntros || {};
	const sectionHeroes = opts.sectionHeroes || {};
	const targets = opts.targets || {};
	const deny = new Set(opts.deny || []);
	const denyPrefix = opts.denyPrefix || [];
	const skipAuth = opts.skipAuthRequired !== false;
	const quickPerSection = Number.isFinite(opts.quickPerSection) ? opts.quickPerSection : 3;
	const connectors = opts.connectors?.length ? opts.connectors : DEFAULT_CONNECTORS;
	const wpm = opts.wpm || DEFAULT_WPM;
	const overhead = opts.stopOverheadS ?? DEFAULT_STOP_OVERHEAD_S;
	const order = opts.sectionOrder?.length ? opts.sectionOrder : sectionsIn.map((s) => s.id);

	const bySection = new Map();
	for (const section of sectionsIn) {
		const kept = (section.pages || []).filter(
			(p) =>
				p &&
				p.path &&
				!(skipAuth && p.auth === 'required') &&
				!deny.has(p.path) &&
				!denyPrefix.some((prefix) => p.path.startsWith(prefix)),
		);
		if (kept.length) bySection.set(section.id, { meta: section, pages: kept });
	}

	const stops = [];
	const sections = [];
	let totalWords = 0;
	let quickWords = 0;
	let quickCount = 0;

	for (const id of order) {
		const entry = bySection.get(id);
		if (!entry) continue;
		const ordered = orderSection(sectionHeroes[id] || [], entry.pages);
		const intro = sectionIntros[id] || '';
		sections.push({ id, title: entry.meta.title || titleCase(id), intro });
		ordered.forEach((page, i) => {
			const isFirstOfSection = i === 0;
			const highlight = i < quickPerSection;
			const narration = narrate(page, stops.length, connectors);
			const introWords = isFirstOfSection && intro ? intro.split(/\s+/).length : 0;
			const stopWords = narration.split(/\s+/).length + introWords;
			totalWords += stopWords;
			if (highlight) {
				quickWords += stopWords;
				quickCount += 1;
			}
			stops.push({
				id: slug(page.path),
				path: page.path,
				section: id,
				title: collapse(page.title),
				narration,
				highlight,
				...(isFirstOfSection && intro ? { sectionIntro: intro } : {}),
				...(targets[page.path] ? { targets: targets[page.path] } : {}),
			});
		});
	}

	const estimatedMinutes = minutesFor(totalWords, stops.length, wpm, overhead);
	const quickMinutes = Math.max(1, minutesFor(quickWords, quickCount, wpm, overhead));

	return {
		version: 2,
		generatedBy: '@three-ws/tour buildCurriculum',
		title: opts.title || 'Guided Tour',
		tagline: opts.tagline || 'A 3D guide walks you through every feature, live, on the real site.',
		estimatedMinutes,
		stopCount: stops.length,
		tracks: [
			{
				id: 'full',
				title: 'Full tour',
				description: 'Every feature, chapter by chapter.',
				stopCount: stops.length,
				estimatedMinutes,
			},
			{
				id: 'quick',
				title: 'Quick highlights',
				description: 'The best of every chapter, in a few minutes.',
				stopCount: quickCount,
				estimatedMinutes: quickMinutes,
			},
		],
		sections,
		stops,
	};
}

// Order a section's pages: heroes first (in their declared order), then the rest
// by recency (newest features are usually the most interesting to show).
function orderSection(heroes, pages) {
	const heroRank = new Map(heroes.map((path, i) => [path, i]));
	return [...pages].sort((a, b) => {
		const ra = heroRank.has(a.path) ? heroRank.get(a.path) : Infinity;
		const rb = heroRank.has(b.path) ? heroRank.get(b.path) : Infinity;
		if (ra !== rb) return ra - rb;
		const da = a.added || '';
		const db = b.added || '';
		if (da !== db) return da < db ? 1 : -1;
		return (a.title || '').localeCompare(b.title || '');
	});
}

// Turn a page's title + description into a spoken paragraph.
function narrate(page, index, connectors) {
	const connector = connectors[index % connectors.length];
	const title = collapse(page.title);
	let desc = collapse(page.description || '');
	// Strip a leading "<Title> — " / "<Title>:" the description sometimes repeats,
	// so the guide doesn't say the name twice.
	const dup = new RegExp(`^${escapeRe(title)}\\s*[—:-]\\s*`, 'i');
	desc = desc.replace(dup, '');
	desc = ensureSentence(desc);
	return `${connector} ${ensureSentence(title).replace(/\.$/, '')}. ${desc}`.trim();
}

function minutesFor(words, count, wpm, overhead) {
	return Math.round(words / wpm + (count * overhead) / 60);
}

function collapse(s) {
	return String(s || '').replace(/\s+/g, ' ').trim();
}
function ensureSentence(s) {
	s = collapse(s);
	if (!s) return s;
	return /[.!?]$/.test(s) ? s : s + '.';
}
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function slug(path) {
	return (
		String(path)
			.replace(/^\/+/, '')
			.replace(/\/+$/, '')
			.replace(/[^a-z0-9]+/gi, '-')
			.toLowerCase() || 'home'
	);
}
function titleCase(id) {
	return String(id || '')
		.replace(/[-_]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
