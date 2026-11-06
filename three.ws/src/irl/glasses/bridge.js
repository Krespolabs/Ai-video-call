// src/irl/glasses/bridge.js — the /irl ⇄ smart-glasses controller.
//
// One long-lived object irl.js holds. It owns the active device adapter, turns the
// live proximity read into HUD frames, and rate-limits the BLE writes so a 60 fps
// render loop never floods a 3 Hz display. The adapters (frame.js, g1.js) know how to
// talk to one device; this knows WHEN to push, WHAT changed, and how to recover from a
// dropped link — mirroring IrlNet's status-event shape so the two transports read the
// same to callers.

import { buildHud, buildAnnouncement, hudSignature } from './protocol.js';
import { FrameGlasses } from './frame.js';
import { G1Glasses } from './g1.js';
import { glassesSupport } from './transport.js';
import { log } from '../../shared/log.js';

// Devices offered in the connect UI, in priority order (best-supported first).
export const GLASSES_DEVICES = [FrameGlasses, G1Glasses];

const MIN_PUSH_MS = 333;    // ≈3 Hz ceiling on display writes — smooth, never flooding
const HEARTBEAT_MS = 4000;  // resend an unchanged frame this often (recovers a dropped write)
const ANNOUNCE_MS = 3500;   // how long a transient announcement holds the lens

export class GlassesBridge {
	constructor() {
		this.adapter = null;
		this.status = 'idle'; // idle | connecting | connected | error
		this.error = null;
		this.lastModel = null; // last frame pushed — backs the connect-UI live preview
		this._handlers = { status: new Set() };
		this._lastSig = '';
		this._lastPushAt = 0;
		this._announceUntil = 0;
		this._sending = false; // single-flight: never overlap BLE writes
		this._pending = null;  // frame to render once the in-flight write finishes
		this._destroyed = false;
	}

	static support() {
		return glassesSupport();
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`GlassesBridge: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { log.error(`[glasses] ${event} handler threw:`, e); }
		}
	}

	_setStatus(status, error = null) {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error, deviceName: this.deviceName });
	}

	get connected() {
		return this.status === 'connected' && !!this.adapter?.connected;
	}

	get deviceName() {
		return this.adapter?.deviceName || '';
	}

	// What irl.js stamps on interaction telemetry so an owner can tell a glasses
	// encounter from a phone one.
	deviceType() {
		return this.connected ? 'glasses' : 'phone';
	}

	// The connect UI hands a fully-paired adapter here (Frame: one step; G1: after both
	// arms). We mark connected, wire the disconnect callback, and clear the frame cache
	// so the first push always renders.
	attach(adapter) {
		this.adapter = adapter;
		this._lastSig = '';
		this._lastPushAt = 0;
		this._announceUntil = 0;
		// An UNEXPECTED drop (arm out of range, battery dead) → surface 'error' so the UI
		// offers reconnect. An intentional disconnect() detaches before this can fire.
		adapter._onClose = (reason) => {
			if (this._destroyed || this.adapter !== adapter) return;
			this._setStatus('error', reason || 'disconnected');
		};
		this._setStatus('connected');
	}

	_setConnecting() {
		this._setStatus('connecting');
	}

	/**
	 * Push the live proximity read to the lens. Cheap to call every frame: it early-outs
	 * when not connected, while an announcement holds the screen, under the rate limit,
	 * and when the frame is byte-identical to the last (until the heartbeat re-asserts).
	 * @param {{nearest:object|null, count:number}} raw
	 */
	pushState(raw) {
		if (!this.connected) return;
		const now = Date.now();
		if (now < this._announceUntil) return;
		if (now - this._lastPushAt < MIN_PUSH_MS) return;

		const model = buildHud(raw || {});
		const sig = hudSignature(model);
		const unchanged = sig === this._lastSig;
		if (unchanged && now - this._lastPushAt < HEARTBEAT_MS) return;

		this.lastModel = model;
		this._lastPushAt = now;
		this._lastSig = sig;
		this._enqueue(model);
	}

	// Flash a transient line (e.g. arrival cue), then let the next pushState revert to
	// the live HUD once the hold elapses. The arrival flash is the headline feature, so
	// it must never be lost: if a write is in flight it's queued, not dropped.
	announce(text) {
		if (!this.connected) return;
		const model = buildAnnouncement(text);
		this.lastModel = model;
		this._announceUntil = Date.now() + ANNOUNCE_MS;
		this._lastSig = ''; // force the post-announcement frame to re-render
		this._enqueue(model);
	}

	// Single-flight with a one-slot queue: at most one BLE write runs at a time, and the
	// latest frame requested during a write is flushed the moment it completes — so a
	// fast arrival cue lands right after the frame it interrupted instead of vanishing.
	_enqueue(model) {
		if (this._sending) { this._pending = model; return; }
		this._render(model);
	}

	async _render(model) {
		this._sending = true;
		try {
			await this.adapter.render(model);
		} catch (e) {
			log.warn('[glasses] render failed:', e?.message || e);
		} finally {
			this._sending = false;
			const next = this._pending;
			this._pending = null;
			if (next && this.connected) this._render(next);
		}
	}

	// Intentional teardown — detach the drop handler so it doesn't fire 'error', clear
	// the lens, drop the adapter, settle to idle.
	async disconnect() {
		const adapter = this.adapter;
		this.adapter = null;
		this._pending = null;
		if (adapter) {
			adapter._onClose = null;
			try { await adapter.disconnect(); } catch { /* best effort */ }
		}
		this.lastModel = null;
		if (!this._destroyed) this._setStatus('idle');
	}

	destroy() {
		this._destroyed = true;
		this.disconnect();
		this._handlers.status.clear();
	}
}
