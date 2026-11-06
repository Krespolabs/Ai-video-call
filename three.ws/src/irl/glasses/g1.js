// src/irl/glasses/g1.js — Even Realities G1 adapter (community protocol).
//
// The G1 has no official SDK; this implements the open-source even_glasses protocol
// (github.com/emingenc/even_glasses) — well-characterised but reverse-engineered, so
// the connect UI flags it as experimental. Two quirks shape this adapter:
//
//   1. TWO peripherals. The left and right arms are independent BLE devices, each
//      exposing a Nordic UART Service. Web Bluetooth returns one device per user
//      gesture, so pairing is a two-step flow the connect UI drives: requestArm('left')
//      on one click, requestArm('right') on the next. Display writes go to BOTH arms,
//      left first, so the two halves of the binocular HUD stay in sync.
//   2. Text via the 0x4E command (see protocol.g1TextPackets). The 640×200 green
//      display word-wraps the text block itself, so we send the joined HUD lines.
//
// NUS: service 6E400001-B5A3-F393-E0A9-E50E24DCCA9E, TX …0002 (write), RX …0003 (notify).

import { GattPort } from './transport.js';
import { g1Text, g1TextPackets } from './protocol.js';

const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const ARM_GAP_MS = 60; // small left→right stagger so both arms commit the same frame

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function makeArmPort() {
	return new GattPort({
		serviceUuid: NUS,
		txUuid: NUS_TX,
		rxUuid: NUS_RX,
		// G1 arms advertise as "Even G1_<n>_L_…" / "…_R_…". Web Bluetooth filters only
		// support namePrefix (not contains), so we surface both arms under the shared
		// prefix and the wearer picks left, then right, in the two-step flow.
		filters: [{ namePrefix: 'Even G1_' }, { namePrefix: 'Even' }],
		optionalServices: [NUS],
	});
}

export class G1Glasses {
	static id = 'g1';
	static label = 'Even Realities G1';
	static experimental = true;
	static tagline = 'Green HUD · two-arm pairing · community protocol';
	// The connect UI reads this to render the staged pairing flow.
	static arms = [
		{ side: 'left', label: 'Pair left arm' },
		{ side: 'right', label: 'Pair right arm' },
	];

	constructor() {
		this.ports = { left: null, right: null };
		this._seq = 0;
		this._onClose = null;
	}

	// Open the chooser for one arm (inside a click handler) and connect it immediately,
	// so a half-finished pairing still surfaces a working arm and the UI can advance.
	async requestArm(side, { onClose } = {}) {
		if (side !== 'left' && side !== 'right') throw new Error('arm side must be left or right');
		this._onClose = onClose || this._onClose;
		const port = makeArmPort();
		await port.request();
		await port.connect({ onClose: (r) => this._onClose?.(r, side) });
		this.ports[side] = port;
		return { side, name: port.name };
	}

	get connected() {
		return !!(this.ports.left?.connected && this.ports.right?.connected);
	}

	async render(model) {
		const packets = g1TextPackets(g1Text(model), { seq: this._seq });
		this._seq = (this._seq + 1) & 0xff;
		// Left first, then right — the binocular pair reads as one frame.
		for (const side of ['left', 'right']) {
			const port = this.ports[side];
			if (!port?.connected) continue;
			for (const pkt of packets) {
				await port.write(pkt);
			}
			if (side === 'left') await delay(ARM_GAP_MS);
		}
	}

	async clear() {
		await this.render({ lines: [' ', ' ', ' '] });
	}

	async disconnect() {
		for (const side of ['left', 'right']) {
			try { await this.ports[side]?.disconnect(); } catch { /* best effort */ }
			this.ports[side] = null;
		}
	}

	get deviceName() {
		return G1Glasses.label;
	}
}
