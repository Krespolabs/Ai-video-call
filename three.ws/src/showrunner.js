// Showrunner — the client that programs /agents-live like a live TV channel.
//
// It merges the server program (/api/agents/showrunner: featured + notable feed
// events + popular roster) with the wall's own LIVE TRUTH — which cards are
// actually casting a real caster frame right now, plus fresh per-card beats the
// wall ingests (a banked trade, a completed forge) — and ranks the union into a
// rotating spotlight queue + a grid order. The pure ranking is the unit-tested
// rankCandidates() from ./shared/showrunner-rank.js; this file owns the live
// plumbing around it: a cheap polled program refresh, fold-ins from the page's
// existing feed stream, a rotation cursor, and an onChange callback.
//
// Nothing here invents activity. Every spotlight pick traces to a real signal:
// a real caster frame, a real feed event, the real featured pick, or real usage.

import { rankCandidates } from './shared/showrunner-rank.js';

const PROGRAM_POLL_MS = 15_000;   // server program is cached ~10s — poll just past it
const EVENT_TTL_MS = 6 * 60 * 1000; // a folded-in beat ages out after this
const MAX_EVENTS = 48;            // cap the live-event map so a burst can't grow it

// Feed types that name a specific agent (carry an agentId) → spotlight reason.
const FEED_REASON = {
	'agent-deploy':  { kind: 'forge',  reason: 'newest forge',      magnitude: 1 },
	'agent-onchain': { kind: 'verify', reason: 'verified on-chain', magnitude: 2 },
};

/**
 * Create a showrunner bound to the wall's live truth.
 *
 * @param {object} ctx
 * @param {() => Set<string>} ctx.getLiveIds   agentIds currently casting (isLiveNow)
 * @param {(id:string) => string|null} ctx.getCardName  display name for a mounted card, or null if not on the wall
 * @param {(program:Array<object>, current:object|null) => void} ctx.onChange  fired when the ranked program changes
 * @param {() => number} [ctx.now]             clock (injectable for tests); defaults to Date.now
 * @returns {object} controller
 */
export function createShowrunner({ getLiveIds, getCardName, onChange, now = () => Date.now() }) {
	let _serverCandidates = [];
	let _serverOrder = [];
	const _events = new Map();      // agentId → { agentId, name, kind, reason, magnitude, ts }
	let _program = [];              // ranked candidate objects (mounted agents only)
	let _cursor = 0;
	let _pollTimer = null;
	let _running = false;

	function pruneEvents() {
		const cutoff = now() - EVENT_TTL_MS;
		for (const [id, ev] of _events) if (ev.ts < cutoff) _events.delete(id);
		// Hard cap: drop the oldest if a burst overflowed the map.
		if (_events.size > MAX_EVENTS) {
			const oldest = [..._events.entries()].sort((a, b) => a[1].ts - b[1].ts);
			for (let i = 0; i < oldest.length - MAX_EVENTS; i++) _events.delete(oldest[i][0]);
		}
	}

	// Merge every source into one candidate list for ranking. Only agents that
	// actually have a card on the wall are kept, so the spotlight never tries to
	// promote an agent it can't show.
	function buildCandidates() {
		const mounted = (id) => !!getCardName(id);
		const merged = [];
		const seen = new Set();

		const push = (c) => {
			if (!c || !c.agentId || !mounted(c.agentId)) return;
			merged.push({ ...c, name: c.name || getCardName(c.agentId) });
			seen.add(c.agentId);
		};

		// 1. fresh per-card / feed beats (highest-fidelity reasons).
		for (const ev of _events.values()) push(ev);
		// 2. server spotlight candidates (notable + featured + popular).
		for (const c of _serverCandidates) push(c);
		// 3. any popular-order id not yet represented → calm baseline candidate.
		for (const id of _serverOrder) {
			if (seen.has(id)) continue;
			push({ agentId: id, kind: 'popular', reason: 'on the wall', magnitude: 0, ts: 0 });
		}
		// 4. live agents that no source mentioned → synthesize so they still rank.
		for (const id of getLiveIds()) {
			if (seen.has(id) || !mounted(id)) continue;
			push({ agentId: id, kind: 'live', reason: 'live now', magnitude: 0, ts: now(), live: true });
		}
		return merged;
	}

	function recompute() {
		const ranked = rankCandidates(buildCandidates(), { now: now(), liveIds: getLiveIds() });
		const prevId = _program[_cursor]?.agentId;
		_program = ranked;
		// Keep the spotlight on the same agent across a reshuffle when it survives,
		// so rotation isn't yanked out from under a viewer mid-dwell.
		const keepIdx = prevId ? ranked.findIndex((c) => c.agentId === prevId) : -1;
		_cursor = keepIdx >= 0 ? keepIdx : 0;
		onChange?.(_program, getCurrent());
	}

	function getCurrent() {
		if (!_program.length) return null;
		_cursor = ((_cursor % _program.length) + _program.length) % _program.length;
		return _program[_cursor];
	}

	function next() {
		if (!_program.length) return null;
		_cursor = (_cursor + 1) % _program.length;
		return _program[_cursor];
	}

	function prev() {
		if (!_program.length) return null;
		_cursor = (_cursor - 1 + _program.length) % _program.length;
		return _program[_cursor];
	}

	// Jump the spotlight directly to an agent (queue-dot / chevron click).
	function setCurrent(agentId) {
		const idx = _program.findIndex((c) => c.agentId === agentId);
		if (idx >= 0) _cursor = idx;
		return getCurrent();
	}

	// Fold a normalized feed event (from the page's existing feed plumbing) into
	// the candidate set the instant it lands, so a fresh forge/verification can
	// reclaim the spotlight without waiting for the next program poll.
	function onFeedEvent(ev) {
		const agentId = ev && (ev.agentId || ev.agent_id);
		const m = ev && FEED_REASON[ev.type];
		if (!agentId || !m) return;
		_events.set(agentId, {
			agentId,
			name: ev.sub || ev.name || getCardName(agentId),
			kind: m.kind,
			reason: m.reason,
			magnitude: m.magnitude,
			ts: Number(ev.ts) || now(),
		});
		pruneEvents();
		recompute();
	}

	// Fold a beat the wall surfaced itself — a banked trade, a completed forge —
	// keyed to its card. `magnitude` (e.g. |USD| of a realized exit) ranks bigger
	// moves higher within the notable tier.
	function noteCardEvent({ agentId, kind, reason, magnitude = 1 }) {
		if (!agentId || !kind) return;
		_events.set(agentId, {
			agentId,
			name: getCardName(agentId),
			kind,
			reason,
			magnitude,
			ts: now(),
		});
		pruneEvents();
		recompute();
	}

	async function fetchProgram() {
		try {
			const r = await fetch('/api/agents/showrunner', { headers: { accept: 'application/json' } });
			if (!r.ok) return;
			const d = await r.json();
			_serverCandidates = Array.isArray(d.spotlightCandidates) ? d.spotlightCandidates : [];
			_serverOrder = Array.isArray(d.programOrder) ? d.programOrder : [];
			recompute();
		} catch { /* offline — the wall keeps running on live truth alone */ }
	}

	// Live truth shifts (a card goes live, an FPS tick) drive a recompute without a
	// network round-trip. The page calls this on its own cadence.
	function refreshLive() {
		if (_running) recompute();
	}

	function start() {
		if (_running) return;
		_running = true;
		fetchProgram();
		_pollTimer = setInterval(() => {
			if (typeof document === 'undefined' || !document.hidden) fetchProgram();
		}, PROGRAM_POLL_MS);
	}

	function stop() {
		_running = false;
		if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
	}

	return {
		start, stop,
		getProgram: () => _program,
		getCurrent, next, prev, setCurrent,
		onFeedEvent, noteCardEvent, refreshLive,
		// test seam
		_recompute: recompute,
	};
}
