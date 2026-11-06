/**
 * BNB vault off-chain bookkeeping — the small amount of server-side state
 * that glues the on-chain `GreenfieldVault` contract (prompt 10) to the
 * Greenfield-hosted manifest/ciphertext pair a seller uploaded (prompt 09).
 * Shared by `api/bnb/vault-upload.js` (writer) and `api/vault/*` (readers,
 * prompt 11) so both sides agree on one cache-key format and one `objectId`
 * derivation — drifting formats here would silently break every join.
 *
 * Why an off-chain index exists at all: `GreenfieldVault.list(objectId, ...)`
 * takes an opaque `bytes32 objectId` (per its own NatSpec: "matches
 * specs/vault-manifest.md's glbObjectRef, NOT the Greenfield ERC-721 token
 * id"). This module defines that opaque id as
 * `keccak256(utf8("<bucket>/<object>"))` — a canonical, deterministic,
 * one-way binding from a manifest's `glbObjectRef` to the on-chain id. Since
 * it's one-way, going from "an objectId we saw in a `Listed` event" back to
 * "which bucket/object is that" needs an index. `resolveObjectRef` tries the
 * fast KV index first (populated by `vault-upload.js` at upload time) and
 * falls back to a bounded scan of the bucket's own manifest objects — so a
 * listing created by ANY means (our upload endpoint, a future UI, or a raw
 * `cast send list(...)`) is still resolvable, never permanently orphaned by
 * a missing side-index.
 */

import { keccak256, toBytes } from 'viem';
import { cacheGet, cacheSet } from '../cache.js';
import { env } from '../env.js';
import { listObjects, downloadObject, GreenfieldError } from './greenfield.js';

// The vault key record + objectId index have no natural expiry — they must
// outlive the listing until the seller delists or every buyer has unlocked.
// 180 days comfortably covers a real listing lifetime (mirrors the TTL
// vault-upload.js already used for the content-key record before this
// module existed).
export const VAULT_KEY_TTL_S = 180 * 24 * 3600;
export const VAULT_INDEX_TTL_S = VAULT_KEY_TTL_S;

const MANIFEST_SUFFIX = '.manifest.json';
const GLB_SUFFIX = '.glb.enc';
const VAULT_PREFIX = 'vaults/';
const MAX_SCAN_OBJECTS = 500;

/** Cache key for the persisted (encrypted-at-rest) content key of one ciphertext object. */
export function vaultKeyCacheKey(bucket, glbObject) {
	return `bnb:vault:key:${bucket}:${glbObject}`;
}

/** Cache key for the objectId → {bucket, glbObject, manifestObject, sellerAddress} index. */
export function vaultObjectIndexKey(objectId) {
	return `bnb:vault:index:${String(objectId).toLowerCase()}`;
}

/**
 * Canonical on-chain `objectId` for a manifest's `glbObjectRef`. Deterministic
 * and one-way (keccak256) — the same bucket/object pair always derives the
 * same id, matching what a seller (or the future vault UI) passes to
 * `GreenfieldVault.list()`.
 * @param {string} bucket @param {string} glbObject
 * @returns {`0x${string}`}
 */
export function deriveObjectId(bucket, glbObject) {
	return keccak256(toBytes(`${bucket}/${glbObject}`));
}

/** Bucket that hosts every vault object, per network — same default as vault-upload.js. */
export function vaultBucketFor(network) {
	return network === 'mainnet' ? env.GREENFIELD_VAULT_BUCKET_MAINNET : env.GREENFIELD_VAULT_BUCKET_TESTNET;
}

/** Persist the objectId → object-ref index entry (write side, called at upload/list time). */
export async function storeVaultObjectIndex(objectId, ref, ttlSeconds = VAULT_INDEX_TTL_S) {
	return cacheSet(vaultObjectIndexKey(objectId), ref, ttlSeconds);
}

/** Read the objectId → object-ref index entry, or null if not indexed. */
export async function getVaultObjectIndex(objectId) {
	return cacheGet(vaultObjectIndexKey(objectId));
}

/** Read the persisted (encrypted-at-rest) content-key record for a ciphertext object, or null. */
export async function getVaultKeyRecord(bucket, glbObject) {
	return cacheGet(vaultKeyCacheKey(bucket, glbObject));
}

/**
 * Resolve an on-chain `objectId` to its Greenfield object refs. KV index
 * first (fast path); on a miss, bounded-scans the bucket's own
 * `vaults/**\/*.manifest.json` objects, re-derives each candidate's
 * objectId, and self-heals the index on a match so the next lookup is fast
 * again. Never assumes the index is complete — the bucket itself is the
 * source of truth.
 *
 * @param {`0x${string}`} objectId
 * @param {{ network?: 'testnet'|'mainnet', bucket?: string }} [opts]
 * @returns {Promise<{ bucket:string, glbObject:string, manifestObject:string, sellerAddress?:string } | null>}
 */
export async function resolveObjectRef(objectId, opts = {}) {
	const indexed = await getVaultObjectIndex(objectId);
	if (indexed?.bucket && indexed?.glbObject) return indexed;

	const network = opts.network === 'mainnet' ? 'mainnet' : 'testnet';
	const bucket = opts.bucket || vaultBucketFor(network);
	let listing;
	try {
		listing = await listObjects(bucket, { network, prefix: VAULT_PREFIX, maxKeys: MAX_SCAN_OBJECTS });
	} catch (err) {
		if (err instanceof GreenfieldError) return null; // bucket missing/unreachable — nothing to resolve
		throw err;
	}

	for (const obj of listing.objects) {
		if (!obj.name?.endsWith(MANIFEST_SUFFIX)) continue;
		const glbObject = obj.name.slice(0, -MANIFEST_SUFFIX.length) + GLB_SUFFIX;
		if (deriveObjectId(bucket, glbObject) !== objectId) continue;
		const ref = { bucket, glbObject, manifestObject: obj.name };
		await storeVaultObjectIndex(objectId, ref).catch(() => {}); // self-heal, best-effort
		return ref;
	}
	return null;
}

/**
 * Fetch and parse a manifest JSON object from Greenfield (public, no auth).
 * @param {string} bucket @param {string} manifestObject
 * @returns {Promise<object>}
 */
export async function fetchManifest(bucket, manifestObject, opts = {}) {
	const dl = await downloadObject(bucket, manifestObject, opts);
	const text = Buffer.from(dl.bytes).toString('utf8');
	return JSON.parse(text);
}
