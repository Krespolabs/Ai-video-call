// IRL World Lines — proof-of-presence cryptography + ceremony helpers.
//
// A World Line is a location-anchored AR quest left by an agent. To complete it a
// person must physically travel to the spot, prove co-location, and finish an
// agent-driven AR interaction. On success the agent's own wallet SIGNS a
// proof-of-presence — a tamper-evident attestation that "this visitor was in this
// coarse place at this time and did this thing" — which mints a verifiable
// collectible to the visitor.
//
// This module is the security core. It is deliberately PURE (no DB, no network) so
// every guarantee is unit-testable in isolation:
//
//   · canonicalProofMessage()  — the exact bytes the agent signs / a verifier checks.
//   · signPresenceProof()      — agent wallet (ed25519) signs the canonical message.
//   · verifyPresenceProof()    — anyone re-checks the signature against the agent
//                                public key. This is what GET /verify/:proofId runs,
//                                and what makes the collectible independently genuine.
//   · mintPresenceNonce()      — server issues a short-lived, HMAC-bound nonce tying a
//                                completion attempt to (world_line_id, coarse_cell,
//                                time-window). Stateless (no DB), like the fix token.
//   · verifyPresenceNonce()    — re-checks the nonce is unforged, unexpired, and bound
//                                to the world line + cell the completion claims.
//
// PRIVACY INVARIANT (inherited from api/irl/pins.js + multiplayer/src/geohash.js):
// nothing in a proof, a nonce, or any value this module produces is finer than the
// coarse (~1.1 km, precision-6) geocell. No precise lat/lng ever enters a signed
// payload, a nonce, or a log line. The completer is identified only by a salted hash,
// never a raw device token.

import { webcrypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { hmacSha256, sha256, constantTimeEquals } from './crypto.js';
import { encodeGeohash } from './geohash.js';

// ── Coarse cell ──────────────────────────────────────────────────────────────
// The privacy unit for World Lines is the precision-6 geocell (~1.2 km × 0.6 km) —
// the SAME cell the realtime IrlRoom uses, deliberately coarser than the precision-7
// (~150 m) density cell pins use. A proof binds to this cell, never to a coordinate,
// so "where a completion happened" never resolves finer than "somewhere in this
// ~1 km cell." A precision-7 cell is a strict refinement of its precision-6 parent
// (geohash is hierarchical), so cell6 === cell7.slice(0, 6).
export const COARSE_CELL_PRECISION = 6;

export function coarseCell(lat, lng) {
	return encodeGeohash(lat, lng, COARSE_CELL_PRECISION);
}

// A coarse cell is a precision-6 geohash: 6 chars from the geohash base32 alphabet
// (no a/i/l/o). Validate before it reaches a query or a signed payload.
const COARSE_CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/;
export function isCoarseCell(v) {
	return typeof v === 'string' && COARSE_CELL_RE.test(v);
}

// ── Challenge spec ───────────────────────────────────────────────────────────
// The agent-driven interaction the visitor completes in AR. Kept small and fully
// validated — it is creator-supplied free-ish content rendered to every visitor, so
// it is clamped the same way a pin caption is. The server never "grades" the AR
// interaction byte-for-byte (it cannot observe the AR session); co-location + the
// single-use nonce are the anti-cheat. The spec only shapes the client experience.
export const CHALLENGE_KINDS = new Set(['tap', 'phrase', 'quiz']);
export const PROMPT_MAX = 240;     // the line the agent speaks in AR
export const PHRASE_MAX = 80;      // a passphrase / quiz answer the visitor must give
export const TITLE_MAX = 80;
const QUIZ_CHOICE_MAX = 60;
const QUIZ_MAX_CHOICES = 4;

// Normalize + validate a challenge spec. Returns { ok, spec } or { ok:false, error }.
// `tap`    — walk up, tap the agent (presence is the whole challenge).
// `phrase` — the agent asks the visitor to say/echo a passphrase the creator set.
// `quiz`   — the agent poses a one-line question with up to 4 choices; one is correct.
export function normalizeChallengeSpec(raw) {
	const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	const kind = CHALLENGE_KINDS.has(input.kind) ? input.kind : 'tap';
	const prompt = clampText(input.prompt, PROMPT_MAX);
	const spec = { kind, prompt: prompt || null };

	if (kind === 'phrase') {
		const phrase = clampText(input.phrase, PHRASE_MAX);
		if (!phrase) return { ok: false, error: 'a phrase challenge needs a passphrase' };
		// Store the answer ONLY as a normalized hash-friendly form; the client compares
		// the visitor's spoken/typed answer locally, so the answer travels to the device
		// that must satisfy it (the creator chose to gate on it). Case/space-insensitive.
		spec.phrase = normalizeAnswer(phrase);
	} else if (kind === 'quiz') {
		const question = clampText(input.question, PROMPT_MAX);
		if (!question) return { ok: false, error: 'a quiz challenge needs a question' };
		const choices = Array.isArray(input.choices)
			? input.choices.map((c) => clampText(c, QUIZ_CHOICE_MAX)).filter(Boolean)
			: [];
		if (choices.length < 2) return { ok: false, error: 'a quiz needs at least two choices' };
		const trimmed = choices.slice(0, QUIZ_MAX_CHOICES);
		const answerIdx = Number.isInteger(input.answer) ? input.answer : -1;
		if (answerIdx < 0 || answerIdx >= trimmed.length) {
			return { ok: false, error: 'a quiz needs a valid correct-answer index' };
		}
		spec.question = question;
		spec.choices = trimmed;
		spec.answer = answerIdx;
	}
	return { ok: true, spec };
}

function clampText(v, max) {
	if (v == null) return '';
	return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}
function normalizeAnswer(v) {
	return String(v).toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Reward kinds ─────────────────────────────────────────────────────────────
// The collectible is the headline reward (the agent-signed proof itself, surfaced as
// an ownable "I was there" item). 'three_pool' funds a $THREE prize split among the
// first N completers — $THREE is the ONLY coin a value reward may ever reference.
export const REWARD_KINDS = new Set(['collectible', 'three_pool']);
export function normalizeRewardKind(v) {
	return REWARD_KINDS.has(v) ? v : 'collectible';
}

export const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
export function normalizeDifficulty(v) {
	return DIFFICULTIES.has(v) ? v : 'easy';
}

// ── The signed proof-of-presence message ─────────────────────────────────────
// The EXACT, canonical bytes the agent wallet signs and a verifier re-checks. Domain-
// separated and versioned so a signature can never be replayed as a different kind of
// attestation. Order is fixed; every field is coarse or a hash — never a coordinate,
// never a raw identifier.
//
//   three.ws/world-line-presence:v1|wl=<id>|cell=<coarseCell>|nonce=<nonceId>|who=<completerHash>
//
// `completerHash` is a salted SHA-256 of the completer's stable id (device token or
// user id) — present so the proof is bound to ONE visitor (you can't lift another
// person's signed proof and claim it) without the signed bytes ever carrying the raw
// device token.
export const PROOF_DOMAIN = 'three.ws/world-line-presence:v1';

export function canonicalProofMessage({ worldLineId, coarseCell, nonceId, completerHash }) {
	return [
		PROOF_DOMAIN,
		`wl=${worldLineId}`,
		`cell=${coarseCell}`,
		`nonce=${nonceId}`,
		`who=${completerHash}`,
	].join('|');
}

// Salted hash of a completer's stable id. The salt (a server secret) means the hash
// can't be reversed to the device token by dictionary attack, while staying stable so
// the same visitor maps to the same hash (for "you already completed this" + the
// visitor's own collectible list). Falls back to a fixed dev salt when unset so local
// testing works; production sets WORLD_LINE_SECRET.
export async function completerHash(stableId) {
	const salt = nonceSecret();
	return (await sha256(`wlc:${salt}:${String(stableId ?? '')}`)).slice(0, 32);
}

// Sign the canonical proof message with an agent's ed25519 key. `secretKey` is the
// 64-byte @solana/web3.js secret key (32-byte seed + 32-byte pubkey) recovered via
// recoverSolanaAgentKeypair; we sign with the 32-byte seed. Returns the detached
// signature + the signer public key, both base58 (the on-the-wire proof shape).
export function signPresenceProof({ secretKey, message }) {
	const sk = toBytes(secretKey);
	if (sk.length !== 64 && sk.length !== 32) {
		throw new Error('signPresenceProof: secretKey must be a 32- or 64-byte ed25519 key');
	}
	const seed = sk.length === 64 ? sk.slice(0, 32) : sk;
	const msgBytes = new TextEncoder().encode(message);
	const sig = ed25519.sign(msgBytes, seed);
	const pub = ed25519.getPublicKey(seed);
	return { signature: bs58.encode(sig), signerPubkey: bs58.encode(pub) };
}

// Independently verify a proof: does `signature` (base58) over the canonical message
// validate against `signerPubkey` (base58)? Never throws — a malformed signature or
// key returns false. This is the whole basis of GET /verify/:proofId: anyone holding
// the agent's public key can confirm the collectible is genuine.
export function verifyPresenceProof({ signerPubkey, message, signature }) {
	try {
		const pub = bs58.decode(String(signerPubkey));
		if (pub.length !== 32) return false;
		const sig = bs58.decode(String(signature));
		if (sig.length !== 64) return false;
		const msgBytes = new TextEncoder().encode(message);
		return ed25519.verify(sig, msgBytes, pub);
	} catch {
		return false;
	}
}

// ── The completion nonce (server-issued, stateless, HMAC-bound) ───────────────
// A nonce ties a completion attempt to a specific world line + coarse cell + time
// window. The server mints it only AFTER server-derived co-location succeeds, so
// holding a valid nonce is itself evidence the holder was at the spot. It carries a
// random component so each attempt is unique → the DB stores the nonce id under a
// UNIQUE constraint, making completion idempotent and replay-proof per nonce.
//
// Shape (compact, URL-safe, no DB): base64url(JSON) + '.' + base64url(HMAC).
//   payload = { w: worldLineId, c: coarseCell, r: random16, iat: issuedAtSec }
export const NONCE_TTL_SEC = 300;        // 5 min — long enough to finish the AR interaction.
const NONCE_FUTURE_SKEW_SEC = 60;        // tolerate minor client/server clock skew.
const NONCE_SECRET_ENV = 'WORLD_LINE_SECRET';
// Stable, deliberately non-secret dev/preview key. Keeps mint+verify self-consistent
// without a configured secret so local testing isn't blocked. NOT a security boundary:
// production MUST set WORLD_LINE_SECRET (a token minted under the dev key won't verify
// once a real secret is configured). Never empty — a zero-length HMAC key throws.
const NONCE_DEV_SECRET = 'world-line:dev+preview-unsecured-key:not-for-production';

export function nonceEnforced() {
	const s = process.env[NONCE_SECRET_ENV];
	return typeof s === 'string' && s.length >= 16;
}
function nonceSecret() {
	return nonceEnforced() ? process.env[NONCE_SECRET_ENV] : NONCE_DEV_SECRET;
}

function b64urlEncode(str) {
	return Buffer.from(str, 'utf8').toString('base64')
		.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
	const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
	return Buffer.from(String(str).replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64').toString('utf8');
}
function randomHex(bytes = 12) {
	const b = new Uint8Array(bytes);
	(globalThis.crypto || webcrypto).getRandomValues(b);
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// The nonce id is the stable, storable identity of a nonce: the HMAC of its payload.
// Unique per mint (the random component guarantees it), short enough for a UNIQUE
// index, and what the signed proof + the DB idempotency key both key on.
export async function mintPresenceNonce(worldLineId, cell, nowSec = Math.floor(Date.now() / 1000)) {
	if (typeof worldLineId !== 'string' || !worldLineId) return null;
	if (!isCoarseCell(cell)) return null;
	const payload = { w: worldLineId, c: cell, r: randomHex(12), iat: nowSec };
	const json = JSON.stringify(payload);
	const sig = await hmacSha256(nonceSecret(), json);
	return {
		nonce: `${b64urlEncode(json)}.${sig}`,
		nonceId: sig.slice(0, 32),
		expires_in: NONCE_TTL_SEC,
	};
}

// Verify a nonce authorises a completion of `worldLineId` in `cell`. Returns
// { ok:true, nonceId } or { ok:false, reason }.
//   reason: 'missing' | 'malformed' | 'forged' | 'expired' | 'mismatch'
export async function verifyPresenceNonce(nonce, worldLineId, cell, nowSec = Math.floor(Date.now() / 1000)) {
	if (typeof nonce !== 'string' || !nonce.length) return { ok: false, reason: 'missing' };
	const dot = nonce.indexOf('.');
	if (dot <= 0 || dot === nonce.length - 1) return { ok: false, reason: 'malformed' };
	const encPayload = nonce.slice(0, dot);
	const sig = nonce.slice(dot + 1);

	let json;
	try {
		json = b64urlDecode(encPayload);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const expected = await hmacSha256(nonceSecret(), json);
	if (!constantTimeEquals(sig, expected)) return { ok: false, reason: 'forged' };

	let payload;
	try {
		payload = JSON.parse(json);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const { w, c, iat } = payload || {};
	if (typeof w !== 'string' || !isCoarseCell(c) || !Number.isFinite(iat)) {
		return { ok: false, reason: 'malformed' };
	}
	if (nowSec - iat > NONCE_TTL_SEC || iat - nowSec > NONCE_FUTURE_SKEW_SEC) {
		return { ok: false, reason: 'expired' };
	}
	// Bind the nonce to the world line + cell the completion claims — a nonce minted
	// for one quest/cell can't be spent on another.
	if (w !== worldLineId || c !== cell) return { ok: false, reason: 'mismatch' };
	return { ok: true, nonceId: sig.slice(0, 32) };
}

function toBytes(v) {
	if (v instanceof Uint8Array) return v;
	if (Array.isArray(v)) return Uint8Array.from(v);
	if (v && typeof v === 'object' && typeof v.length === 'number') return Uint8Array.from(v);
	throw new Error('expected a byte array');
}
