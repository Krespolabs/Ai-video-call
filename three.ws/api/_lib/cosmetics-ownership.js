// Cosmetic ownership ledger (R22) — the durable record of which premium
// cosmetics an account has purchased over the x402 USDC rail.
//
// It lives in the SAME persistence the rest of the /play economy uses — Upstash
// Redis (REST), the store playerStore.js and presence-store.js already speak —
// so there's no new provider to operate. Ownership is keyed by the player's
// stable ACCOUNT id (their Solana wallet once authenticated, otherwise the guest
// id the client persists), NOT by the paying wallet: a buyer can settle the USDC
// on Base or Solana, and the cosmetic still lands on the account they bought it
// for. Each account is one Redis SET, `cosmetics:owned:<account>`, holding the
// catalog ids it owns — so a grant is naturally idempotent (owning a cosmetic
// twice is owning it once) and a read is a single SMEMBERS.
//
// Ownership is written ONLY here, by the verified-payment handler in
// api/x402/cosmetic-purchase.js. The shop (R21) and the owned-inventory (R23)
// read it. Reads degrade gracefully to "owns nothing" if Redis is unreachable —
// the shop still renders, items just show as lockable. Grants FAIL CLOSED: if we
// can't persist the unlock we throw, so the x402 flow never settles a charge it
// can't record (matching the fail-closed invariants in x402-security-hardening).

import { getRedis } from './redis.js';

const OWNED_PREFIX = 'cosmetics:owned:';
// Refreshed on every grant. Long enough that a returning player keeps their
// purchases; bounds abandoned-guest growth the same way playerStore does.
const OWNED_TTL_S = 60 * 60 * 24 * 365 * 2; // 2 years

function redis() { return getRedis(); }

// True when a durable ownership store is configured. The purchase endpoint uses
// this to fail closed in production (refuse to settle without somewhere to record
// the unlock) rather than charge for a cosmetic it would immediately lose.
export function ownershipStoreConfigured() {
	return !!redis();
}

// Account ids must be a Solana wallet (base58) or a guest id like `g_xxxx`. Bound
// the charset + length so a crafted value can't escape the keyspace or balloon a
// key. Returns the trimmed id, or '' when it isn't a usable account id.
export function normalizeAccountId(raw) {
	const id = String(raw ?? '').trim();
	if (id.length < 3 || id.length > 64) return '';
	if (!/^[A-Za-z0-9_:-]+$/.test(id)) return '';
	return id;
}

// Grant ownership of `cosmeticId` to `account`. Idempotent — returns true when it
// newly unlocked the item, false when the account already owned it. Throws (fail
// closed) when no durable store is configured, so a caller never reports an
// unlock it didn't persist.
export async function grantCosmeticOwnership(account, cosmeticId) {
	const r = redis();
	if (!r) {
		const err = new Error('cosmetic ownership store is not configured (UPSTASH_REDIS_REST_URL/_TOKEN)');
		err.status = 503;
		err.code = 'ownership_store_unavailable';
		throw err;
	}
	const key = OWNED_PREFIX + account;
	const added = await r.sadd(key, cosmeticId);
	// Refresh the TTL on every write so an actively-collecting account never ages
	// out. A best-effort expire — the SADD above is the durable part.
	r.expire(key, OWNED_TTL_S).catch(() => {});
	return added === 1;
}

// The premium cosmetic ids `account` owns. Degrades to [] on any store error or
// when no store is configured — the shop renders either way.
export async function readOwnedCosmetics(account) {
	const r = redis();
	if (!r || !account) return [];
	try {
		const members = await r.smembers(OWNED_PREFIX + account);
		return Array.isArray(members) ? members : [];
	} catch (err) {
		console.warn('[cosmetics-ownership] read failed:', err?.message);
		return [];
	}
}

// Does `account` own `cosmeticId`? Degrades to false on any store error.
export async function ownsCosmetic(account, cosmeticId) {
	const r = redis();
	if (!r || !account) return false;
	try {
		return (await r.sismember(OWNED_PREFIX + account, cosmeticId)) === 1;
	} catch (err) {
		console.warn('[cosmetics-ownership] ownership check failed:', err?.message);
		return false;
	}
}
