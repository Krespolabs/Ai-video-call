// ShowDirector — the pure, Colyseus-free brain-stem of a live stage performance.
//
// The StageRoom (Colyseus) owns sockets, schema, and broadcast; everything it
// DECIDES — which beat the host performs next, who the top tippers are, which
// audience question gets answered, when a tip shoutout pre-empts the banter — is
// computed here, in a dependency-free module that runs (and is tested) without a
// room. This is the same isolation ClashMatch uses: the room is a thin shell over
// a pure director, so the show's logic is unit-testable end to end.
//
// Money is integer atomic units throughout (a tip's amount as it settled on
// chain). The director never touches the chain or the DB — it accumulates the
// already-validated tips the room hands it and ranks them.

// Beat kinds the director can ask the host to perform. The room turns the chosen
// kind + context into a brain prompt; the brain returns the actual words.
export const BEAT = {
	OPENER: 'opener', // first words when the show goes live
	TIP_SHOUTOUT: 'tip_shoutout', // react to a fresh tip — highest priority
	ANSWER: 'answer', // answer a queued audience question
	BANTER: 'banter', // riff / read the room between beats
	GAME: 'game', // run the next round of the show's game/format
};

const MAX_QUESTION_QUEUE = 24; // bound the queue so a flood can't bloat memory
const MAX_PENDING_TIPS = 32; // shoutout backlog cap — oldest dropped if it overflows
const MAX_RECENT_BEATS = 8; // remember the last few beats so the host doesn't loop
const QUESTION_MAX_LEN = 240;

export class ShowDirector {
	/**
	 * @param {object} opts
	 * @param {string} opts.stageId
	 * @param {string} [opts.hostName]
	 * @param {string} [opts.format]   freeform format label (e.g. 'game show', 'AMA', 'DJ set')
	 * @param {number} [opts.startedAt] epoch ms the show went live
	 */
	constructor({ stageId, hostName = 'the host', format = 'open mic', startedAt = 0 } = {}) {
		this.stageId = stageId;
		this.hostName = hostName;
		this.format = format;
		this.startedAt = startedAt || 0;

		// Tip ledger — keyed by a stable tipper id (user id, or wallet, or device).
		// Each entry accumulates total atomic units + count so the leaderboard is a
		// single sort. A returning tipper across beats lands on the same row.
		this._tippers = new Map(); // tipperId → { id, label, total, count, lastTs }
		// Fresh tips the host hasn't shouted out yet, oldest first.
		this._pendingTips = [];
		// Audience questions awaiting the host's pick, oldest first.
		this._questionQueue = [];
		this._seenQuestionIds = new Set();
		// Recent beat kinds (most-recent last) so the director can avoid repeating
		// the same filler twice in a row.
		this._recentBeats = [];

		this.totalTipsAtomic = 0;
		this.tipCount = 0;
		this.peakAudience = 0;
		this._spokenOpener = false;
	}

	// ── audience sizing ──────────────────────────────────────────────────────
	noteAudience(size) {
		const n = Number(size);
		if (Number.isFinite(n) && n > this.peakAudience) this.peakAudience = n;
	}

	// ── tips ─────────────────────────────────────────────────────────────────
	/**
	 * Record an already-validated, already-settled tip. The room is the trust
	 * boundary (it only forwards tips the API verified + deduped by signature);
	 * the director assumes each call is a distinct, real settlement and ranks it.
	 *
	 * @returns {{ tip: object, isNewTopTipper: boolean }}
	 */
	ingestTip({ tipperId, label, amount, mint, signature, message = '', ts = 0 }) {
		const amt = Number(amount);
		const safeAmt = Number.isInteger(amt) && amt > 0 ? amt : 0;
		const id = String(tipperId || signature || 'anon').slice(0, 80);
		const cleanLabel = cleanText(label || 'someone', 48) || 'someone';
		const topBefore = this.topTipperId();

		let entry = this._tippers.get(id);
		if (!entry) {
			entry = { id, label: cleanLabel, total: 0, count: 0, lastTs: 0 };
			this._tippers.set(id, entry);
		}
		entry.label = cleanLabel; // a tipper may refine their display name over a show
		entry.total += safeAmt;
		entry.count += 1;
		entry.lastTs = ts;

		this.totalTipsAtomic += safeAmt;
		this.tipCount += 1;

		const tip = {
			tipperId: id,
			label: cleanLabel,
			amount: safeAmt,
			mint: mint || null,
			signature: signature || null,
			message: cleanText(message, 140),
			ts,
		};
		this._pendingTips.push(tip);
		if (this._pendingTips.length > MAX_PENDING_TIPS) this._pendingTips.shift();

		const isNewTopTipper = this.topTipperId() === id && topBefore !== id;
		return { tip, isNewTopTipper };
	}

	hasPendingTip() {
		return this._pendingTips.length > 0;
	}

	// Pull the next tip to shout out (largest pending first — a whale jumps the
	// queue ahead of a dust tip, which is the crowd-pleasing behaviour).
	takePendingTip() {
		if (!this._pendingTips.length) return null;
		let bestIdx = 0;
		for (let i = 1; i < this._pendingTips.length; i++) {
			if (this._pendingTips[i].amount > this._pendingTips[bestIdx].amount) bestIdx = i;
		}
		const [tip] = this._pendingTips.splice(bestIdx, 1);
		return tip;
	}

	topTipperId() {
		let topId = null;
		let topTotal = -1;
		for (const [id, e] of this._tippers) {
			// Tie-break by earliest lastTs so the leaderboard doesn't flip-flop on
			// equal totals (the one who got there first holds the crown).
			if (e.total > topTotal || (e.total === topTotal && topId && e.lastTs < this._tippers.get(topId).lastTs)) {
				topTotal = e.total;
				topId = id;
			}
		}
		return topId;
	}

	/**
	 * Ranked leaderboard, highest total first. Ties broken by who reached the
	 * total first (earlier lastTs ranks higher). Capped to `limit`.
	 */
	leaderboard(limit = 10) {
		return [...this._tippers.values()]
			.sort((a, b) => b.total - a.total || a.lastTs - b.lastTs)
			.slice(0, limit)
			.map((e) => ({ id: e.id, label: e.label, total: e.total, count: e.count }));
	}

	// ── questions ────────────────────────────────────────────────────────────
	/**
	 * Queue an audience question. Returns false when the queue is full or the
	 * text is empty/duplicate, so the room can tell the asker their question
	 * didn't make it (every state designed).
	 */
	queueQuestion({ id, from, text, ts = 0 }) {
		const clean = cleanText(text, QUESTION_MAX_LEN);
		if (!clean) return false;
		if (this._questionQueue.length >= MAX_QUESTION_QUEUE) return false;
		const qid = String(id || `${from}:${ts}`).slice(0, 80);
		if (this._seenQuestionIds.has(qid)) return false;
		this._seenQuestionIds.add(qid);
		this._questionQueue.push({ id: qid, from: cleanText(from, 48) || 'someone', text: clean, ts });
		return true;
	}

	hasPendingQuestion() {
		return this._questionQueue.length > 0;
	}

	pendingQuestionCount() {
		return this._questionQueue.length;
	}

	takeQuestion() {
		return this._questionQueue.shift() || null;
	}

	// ── beat selection ───────────────────────────────────────────────────────
	/**
	 * Decide the next beat the host should perform. Priority:
	 *   1. opener (once, at show start)
	 *   2. tip shoutout (a fresh tip is always acknowledged fast — that's the loop)
	 *   3. answer a queued question (audience gets the floor)
	 *   4. game round / banter, alternating so the show has rhythm
	 *
	 * Returns { kind, tip?, question? } — the room turns this into a brain prompt.
	 * Pure: same inputs → same decision, which the test suite pins.
	 */
	nextBeat() {
		if (!this._spokenOpener) {
			return { kind: BEAT.OPENER };
		}
		if (this.hasPendingTip()) {
			return { kind: BEAT.TIP_SHOUTOUT, tip: this.takePendingTip() };
		}
		if (this.hasPendingQuestion()) {
			return { kind: BEAT.ANSWER, question: this.takeQuestion() };
		}
		// No urgent input — alternate game and banter so two fillers never repeat.
		const last = this._recentBeats[this._recentBeats.length - 1];
		const kind = last === BEAT.GAME ? BEAT.BANTER : BEAT.GAME;
		return { kind };
	}

	// Record that a beat was performed (the room calls this after it broadcasts the
	// utterance) so opener fires once and filler alternates.
	markSpoken(kind) {
		if (kind === BEAT.OPENER) this._spokenOpener = true;
		this._recentBeats.push(kind);
		if (this._recentBeats.length > MAX_RECENT_BEATS) this._recentBeats.shift();
	}

	recentBeats() {
		return [...this._recentBeats];
	}

	// A compact snapshot of show standings for the host brain prompt + the client
	// HUD. Returned to the room, never carries raw wallet/device ids beyond the
	// stable tipper key the leaderboard already exposes.
	standings() {
		return {
			format: this.format,
			totalTipsAtomic: this.totalTipsAtomic,
			tipCount: this.tipCount,
			peakAudience: this.peakAudience,
			leaderboard: this.leaderboard(),
			pendingQuestions: this.pendingQuestionCount(),
		};
	}
}

// Collapse arbitrary caller text to a bounded, single-line, control-char-free
// string. Shared by every text field the director stores so nothing unbounded or
// newline-laden reaches a prompt or a broadcast.
function cleanText(v, max) {
	if (typeof v !== 'string') return '';
	// Strip control characters (incl. newlines) so nothing multi-line or unprintable
	// reaches a brain prompt or a broadcast, then collapse whitespace.
	return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
