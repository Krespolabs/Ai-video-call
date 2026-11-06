// curriculum.js — load the tour curriculum and own the cross-page tour state.
// ===========================================================================
// The curriculum (what the guide visits + says) is a plain JSON document — see
// curriculum.schema.json. A host supplies it as a URL to fetch or an inline
// object (config.curriculum). The live state (active? which stop? paused?
// muted?) lives in sessionStorage so the tour survives a full-page navigation
// between stops on different routes; durable progress/preferences live in
// localStorage so a returning visitor can pick the tour back up.
//
// The pure helpers (normalizePath, buildPlaylist, trackMeta, stopIndexForPath,
// sectionTitle) operate on a curriculum object and hold no state, so the
// sequencing logic and tests can use them freely. The IO/state surface is bound
// to a host's config through createTourState() / loadCurriculum().

const _cache = new Map();

// Load the curriculum from config.curriculum — either an inline object (used as
// is) or a URL to fetch (cached per URL after the first successful load).
export async function loadCurriculum(config) {
	const source = config?.curriculum ?? '/tour/curriculum.json';
	if (source && typeof source === 'object') {
		assertCurriculum(source);
		return source;
	}
	if (_cache.has(source)) return _cache.get(source);
	const res = await fetch(source, { cache: 'force-cache' });
	if (!res.ok) throw new Error(`tour curriculum ${res.status}`);
	const data = await res.json();
	assertCurriculum(data);
	_cache.set(source, data);
	return data;
}

function assertCurriculum(data) {
	if (!data || !Array.isArray(data.stops) || !data.stops.length) {
		throw new Error('tour curriculum empty');
	}
}

// Normalize a pathname to match curriculum stop paths ("/" stays "/", others
// lose any trailing slash). Query and hash are irrelevant to which stop we're on.
export function normalizePath(pathname = location.pathname) {
	const p = pathname.replace(/\/+$/, '');
	return p === '' ? '/' : p;
}

const DEFAULT_STATE = {
	active: false,
	index: 0,
	track: 'full',
	paused: false,
	muted: false,
	voice: 'nova',
	speed: 1,
};

const DEFAULT_RESUME = { index: 0, track: 'full', voice: 'nova', speed: 1, completed: false };

// Bind the per-host state surface to its storage keys + default voice. Returns
// the same read/write/clear functions the director relies on, scoped so two
// tours with different storagePrefixes never collide.
export function createTourState(config) {
	const STATE_KEY = config.keys.state;
	const RESUME_KEY = config.keys.resume;
	const baseState = { ...DEFAULT_STATE, voice: config.defaultVoice };
	const baseResume = { ...DEFAULT_RESUME, voice: config.defaultVoice };

	function readResume() {
		try {
			const raw = localStorage.getItem(RESUME_KEY);
			if (!raw) return { ...baseResume };
			return { ...baseResume, ...JSON.parse(raw) };
		} catch {
			return { ...baseResume };
		}
	}

	function writeResume(patch) {
		const next = { ...readResume(), ...patch };
		try {
			localStorage.setItem(RESUME_KEY, JSON.stringify(next));
		} catch {
			/* storage unavailable — cross-session resume simply won't persist */
		}
		return next;
	}

	function readState() {
		try {
			const raw = sessionStorage.getItem(STATE_KEY);
			if (!raw) return { ...baseState };
			return { ...baseState, ...JSON.parse(raw) };
		} catch {
			return { ...baseState };
		}
	}

	function writeState(patch) {
		const next = { ...readState(), ...patch };
		try {
			sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
		} catch {
			/* private mode / disabled storage — tour still runs within this page */
		}
		// Mirror durable preferences + progress so a returning visitor (new tab,
		// next day) can pick the tour back up. The live sequencing still reads from
		// sessionStorage; this is the cross-session memory only.
		if (next.active) {
			writeResume({ index: next.index, track: next.track, voice: next.voice, speed: next.speed });
		}
		return next;
	}

	function clearState() {
		try {
			sessionStorage.removeItem(STATE_KEY);
		} catch {
			/* ignore */
		}
	}

	function markCompleted() {
		writeResume({ completed: true, index: 0 });
	}

	return { readState, writeState, clearState, readResume, writeResume, markCompleted };
}

// ── Playlists ────────────────────────────────────────────────────────────────
// A track is a view over the curriculum: an ordered list of absolute stop
// indices to actually visit. 'full' is every stop; 'quick' is the highlighted
// heroes. Pure (no storage) so the sequencing logic and tests can build it
// freely. Always non-empty — an unknown track or a curriculum with no highlights
// falls back to the full list so the tour can never strand itself with nothing
// to play.
export function buildPlaylist(curriculum, track = 'full') {
	const all = curriculum.stops.map((_, i) => i);
	if (track !== 'quick') return all;
	const quick = all.filter((i) => curriculum.stops[i].highlight);
	return quick.length ? quick : all;
}

export function trackMeta(curriculum, track = 'full') {
	return (curriculum.tracks || []).find((t) => t.id === track) || null;
}

// Index of the first stop on a given path, or -1. Used to snap the tour back
// onto the route when a visitor navigates by hand.
export function stopIndexForPath(curriculum, pathname = location.pathname) {
	const target = normalizePath(pathname);
	return curriculum.stops.findIndex((s) => normalizePath(s.path) === target);
}

export function sectionTitle(curriculum, id) {
	return (curriculum.sections || []).find((s) => s.id === id)?.title || '';
}
