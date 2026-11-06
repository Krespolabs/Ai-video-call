// @ts-check
// Launch use-case registry — the single catalog every surface reads. Each
// category module exports an array of declarative use cases; this file merges
// them, validates every entry at load (so a malformed recipe fails the import,
// never a launch), and enforces unique ids. Add a category by importing its
// array here — nothing else changes.

import { validateUseCase, summarizeUseCase } from './usecase-engine.js';
import { githubUseCases } from './usecases/github.js';
import { cultureUseCases } from './usecases/culture.js';
import { newsUseCases } from './usecases/news.js';
import { onchainUseCases } from './usecases/onchain.js';
import { eventsUseCases } from './usecases/events.js';
import { communityUseCases } from './usecases/community.js';

const CATEGORY_MODULES = [
	githubUseCases, cultureUseCases, newsUseCases, onchainUseCases, eventsUseCases, communityUseCases,
];

/** @type {Map<string, any>} */
const byId = new Map();
for (const arr of CATEGORY_MODULES) {
	for (const uc of arr || []) {
		validateUseCase(uc);
		if (byId.has(uc.id)) throw new Error(`duplicate launch use-case id: ${uc.id}`);
		byId.set(uc.id, uc);
	}
}

/** All use cases as public summaries, optionally filtered. */
export function listUseCases({ category, mode } = {}) {
	let out = [...byId.values()];
	if (category) out = out.filter((u) => u.category === category);
	if (mode) out = out.filter((u) => u.mode === mode);
	return out.map(summarizeUseCase);
}

/** The full use-case object (with naming/rewards fns) for planning, or null. */
export function getUseCase(id) {
	return byId.get(id) || null;
}

/** Every use case object (internal — has functions). */
export function allUseCases() {
	return [...byId.values()];
}

/** Distinct categories present, in a stable display order. */
export function categories() {
	const order = ['github', 'onchain', 'news', 'culture', 'events', 'community'];
	const present = new Set([...byId.values()].map((u) => u.category));
	return order.filter((c) => present.has(c));
}

export const USE_CASE_COUNT = byId.size;
