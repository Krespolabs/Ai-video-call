/**
 * Freshness/uniqueness registry for proof-of-grind certificates.
 *
 * A proof-of-grind certificate (src/solana/vanity/proof-of-grind.js) is fully
 * verifiable OFFLINE — signature, pattern, difficulty, and split-key non-custody
 * all recompute from public values. This registry adds the one guarantee a lone
 * signature cannot: that exactly ONE "freshly ground" certificate exists per
 * address. It records the FIRST certificate issued for an address and refuses to
 * overwrite it, so a seller cannot mint a second "fresh" proof to re-sell a
 * wallet that already changed hands. A buyer (or a resale marketplace) queries
 * the registry to confirm the certificate they hold is the canonical original.
 *
 * Stores ONLY public, secret-free provenance metadata — never a key, seed,
 * sealed envelope, or pattern beyond prefix/suffix. The allowlist below is the
 * privacy boundary: a secret cannot be persisted even if a caller passes a full
 * grind response, because `toCanonicalRecord()` structurally drops everything
 * not on the list.
 *
 * Backing store mirrors the rest of the codebase: Upstash Redis when configured,
 * an in-process Map fallback otherwise (local/CI works; a Redis outage degrades
 * to "no registry" rather than throwing). Layout:
 *
 *   HASH  vanity:cert:by-address   field=address → JSON(record)   [first-write-wins]
 *   HASH  vanity:cert:by-id        field=certId  → address        [secondary index]
 */

import { getRedis } from './redis.js';

const NS = 'vanity:cert';
const K = {
	byAddress: `${NS}:by-address`,
	byId: `${NS}:by-id`,
};

const memByAddress = new Map(); // address → record
const memById = new Map(); // certId → address

// The EXACT fields a registry record may carry. Anything else is dropped — no
// secret/seed/sealed/signature-material field is on this list.
const RECORD_FIELDS = Object.freeze([
	'certId',
	'address',
	'pattern',
	'format',
	'nonce',
	'issuedAt',
	'servicePublicKey',
	'keyId',
	'rarityScore',
	'rarityTier',
]);

/**
 * Project a certificate (or compatible object) down to the public canonical
 * record. Returns null when the minimum identifying fields are absent.
 * @param {object} cert
 * @returns {object|null}
 */
export function toCanonicalRecord(cert) {
	if (!cert || typeof cert !== 'object') return null;
	const rec = {
		certId: cert.certId,
		address: cert.address,
		pattern: sanitizePattern(cert.pattern),
		format: cert.format,
		nonce: cert.freshness?.nonce ?? cert.nonce,
		issuedAt: cert.freshness?.issuedAt ?? cert.issuedAt,
		servicePublicKey: cert.servicePublicKey,
		keyId: cert.keyId ?? null,
		rarityScore: typeof cert.rarity?.score === 'number' ? cert.rarity.score : null,
		rarityTier: cert.rarity?.tier ?? null,
	};
	if (!rec.certId || !rec.address || !rec.nonce) return null;
	const out = {};
	for (const k of RECORD_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
	return out;
}

function sanitizePattern(p) {
	if (!p || typeof p !== 'object') return { prefix: null, suffix: null, ignoreCase: false };
	return {
		prefix: p.prefix ? String(p.prefix).slice(0, 16) : null,
		suffix: p.suffix ? String(p.suffix).slice(0, 16) : null,
		ignoreCase: !!p.ignoreCase,
	};
}

function parse(raw) {
	if (!raw) return null;
	if (typeof raw === 'object') return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Register a certificate as the canonical proof for its address (first-write-wins).
 *
 * @param {object} cert - a signed proof-of-grind certificate.
 * @returns {Promise<{ record: object, isNew: boolean, conflict: boolean }>}
 *   isNew     — this address had no prior cert; the record was stored.
 *   conflict  — a DIFFERENT cert already owns this address (duplicate/re-sale);
 *               `record` is the existing canonical one, not the submitted cert.
 */
export async function registerCert(cert) {
	const rec = toCanonicalRecord(cert);
	if (!rec) throw Object.assign(new Error('invalid certificate for registry'), { status: 400 });
	const addr = rec.address;
	const redis = getRedis();

	if (redis) {
		// Atomic first-write-wins: HSETNX returns 1 only if the field was absent.
		const wrote = await redis.hsetnx(K.byAddress, addr, JSON.stringify(rec));
		if (wrote === 1 || wrote === true) {
			await redis.hset(K.byId, { [rec.certId]: addr });
			return { record: rec, isNew: true, conflict: false };
		}
		const existing = parse(await redis.hget(K.byAddress, addr)) || rec;
		return { record: existing, isNew: false, conflict: existing.certId !== rec.certId };
	}

	if (memByAddress.has(addr)) {
		const existing = memByAddress.get(addr);
		return { record: existing, isNew: false, conflict: existing.certId !== rec.certId };
	}
	memByAddress.set(addr, rec);
	memById.set(rec.certId, addr);
	return { record: rec, isNew: true, conflict: false };
}

/** Fetch the canonical record for an address, or null. */
export async function getCanonicalByAddress(address) {
	const addr = String(address || '');
	if (!addr) return null;
	const redis = getRedis();
	if (redis) return parse(await redis.hget(K.byAddress, addr));
	return memByAddress.get(addr) || null;
}

/** Fetch the canonical record for a certId, or null. */
export async function getByCertId(certId) {
	const id = String(certId || '');
	if (!id) return null;
	const redis = getRedis();
	if (redis) {
		const addr = await redis.hget(K.byId, id);
		return addr ? parse(await redis.hget(K.byAddress, addr)) : null;
	}
	const addr = memById.get(id);
	return addr ? memByAddress.get(addr) || null : null;
}

/** Test-only: clear the in-memory fallback between cases. */
export function _resetMemory() {
	memByAddress.clear();
	memById.clear();
}
