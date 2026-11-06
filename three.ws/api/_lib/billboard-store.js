// Billboard placements — the paid content panel that stands in each 3D
// coin-world (rendered by src/walk.js). One placement per coin-world at a time;
// whoever paid most recently holds the board until their rental expires.
//
// This is a paid community canvas, NOT an ad network: there is no targeting and
// no tracking. A placement is just { image, caption } plus the rental window.
// It lives in Redis with a TTL equal to the rental, so it disappears on its own
// when the slot runs out — no sweeper, no stale boards. Reads fail open (a
// Redis outage shows the world's default content, never an error).

import { getRedis } from './redis.js';

const KEY_PREFIX = 'billboard:';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_CAPTION = 80;
const MAX_URL = 1024;

// One purchase buys the board for this many hours. Paying again resets the TTL,
// so a holder extends simply by buying another slot.
export const SLOT_HOURS = 6;

function key(coin) {
	return KEY_PREFIX + coin;
}

export function isValidCoin(coin) {
	return MINT_RE.test(String(coin || '').trim());
}

// Only real http/https image URLs survive — data:, javascript:, blob:, and
// anything unparseable are rejected so the panel can never be a script vector.
export function sanitizeImageUrl(raw) {
	const s = String(raw || '').trim();
	if (!s) return null;
	try {
		const u = new URL(s);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		if (u.href.length > MAX_URL) return null;
		return u.href;
	} catch {
		return null;
	}
}

export function sanitizeCaption(raw) {
	return String(raw || '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ') // strip control chars
		.trim()
		.slice(0, MAX_CAPTION);
}

// Read the active placement for a coin-world, or null when none / expired /
// Redis is offline. TTL already enforces expiry; the endsAt check is a
// belt-and-braces guard against clock skew on the read path.
export async function getPlacement(coin) {
	if (!isValidCoin(coin)) return null;
	const r = getRedis();
	if (!r) return null;
	try {
		const v = await r.get(key(coin.trim()));
		if (!v) return null;
		const rec = typeof v === 'string' ? JSON.parse(v) : v;
		if (rec?.endsAt && Date.parse(rec.endsAt) <= Date.now()) return null;
		return rec;
	} catch (err) {
		console.warn('[billboard] read failed:', err?.message || err);
		return null;
	}
}

// Write (or replace) the placement for a coin-world. Returns the stored record
// even when Redis is absent so a paid caller still gets a confirmation ticket —
// the payment is real and audited regardless of whether the panel persisted.
export async function setPlacement(
	coin,
	{ image, caption, payer = null, network = null, amountAtomics = null, asset = null, hours = SLOT_HOURS } = {},
) {
	if (!isValidCoin(coin)) {
		const e = new Error('a valid coin-world mint is required');
		e.status = 400;
		e.code = 'invalid_coin';
		throw e;
	}
	const img = sanitizeImageUrl(image);
	const cap = sanitizeCaption(caption);
	if (!img && !cap) {
		const e = new Error('provide an image URL and/or a caption to display');
		e.status = 400;
		e.code = 'empty_content';
		throw e;
	}

	const seconds = Math.round(Math.min(Math.max(Number(hours) || SLOT_HOURS, 1), 24) * 3600);
	const now = Date.now();
	const rec = {
		coin: coin.trim(),
		image: img,
		caption: cap || null,
		payer,
		network,
		amountAtomics,
		asset,
		startsAt: new Date(now).toISOString(),
		endsAt: new Date(now + seconds * 1000).toISOString(),
	};

	const r = getRedis();
	if (r) {
		try {
			await r.set(key(rec.coin), JSON.stringify(rec), { ex: seconds });
		} catch (err) {
			console.warn('[billboard] write failed:', err?.message || err);
		}
	}
	return rec;
}
