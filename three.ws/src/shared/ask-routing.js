// Shared, DOM-free routing for the /agent-screen task bar.
//
// The bar is a single input that does two things: a visitor *asks the agent a
// question* (answered live, out loud) and an authenticated owner can *queue a
// background task* for their worker to drain later. This module owns the pure
// decision of which one a given input is, so the branch is unit-testable without
// a browser and the client and tests can never disagree about the rule.

/**
 * Decide whether a task-bar submission is a live question ("ask") or an owner
 * background task ("task").
 *
 * Rules, in order:
 *  - A non-owner can only ask — they have no worker to queue tasks for.
 *  - An explicit mode ('ask' | 'task') chosen via the bar's toggle wins for an
 *    owner who deliberately picked one.
 *  - Otherwise the default is always "ask": the bar is first a way to talk to
 *    the agent. An owner reaches the queue by switching the toggle to Task.
 *
 * @param {{ isOwner?: boolean, mode?: 'ask'|'task'|null }} [opts]
 * @returns {'ask'|'task'}
 */
export function classifyTaskInput({ isOwner = false, mode = null } = {}) {
	if (!isOwner) return 'ask';
	if (mode === 'task') return 'task';
	return 'ask';
}

/**
 * A stable per-session id for Q&A memory continuity. Persists in sessionStorage
 * so follow-up questions in the same tab share a memory thread, while a new tab
 * or visit starts a fresh one. Falls back to an in-memory id when storage is
 * unavailable (private mode / disabled cookies) so a session is never broken.
 *
 * @param {Storage} [store] injectable for tests; defaults to sessionStorage
 * @param {() => string} [makeId] injectable id factory for tests
 * @returns {string}
 */
export function ensureSessionId(store, makeId) {
	const gen = makeId || (() =>
		(typeof crypto !== 'undefined' && crypto.randomUUID)
			? crypto.randomUUID()
			: `s-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);
	const storage = store || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
	const KEY = 'twx_asc_qa_session';
	if (!storage) return gen();
	try {
		let id = storage.getItem(KEY);
		if (!id) { id = gen(); storage.setItem(KEY, id); }
		return id;
	} catch {
		return gen();
	}
}
