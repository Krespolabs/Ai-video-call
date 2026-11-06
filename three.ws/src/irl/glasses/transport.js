// src/irl/glasses/transport.js — Web Bluetooth GATT plumbing for the glasses bridge.
//
// The device adapters (frame.js, g1.js) speak in HUD models + bytes; this layer is the
// one place that touches navigator.bluetooth. It does three jobs:
//   1. Honest capability detection — Web Bluetooth is Chromium-only (no iOS Safari /
//      WebKit), and only over HTTPS, so the connect UI can show a real "why not here"
//      state instead of a dead button.
//   2. A small GattPort: requestDevice (must be inside a user gesture), connect to one
//      GATT service, write to a TX characteristic (chunked under the MTU), subscribe to
//      an RX notify characteristic, and surface unexpected disconnects.
//   3. Nothing else — no rendering, no protocol. Bytes in, bytes out.

// Conservative write chunk. Web Bluetooth doesn't expose the negotiated ATT MTU, and
// older stacks fall back to 20-byte writes; Chrome on Android negotiates 100s. 180 is
// safe for modern firmware (Frame + G1 both negotiate ≥185) and the adapters keep
// individual writes small anyway, so fragmentation here is rare.
const DEFAULT_CHUNK = 180;

/**
 * Is Web Bluetooth usable in this browser/context, and if not, why?
 * @returns {{ supported: boolean, reason?: 'insecure'|'ios'|'unsupported' }}
 */
export function glassesSupport() {
	if (typeof navigator === 'undefined') return { supported: false, reason: 'unsupported' };
	const ua = navigator.userAgent || '';
	// iPadOS reports a Mac UA but is touch — treat any touch-Mac as iOS for messaging.
	const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	if (!('bluetooth' in navigator) || !navigator.bluetooth) {
		return { supported: false, reason: isIOS ? 'ios' : 'unsupported' };
	}
	// Web Bluetooth requires a secure context (HTTPS or localhost).
	if (typeof window !== 'undefined' && window.isSecureContext === false) {
		return { supported: false, reason: 'insecure' };
	}
	return { supported: true };
}

/**
 * One GATT connection to one device + service. Stateless about WHAT it carries — the
 * adapter owns the protocol; this owns the socket.
 */
export class GattPort {
	/**
	 * @param {object} cfg
	 * @param {string} cfg.serviceUuid   primary service to connect to
	 * @param {string} cfg.txUuid        characteristic we WRITE to (host → device)
	 * @param {string} [cfg.rxUuid]      characteristic we SUBSCRIBE to (device → host)
	 * @param {object[]} cfg.filters     requestDevice() filters (services / namePrefix)
	 * @param {string[]} [cfg.optionalServices] extra services to grant access to
	 * @param {number} [cfg.chunk]       write chunk size in bytes
	 */
	constructor(cfg) {
		this.cfg = cfg;
		this.chunk = cfg.chunk || DEFAULT_CHUNK;
		this.device = null;
		this.server = null;
		this.tx = null;
		this.rx = null;
		this.connected = false;
		this._onClose = null;
		this._onData = null;
		this._onDisc = this._handleDisconnect.bind(this);
		this._notifyHandler = this._handleNotify.bind(this);
	}

	// Open the browser device chooser. MUST run inside a user gesture (a click). Throws
	// a DOMException with name 'NotFoundError' when the user dismisses the chooser — the
	// caller treats that as a cancel, not an error.
	async request() {
		if (!navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser.');
		const optionalServices = Array.from(
			new Set([this.cfg.serviceUuid, ...(this.cfg.optionalServices || [])]),
		);
		this.device = await navigator.bluetooth.requestDevice({
			filters: this.cfg.filters,
			optionalServices,
		});
		return { id: this.device.id, name: this.device.name || '' };
	}

	/**
	 * Connect the GATT server, resolve the TX/RX characteristics, and start RX notifies.
	 * @param {object} [opts]
	 * @param {(reason:string)=>void} [opts.onClose] called on an UNEXPECTED disconnect
	 * @param {(bytes:Uint8Array)=>void} [opts.onData] called with each RX notification
	 */
	async connect({ onClose, onData } = {}) {
		if (!this.device) throw new Error('Call request() before connect().');
		this._onClose = onClose || null;
		this._onData = onData || null;

		this.device.addEventListener('gattserverdisconnected', this._onDisc);
		this.server = await this.device.gatt.connect();
		const service = await this.server.getPrimaryService(this.cfg.serviceUuid);
		this.tx = await service.getCharacteristic(this.cfg.txUuid);

		if (this.cfg.rxUuid) {
			try {
				this.rx = await service.getCharacteristic(this.cfg.rxUuid);
				await this.rx.startNotifications();
				this.rx.addEventListener('characteristicvaluechanged', this._notifyHandler);
			} catch {
				// RX notify is optional telemetry (battery, taps). A device that doesn't
				// expose it still drives the display fine over TX.
				this.rx = null;
			}
		}
		this.connected = true;
		return this;
	}

	// Write raw bytes, fragmented to the chunk size. Prefers write-without-response
	// (throughput) and falls back to acknowledged writes on stacks that reject it.
	async write(bytes) {
		if (!this.connected || !this.tx) throw new Error('Not connected.');
		const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		for (let off = 0; off < buf.length || (buf.length === 0 && off === 0); off += this.chunk) {
			const slice = buf.subarray(off, off + this.chunk);
			await this._writeOne(slice);
			if (buf.length === 0) break; // a single zero-length write (e.g. clear)
		}
	}

	// Write a UTF-8 string (used by the Frame Lua transport).
	async writeString(str) {
		const enc = typeof TextEncoder !== 'undefined'
			? new TextEncoder().encode(str)
			: Uint8Array.from(Buffer.from(str, 'utf-8'));
		return this.write(enc);
	}

	async _writeOne(slice) {
		// A fresh BufferSource per call — some implementations retain the view.
		const out = slice.slice();
		if (this.tx.writeValueWithoutResponse) {
			try {
				await this.tx.writeValueWithoutResponse(out);
				return;
			} catch {
				// fall through to acknowledged write
			}
		}
		await this.tx.writeValue(out);
	}

	_handleNotify(ev) {
		if (!this._onData) return;
		const dv = ev.target.value;
		if (!dv) return;
		this._onData(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
	}

	_handleDisconnect() {
		const wasConnected = this.connected;
		this.connected = false;
		this.tx = null;
		this.rx = null;
		this.server = null;
		if (wasConnected && this._onClose) {
			try { this._onClose('disconnected'); } catch { /* swallow */ }
		}
	}

	// Intentional teardown — detaches the disconnect handler first so it doesn't fire
	// the unexpected-close path.
	async disconnect() {
		this.connected = false;
		const device = this.device;
		if (device) {
			device.removeEventListener('gattserverdisconnected', this._onDisc);
			try {
				if (this.rx) {
					this.rx.removeEventListener('characteristicvaluechanged', this._notifyHandler);
					await this.rx.stopNotifications().catch(() => {});
				}
			} catch { /* best effort */ }
			try { device.gatt?.connected && device.gatt.disconnect(); } catch { /* best effort */ }
		}
		this.tx = null;
		this.rx = null;
		this.server = null;
	}

	get name() {
		return this.device?.name || '';
	}
}
