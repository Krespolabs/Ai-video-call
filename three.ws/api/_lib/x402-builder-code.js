// ERC-8021 Schema 2 builder-code extension for x402.
// Spec: https://eips.ethereum.org/EIPS/eip-8021
// x402 extension shape: /tmp/x402-docs/specs/extensions/builder_code.md
//
// On-chain attribution: when a facilitator settles an x402 payment, the
// settlement tx calldata is suffixed with a CBOR map of attribution fields
// — `a` (app code, set by the app), `s` (service codes, echoed/appended by
// the client), `w` (wallet/facilitator code, set at settlement). Off-chain
// parsers (Coinbase builder rewards, x402scan analytics) decode the suffix
// to attribute volume to the originating app and intermediaries.
//
// This module implements:
//   - declareBuilderCodeExtension({ a, s? })      — for PaymentRequired
//   - declareBuilderCodeOnPayload({ a, s? })      — for PaymentPayload
//   - validateBuilderCode(code)                    — pattern check
//   - encodeBuilderCodeSuffix({ a, w?, s? })       — CBOR + ERC-8021 frame
//   - parseBuilderCodeSuffix(calldata)             — decode from tx data
//   - verifyClientEcho({ required, payload })      — anti-tampering check
//
// The ERC-8021 Schema 2 suffix wire-format (read end of calldata backwards):
//   [ cborData ][ cborLength : 2B BE ][ schemaId : 0x02 ][ ercMarker : 16B ]
// Marker = constant 80218021_80218021_80218021_80218021 (16 bytes).

import { decode as cborDecode, encode as cborEncode } from 'cborg';

export const BUILDER_CODE = 'builder-code';

// Pattern from ERC-8021 + builder_code.md: lowercase alnum + underscore, 1-32.
const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

// 16-byte ERC-8021 marker (8x repetition of 0x8021).
const ERC8021_MARKER_HEX = '80218021802180218021802180218021';
const ERC8021_MARKER_BYTES = hexToBytes(ERC8021_MARKER_HEX);
const SCHEMA_ID = 0x02;

// JSON Schema (Draft 2020-12) the spec attaches to the extension `info` block.
const BUILDER_CODE_SCHEMA = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		a: {
			type: 'string',
			pattern: '^[a-z0-9_]{1,32}$',
			description: 'App builder code',
		},
		w: {
			type: 'string',
			pattern: '^[a-z0-9_]{1,32}$',
			description: 'Wallet builder code',
		},
		s: {
			type: 'array',
			items: { type: 'string', pattern: '^[a-z0-9_]{1,32}$' },
			description: 'Service builder codes',
		},
	},
	additionalProperties: false,
});

export function isValidBuilderCode(code) {
	return typeof code === 'string' && BUILDER_CODE_PATTERN.test(code);
}

export function assertValidBuilderCode(code, label = 'builder code') {
	if (!isValidBuilderCode(code)) {
		throw new Error(
			`invalid ${label}: must match ^[a-z0-9_]{1,32}$ (got ${JSON.stringify(code)})`,
		);
	}
}

function validateServices(services, label = 's') {
	if (services == null) return undefined;
	if (!Array.isArray(services)) {
		throw new Error(`${label} must be an array of builder codes`);
	}
	for (const s of services) assertValidBuilderCode(s, `${label} entry`);
	return services.length ? [...services] : undefined;
}

// Build the v2 extension entry the server attaches to `PaymentRequired`.
//
//   extensions: { [BUILDER_CODE]: declareBuilderCodeExtension({ a, s? }) }
//
// `info.a` is the app code that the client MUST echo verbatim in the
// PaymentPayload (see verifyClientEcho). `info.s` is informational only —
// the client supplies the runtime `s` list in its payload.
export function declareBuilderCodeExtension({ a, s } = {}) {
	assertValidBuilderCode(a, 'app builder code (a)');
	const info = { a };
	const services = validateServices(s, 'declared services (s)');
	if (services) info.s = services;
	return {
		info,
		schema: BUILDER_CODE_SCHEMA,
	};
}

// Build the `extensions[BUILDER_CODE]` block the client puts in its
// `PaymentPayload`. Client echoes the app code and may append its own
// service codes. The wallet code `w` is NOT set here — the facilitator
// fills it at settlement.
export function declareBuilderCodeOnPayload({ a, s } = {}) {
	assertValidBuilderCode(a, 'app builder code (a)');
	const out = { a };
	const services = validateServices(s, 'service codes (s)');
	if (services) out.s = services;
	return out;
}

// Concatenate Uint8Arrays.
function concatBytes(arrays) {
	let len = 0;
	for (const a of arrays) len += a.length;
	const out = new Uint8Array(len);
	let off = 0;
	for (const a of arrays) {
		out.set(a, off);
		off += a.length;
	}
	return out;
}

function hexToBytes(hex) {
	const clean = String(hex || '').replace(/^0x/i, '');
	if (clean.length % 2) throw new Error('hex string has odd length');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function bytesToHex(bytes) {
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, '0');
	}
	return out;
}

function bytesEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// Encode the ERC-8021 Schema 2 suffix for the given attribution fields.
// Returns a Uint8Array; callers append it to settlement-tx calldata.
//
// Wire order (left-to-right as written into calldata):
//   [cborData][cborLength (2B BE)][schemaId (1B)][ercMarker (16B)]
//
// `a` is required; `w` and `s` are optional. CBOR map key order matches the
// spec examples (`a` → `s` → `w`).
export function encodeBuilderCodeSuffix({ a, w, s } = {}) {
	assertValidBuilderCode(a, 'app builder code (a)');
	const services = validateServices(s, 'service codes (s)');
	const map = { a };
	if (services) map.s = services;
	if (w !== undefined) {
		assertValidBuilderCode(w, 'wallet builder code (w)');
		map.w = w;
	}
	const cborData = cborEncode(map);
	if (cborData.length > 0xffff) {
		throw new Error(`builder-code CBOR too large: ${cborData.length} > 65535`);
	}
	const cborLength = new Uint8Array(2);
	cborLength[0] = (cborData.length >> 8) & 0xff;
	cborLength[1] = cborData.length & 0xff;
	const schemaIdByte = new Uint8Array([SCHEMA_ID]);
	return concatBytes([cborData, cborLength, schemaIdByte, ERC8021_MARKER_BYTES]);
}

export function encodeBuilderCodeSuffixHex(fields) {
	return bytesToHex(encodeBuilderCodeSuffix(fields));
}

// Parse the ERC-8021 Schema 2 suffix from a hex-encoded calldata blob
// (with or without `0x` prefix). Returns null when the suffix is absent
// or malformed — callers should treat this as "no attribution" rather
// than an error, since non-x402 calldata won't carry the marker.
export function parseBuilderCodeSuffix(calldataHexOrBytes) {
	let bytes;
	if (typeof calldataHexOrBytes === 'string') {
		try {
			bytes = hexToBytes(calldataHexOrBytes);
		} catch {
			return null;
		}
	} else if (calldataHexOrBytes instanceof Uint8Array) {
		bytes = calldataHexOrBytes;
	} else if (Array.isArray(calldataHexOrBytes)) {
		bytes = Uint8Array.from(calldataHexOrBytes);
	} else {
		return null;
	}
	if (bytes.length < 16 + 1 + 2) return null;
	const markerStart = bytes.length - 16;
	const marker = bytes.subarray(markerStart);
	if (!bytesEqual(marker, ERC8021_MARKER_BYTES)) return null;
	const schemaId = bytes[markerStart - 1];
	if (schemaId !== SCHEMA_ID) return null;
	const cborLen = (bytes[markerStart - 3] << 8) | bytes[markerStart - 2];
	const cborStart = markerStart - 3 - cborLen;
	if (cborStart < 0) return null;
	const cborData = bytes.subarray(cborStart, markerStart - 3);
	let decoded;
	try {
		decoded = cborDecode(cborData);
	} catch {
		return null;
	}
	if (!decoded || typeof decoded !== 'object') return null;
	const out = {};
	if (typeof decoded.a === 'string') out.a = decoded.a;
	if (typeof decoded.w === 'string') out.w = decoded.w;
	if (Array.isArray(decoded.s)) {
		out.s = decoded.s.filter((x) => typeof x === 'string');
	}
	out.schemaId = schemaId;
	out.cborLength = cborLen;
	return out;
}

// Anti-tampering: the facilitator MUST verify the `a` echoed in the payload
// matches the `a` declared on the route. A mismatch indicates the client
// tampered with attribution; reject the payment.
export function verifyClientEcho({ required, payload }) {
	if (!required || !required.info || !required.info.a) return { ok: true };
	const declaredA = required.info.a;
	const echoedA = payload?.a;
	if (echoedA === undefined) {
		return {
			ok: false,
			reason: `builder-code: client did not echo app code "${declaredA}"`,
		};
	}
	if (echoedA !== declaredA) {
		return {
			ok: false,
			reason: `builder-code: client echoed "${echoedA}" but app declared "${declaredA}"`,
		};
	}
	if (payload.s !== undefined) {
		try {
			validateServices(payload.s, 'service codes (s)');
		} catch (err) {
			return { ok: false, reason: `builder-code: ${err.message}` };
		}
	}
	return { ok: true };
}

export const ERC8021 = Object.freeze({
	MARKER_HEX: ERC8021_MARKER_HEX,
	MARKER_BYTES: ERC8021_MARKER_BYTES,
	SCHEMA_ID,
});
