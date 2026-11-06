// D3 — ambient interaction-reaction policy (multiplayer/src/irl-reactions.js).
//
// The room turns a viewer's tap/pay/message into a `reaction` broadcast. These
// tests pin the two rules that protect bystanders from spam without ever dropping a
// high-signal event: (1) only the four known types fan out; (2) open/view are
// debounced per (session, pin) on a fixed window, while pay/message NEVER are. The
// helpers are pure (a plain Map ledger + an injected clock), so the policy is proven
// with no Colyseus room and no real time.

import { describe, it, expect } from 'vitest';

import {
	REACTION_TYPES,
	DEBOUNCED_TYPES,
	REACTION_DEBOUNCE_MS,
	isReactionType,
	reactionAllowed,
	pruneReactionLedger,
} from '../multiplayer/src/irl-reactions.js';

describe('isReactionType', () => {
	it('accepts exactly the four interaction types', () => {
		for (const t of ['open', 'view', 'pay', 'message']) expect(isReactionType(t)).toBe(true);
		expect([...REACTION_TYPES].sort()).toEqual(['message', 'open', 'pay', 'view']);
	});

	it('rejects unknown / malformed types', () => {
		for (const t of ['', 'paid', 'PAY', 'like', 'follow', null, undefined, 0, {}]) {
			expect(isReactionType(t)).toBe(false);
		}
	});
});

describe('reactionAllowed — open/view debounce', () => {
	it('allows the first glance, suppresses a repeat inside the window, allows it after', () => {
		const ledger = new Map();
		const t0 = 1_000_000;
		// First view from this session on this pin → fans out.
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0)).toBe(true);
		// A jittery re-tap 1s later → suppressed.
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0 + 1000)).toBe(false);
		// Just before the window closes → still suppressed.
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0 + REACTION_DEBOUNCE_MS - 1)).toBe(false);
		// After the window → a deliberate re-glance fans out again.
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0 + REACTION_DEBOUNCE_MS)).toBe(true);
	});

	it('debounces open and view as the same noisy class', () => {
		expect([...DEBOUNCED_TYPES].sort()).toEqual(['open', 'view']);
		const ledger = new Map();
		const t0 = 5_000;
		expect(reactionAllowed(ledger, 's1', 'pinA', 'open', t0)).toBe(true);
		// open and view share a ledger key (session+pin), so an immediate view is gated too.
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0 + 100)).toBe(false);
	});

	it('scopes the debounce per session and per pin — never across them', () => {
		const ledger = new Map();
		const t0 = 0;
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0)).toBe(true);
		// Different viewer, same pin → independent.
		expect(reactionAllowed(ledger, 's2', 'pinA', 'view', t0)).toBe(true);
		// Same viewer, different pin → independent.
		expect(reactionAllowed(ledger, 's1', 'pinB', 'view', t0)).toBe(true);
		// The original pair is still gated.
		expect(reactionAllowed(ledger, 's1', 'pinA', 'view', t0 + 10)).toBe(false);
	});
});

describe('reactionAllowed — pay/message are never debounced', () => {
	it('always fans out a pay, even back to back from the same viewer/pin', () => {
		const ledger = new Map();
		const t0 = 42;
		expect(reactionAllowed(ledger, 's1', 'pinA', 'pay', t0)).toBe(true);
		expect(reactionAllowed(ledger, 's1', 'pinA', 'pay', t0)).toBe(true);
		expect(reactionAllowed(ledger, 's1', 'pinA', 'pay', t0 + 1)).toBe(true);
		// And it never writes the debounce ledger, so it can't gate a later glance.
		expect(ledger.size).toBe(0);
	});

	it('always fans out a message', () => {
		const ledger = new Map();
		expect(reactionAllowed(ledger, 's1', 'pinA', 'message', 0)).toBe(true);
		expect(reactionAllowed(ledger, 's1', 'pinA', 'message', 0)).toBe(true);
		expect(ledger.size).toBe(0);
	});

	it('rejects an unknown type regardless of the ledger', () => {
		const ledger = new Map();
		expect(reactionAllowed(ledger, 's1', 'pinA', 'spam', 0)).toBe(false);
	});
});

describe('pruneReactionLedger', () => {
	it('drops only entries older than the window, keeps live ones', () => {
		const ledger = new Map();
		const now = 1_000_000;
		ledger.set('s1 pinA', now - REACTION_DEBOUNCE_MS);       // exactly aged out
		ledger.set('s1 pinB', now - REACTION_DEBOUNCE_MS - 5000); // long expired
		ledger.set('s2 pinA', now - 1000);                        // still live
		pruneReactionLedger(ledger, now);
		expect(ledger.has('s1 pinA')).toBe(false);
		expect(ledger.has('s1 pinB')).toBe(false);
		expect(ledger.has('s2 pinA')).toBe(true);
		expect(ledger.size).toBe(1);
	});
});
