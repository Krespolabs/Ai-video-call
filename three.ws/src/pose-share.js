// Compact, URL-safe codec for a canonical pose — the bridge that lets the
// homepage demo hand its exact pose to the full Pose Studio (and back).
//
// A pose is the canonical quaternion shape every rig speaks (see pose-rig.js):
//   { bones: { Hips:[x,y,z,w], … }, rootPosition:{ x, y, z } }
// We pack only the bones actually present, addressing each by its index in
// CANONICAL_BONES, and quantize quaternion components to int16 and root
// translation to millimetres. ~17 bones encodes to a ~220-char hash — small
// enough to live in a URL fragment, lossless to the eye.

import { CANONICAL_BONES } from './pose-rig.js';

const VERSION = 1;
const Q_SCALE = 32767; // quaternion component (−1..1) → int16
const ROOT_SCALE = 1000; // metres → millimetres (int16 reaches ±32.7 m)

const clampI16 = (n) => Math.max(-32768, Math.min(32767, n | 0));

function bytesToB64url(bytes) {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
	let s = str.replace(/-/g, '+').replace(/_/g, '/');
	while (s.length % 4) s += '=';
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function encodePose(pose) {
	const bones = pose?.bones || {};
	const entries = [];
	for (let i = 0; i < CANONICAL_BONES.length; i++) {
		const v = bones[CANONICAL_BONES[i]];
		if (Array.isArray(v) && v.length >= 4) entries.push([i, v]);
	}
	const rp = pose?.rootPosition;
	const hasRoot = !!(rp && (rp.x || rp.y || rp.z));

	const size = 2 + entries.length * 9 + 1 + (hasRoot ? 6 : 0);
	const dv = new DataView(new ArrayBuffer(size));
	let o = 0;
	dv.setUint8(o++, VERSION);
	dv.setUint8(o++, entries.length);
	for (const [idx, v] of entries) {
		dv.setUint8(o++, idx);
		for (let k = 0; k < 4; k++) {
			dv.setInt16(o, clampI16(Math.round(v[k] * Q_SCALE)));
			o += 2;
		}
	}
	dv.setUint8(o++, hasRoot ? 1 : 0);
	if (hasRoot) {
		dv.setInt16(o, clampI16(Math.round((rp.x || 0) * ROOT_SCALE))); o += 2;
		dv.setInt16(o, clampI16(Math.round((rp.y || 0) * ROOT_SCALE))); o += 2;
		dv.setInt16(o, clampI16(Math.round((rp.z || 0) * ROOT_SCALE))); o += 2;
	}
	return bytesToB64url(new Uint8Array(dv.buffer));
}

export function decodePose(str) {
	if (!str) return null;
	try {
		const bytes = b64urlToBytes(str);
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let o = 0;
		if (dv.getUint8(o++) !== VERSION) return null;
		const count = dv.getUint8(o++);
		const bones = {};
		for (let e = 0; e < count; e++) {
			const key = CANONICAL_BONES[dv.getUint8(o++)];
			const q = [];
			for (let k = 0; k < 4; k++) { q.push(dv.getInt16(o) / Q_SCALE); o += 2; }
			// Renormalize — int16 quantization nudges the quaternion off the unit
			// sphere, and three.js expects unit quaternions for clean rotations.
			const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
			if (key) bones[key] = [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
		}
		const pose = { bones };
		if (dv.getUint8(o++)) {
			pose.rootPosition = {
				x: dv.getInt16(o) / ROOT_SCALE,
				y: dv.getInt16(o + 2) / ROOT_SCALE,
				z: dv.getInt16(o + 4) / ROOT_SCALE,
			};
		}
		return pose;
	} catch {
		return null;
	}
}

// Pull a shared pose out of a URL fragment or query (#p=… or ?p=…).
export function decodePoseFromLocation(href = window.location.href) {
	try {
		const url = new URL(href);
		const fromHash = /[#&]p=([^&]+)/.exec(url.hash);
		const raw = fromHash ? fromHash[1] : url.searchParams.get('p');
		return raw ? decodePose(decodeURIComponent(raw)) : null;
	} catch {
		return null;
	}
}
