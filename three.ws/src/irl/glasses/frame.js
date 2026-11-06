// src/irl/glasses/frame.js — Brilliant Labs Frame adapter.
//
// Frame is the cleanest companion target: first-party, fully documented, a single BLE
// peripheral, and a 640×400 colour micro-OLED. It runs an on-device Lua interpreter
// reachable over a Nordic-UART-style custom GATT service — we write UTF-8 Lua to TX and
// the device evaluates it, so rendering the HUD is just streaming a handful of
// frame.display.text(...) calls and a frame.display.show() flip.
//
// GATT (docs.brilliant.xyz/frame/frame-sdk-bluetooth-specs):
//   service 7A230001-5475-A6A4-654C-8431F6AD49C4
//   TX (write, host→Frame)    7A230002-…
//   RX (notify, Frame→host)   7A230003-…
// A plain UTF-8 write is evaluated as a Lua chunk; a write prefixed with 0x01 is raw
// data, 0x03 is a break (interrupt the running script), 0x04 a reset. We send a break
// before our first frame so any default app loop on the device stops fighting us for
// the display.

import { GattPort } from './transport.js';
import { frameLuaStatements } from './protocol.js';

const SERVICE = '7a230001-5475-a6a4-654c-8431f6ad49c4';
const TX = '7a230002-5475-a6a4-654c-8431f6ad49c4';
const RX = '7a230003-5475-a6a4-654c-8431f6ad49c4';

const SIGNAL_BREAK = 0x03; // interrupt the currently-running Lua loop on the device

export class FrameGlasses {
	static id = 'frame';
	static label = 'Brilliant Labs Frame';
	static experimental = false;
	static tagline = 'Colour micro-OLED · official SDK · single pairing';

	constructor() {
		this.port = new GattPort({
			serviceUuid: SERVICE,
			txUuid: TX,
			rxUuid: RX,
			filters: [{ services: [SERVICE] }, { namePrefix: 'Frame' }],
			optionalServices: [SERVICE],
		});
		this._onClose = null;
	}

	// Step 1 — open the chooser (inside the connect button's click handler).
	async request() {
		return this.port.request();
	}

	// Step 2 — connect GATT and quiet any on-device app loop so we own the display.
	async connect({ onClose } = {}) {
		this._onClose = onClose || null;
		await this.port.connect({ onClose: (r) => this._onClose?.(r) });
		// Break any running default loop, then clear to a known blank frame.
		try { await this.port.write(new Uint8Array([SIGNAL_BREAK])); } catch { /* non-fatal */ }
		await this.clear();
		return this;
	}

	// Render a HUD model: one BLE write per Lua statement, ending with show(). Each
	// statement is a standalone chunk Frame evaluates independently — text() calls
	// accumulate in the back buffer and show() presents them atomically.
	async render(model) {
		const stmts = frameLuaStatements(model);
		for (const stmt of stmts) {
			await this.port.writeString(stmt);
		}
	}

	async clear() {
		await this.port.writeString('frame.display.text(" ",1,1)');
		await this.port.writeString('frame.display.show()');
	}

	async disconnect() {
		try { await this.clear(); } catch { /* device may already be gone */ }
		await this.port.disconnect();
	}

	get connected() {
		return !!this.port.connected;
	}

	get deviceName() {
		return this.port.name || FrameGlasses.label;
	}
}
