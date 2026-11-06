/**
 * BNB Greenfield read client — bucket/object metadata, permission checks, and
 * Storage-Provider byte downloads. Read-only; Track B's vault (upload 09,
 * unlock 11) composes it.
 *
 * `@bnb-chain/greenfield-js-sdk` (2.x) is a heavy protobuf/tendermint/cosmos
 * dependency tree, and every read we need is a plain HTTPS call — the chain
 * metadata via the Greenfield grpc-gateway REST (`head_bucket` / `head_object`,
 * verified live 2026-07-08) and object bytes via the SP's S3-style gateway. So,
 * per 00-CONTEXT's "wrap the minimal REST yourself" default (same bundle-lean
 * rationale as `erc8004-chains.js`), this file calls those endpoints directly
 * with `fetch` rather than pulling the SDK into the serverless bundle.
 *
 * Endpoints are copied from the live Greenfield testnet gateway — never invent.
 * Greenfield's cross-chain mirror settles asynchronously, so a just-created
 * object may read as `not_found`/`pending` for a few blocks; callers surface
 * that honestly rather than masking it.
 */

const NETWORKS = {
	testnet: {
		chainId: 'greenfield_5600-1',
		evmChainId: 5600,
		// grpc-gateway REST (serves cosmos + greenfield storage queries).
		lcd: 'https://gnfd-testnet-fullnode-tendermint-us.bnbchain.org',
		// Storage Providers (S3-style gateways). Failover across them.
		sps: [
			'https://gnfd-testnet-sp1.bnbchain.org',
			'https://gnfd-testnet-sp2.bnbchain.org',
			'https://gnfd-testnet-sp3.bnbchain.org',
		],
	},
	mainnet: {
		chainId: 'greenfield_1017-1',
		evmChainId: 1017,
		lcd: 'https://greenfield-chain.bnbchain.org',
		sps: [
			'https://greenfield-sp.bnbchain.org',
			'https://gnfd-mainnet-sp1.bnbchain.org',
		],
	},
};

/** Greenfield object visibility enum (from the storage module). */
export const VISIBILITY = {
	PUBLIC_READ: 'VISIBILITY_TYPE_PUBLIC_READ',
	PRIVATE: 'VISIBILITY_TYPE_PRIVATE',
	INHERIT: 'VISIBILITY_TYPE_INHERIT',
};

const DEFAULT_TIMEOUT_MS = 8000;

/** Typed error. `code` ∈ not_found | forbidden | unavailable | pending | bad_request. */
export class GreenfieldError extends Error {
	constructor(message, code = 'unavailable', info = {}) {
		super(message);
		this.name = 'GreenfieldError';
		this.code = code;
		this.status = info.status;
		if (info.cause) this.cause = info.cause;
	}
}

/**
 * Local-dev/E2E-proof escape hatch only: `GREENFIELD_SP_OVERRIDE_TESTNET`/
 * `_MAINNET` (comma-separated URLs) redirects Storage-Provider reads
 * (`downloadObject`/`listObjects`) to a local mock SP instead of the real
 * bnbchain.org gateways — same posture as `vault-contract.js`'s
 * `BNB_VAULT_RPC_OVERRIDE_TESTNET` for the chain side. Unset in production;
 * `getObjectMeta`/`headBucket` (the chain-side LCD reads) are untouched by
 * this override on purpose — only SP byte-serving is ever worth mocking
 * locally.
 */
function spOverride(key) {
	const envVar = key === 'mainnet' ? 'GREENFIELD_SP_OVERRIDE_MAINNET' : 'GREENFIELD_SP_OVERRIDE_TESTNET';
	const raw = process.env[envVar];
	if (!raw) return null;
	const sps = raw.split(',').map((s) => s.trim()).filter(Boolean);
	return sps.length ? sps : null;
}

function net(network) {
	const key = network === 'mainnet' || network === 'greenfield_1017-1' ? 'mainnet' : 'testnet';
	const base = NETWORKS[key];
	const overrideSps = spOverride(key);
	return overrideSps ? { ...base, sps: overrideSps } : base;
}

function assertName(v, what) {
	if (typeof v !== 'string' || !v || v.length > 1024 || /[\s]/.test(v)) {
		throw new GreenfieldError(`invalid ${what}: ${String(v).slice(0, 64)}`, 'bad_request');
	}
	return v;
}

async function httpGet(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers, method = 'GET' } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { method, headers, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Query the Greenfield storage module over the grpc-gateway REST. Maps the
 * chain's "No such bucket/object" (storage codes 1100/1101) to a typed
 * `not_found`, and "Not Implemented" (grpc code 12) to `unavailable`.
 */
async function lcdGet(network, path, opts = {}) {
	const { lcd } = net(network);
	const url = `${opts.lcd || lcd}${path}`;
	let res;
	try {
		res = await httpGet(url, opts);
	} catch (e) {
		throw new GreenfieldError(`Greenfield LCD unreachable: ${e.message}`, 'unavailable', { cause: e });
	}
	let body;
	try {
		body = await res.json();
	} catch {
		throw new GreenfieldError(`Greenfield LCD returned non-JSON (HTTP ${res.status})`, 'unavailable', { status: res.status });
	}
	// grpc-gateway error envelope: { code, message, details }
	if (body && typeof body.code === 'number' && body.message) {
		const msg = String(body.message);
		if (/No such bucket|No such object|1100|1101|not found/i.test(msg)) {
			throw new GreenfieldError(msg, 'not_found', { status: 404 });
		}
		if (body.code === 12) throw new GreenfieldError(msg, 'unavailable', { status: 501 });
		throw new GreenfieldError(msg, 'bad_request', { status: 400 });
	}
	return body;
}

/**
 * Fetch a bucket's on-chain info. Throws `not_found` if the bucket doesn't exist.
 * @returns {Promise<object>} the `bucket_info` object from the chain.
 */
export async function headBucket(bucket, opts = {}) {
	assertName(bucket, 'bucket');
	const body = await lcdGet(opts.network, `/greenfield/storage/head_bucket/${encodeURIComponent(bucket)}`, opts);
	return body.bucket_info || body.bucketInfo || body;
}

/**
 * Fetch an object's on-chain metadata (size, checksums, visibility, owner,
 * content-type, status). Throws `not_found` if absent (or still mirroring).
 * @returns {Promise<object>} the `object_info` object from the chain.
 */
export async function getObjectMeta(bucket, object, opts = {}) {
	assertName(bucket, 'bucket');
	assertName(object, 'object');
	const path = `/greenfield/storage/head_object/${encodeURIComponent(bucket)}/${encodeURIComponent(object)}`;
	const body = await lcdGet(opts.network, path, opts);
	return body.object_info || body.objectInfo || body;
}

/**
 * Does `principal` have READ access to an object? Derived from on-chain
 * ObjectInfo: a `PUBLIC_READ` object is readable by anyone; otherwise only the
 * owner is granted here. Fine-grained group/policy grants aren't exposed by the
 * public REST gateway (`verify_permission` returns Not Implemented), so those
 * resolve via a `downloadObject` auth-probe instead — a `false` here means "not
 * publicly/owner-readable", not "definitely denied for every policy".
 *
 * @returns {Promise<{ allowed:boolean, visibility:string, owner:string, reason:string }>}
 */
export async function getObjectPermissions(bucket, object, principal, opts = {}) {
	const info = await getObjectMeta(bucket, object, opts);
	const visibility = info.visibility || info.Visibility || VISIBILITY.INHERIT;
	const owner = info.owner || info.Owner || '';
	const isPublic = visibility === VISIBILITY.PUBLIC_READ;
	const isOwner = !!principal && owner.toLowerCase() === String(principal).toLowerCase();
	const allowed = isPublic || isOwner;
	return {
		allowed,
		visibility,
		owner,
		reason: isPublic ? 'public-read' : isOwner ? 'owner' : 'no public/owner read grant (policy grants need an auth-probe)',
	};
}

/** Virtual-hosted SP base for a bucket: `https://<bucket>.<sp-host>`. */
function spVirtualHost(spBase, bucket) {
	const u = new URL(spBase);
	return `${u.protocol}//${bucket}.${u.host}`;
}

/**
 * List objects in a bucket via the SP's S3-style gateway. Fails over across the
 * network's SPs. Returns object keys (tolerant of the SP's XML or JSON shape).
 *
 * @returns {Promise<{ objects: Array<{ name:string, size?:number }>, sp:string }>}
 */
export async function listObjects(bucket, opts = {}) {
	assertName(bucket, 'bucket');
	const { sps } = net(opts.network);
	const spList = opts.sp ? [opts.sp] : sps;
	const params = new URLSearchParams({ 'list-type': '2', 'max-keys': String(opts.maxKeys || 1000) });
	if (opts.prefix) params.set('prefix', opts.prefix);

	let lastErr;
	for (const sp of spList) {
		try {
			const res = await httpGet(`${spVirtualHost(sp, bucket)}/?${params}`, opts);
			if (res.status === 404) throw new GreenfieldError('bucket not found', 'not_found', { status: 404 });
			if (res.status === 403) throw new GreenfieldError('bucket is private', 'forbidden', { status: 403 });
			if (!res.ok) { lastErr = new GreenfieldError(`SP HTTP ${res.status}`, 'unavailable', { status: res.status }); continue; }
			const text = await res.text();
			return { objects: parseObjectList(text), sp };
		} catch (e) {
			if (e instanceof GreenfieldError && (e.code === 'not_found' || e.code === 'forbidden')) throw e;
			lastErr = e;
		}
	}
	throw lastErr || new GreenfieldError('all Storage Providers unreachable', 'unavailable');
}

/** Tolerantly extract object names from an SP list response (XML or JSON). */
function parseObjectList(text) {
	const t = text.trim();
	if (t.startsWith('{') || t.startsWith('[')) {
		try {
			const j = JSON.parse(t);
			const arr = j.objects || j.Objects || j.GfSpListObjects || [];
			return arr.map((o) => ({
				name: o.object_name || o.ObjectName || o.name || o.Key || o.object_info?.object_name,
				size: Number(o.payload_size || o.PayloadSize || o.Size || o.object_info?.payload_size || 0) || undefined,
			})).filter((o) => o.name);
		} catch {
			return [];
		}
	}
	// XML: collect <Key>…</Key> or <ObjectName>…</ObjectName>.
	const names = [];
	const re = /<(?:Key|ObjectName)>([^<]+)<\/(?:Key|ObjectName)>/g;
	let m;
	while ((m = re.exec(t))) names.push({ name: m[1] });
	return names;
}

/**
 * Download an object's bytes from a Storage Provider. Public objects need no
 * auth; private objects require `authForPrivate` (a pre-built Authorization
 * header / header map the caller supplies — this module never signs). A private
 * object read without valid auth surfaces the vault's expected LOCKED state as a
 * typed `forbidden` (HTTP 403), NOT a 500.
 *
 * @param {string} bucket @param {string} object
 * @param {{ network?:string, sp?:string, authForPrivate?:string|object, fetchImpl?:Function, timeoutMs?:number }} [opts]
 * @returns {Promise<{ bytes:ArrayBuffer, contentType:string|null, contentLength:number|null, sp:string }>}
 */
export async function downloadObject(bucket, object, opts = {}) {
	assertName(bucket, 'bucket');
	assertName(object, 'object');
	const { sps } = net(opts.network);
	const spList = opts.sp ? [opts.sp] : sps;
	const headers = {};
	if (opts.authForPrivate) {
		if (typeof opts.authForPrivate === 'string') headers.Authorization = opts.authForPrivate;
		else Object.assign(headers, opts.authForPrivate);
	}

	let lastErr;
	for (const sp of spList) {
		let res;
		try {
			res = await httpGet(`${spVirtualHost(sp, bucket)}/${encodeURIComponent(object)}`, { ...opts, headers });
		} catch (e) {
			lastErr = new GreenfieldError(`SP unreachable: ${e.message}`, 'unavailable', { cause: e });
			continue;
		}
		if (res.status === 403) throw new GreenfieldError('object is private and no valid read permission was presented', 'forbidden', { status: 403 });
		if (res.status === 404) throw new GreenfieldError('object not found (or still mirroring)', 'not_found', { status: 404 });
		if (res.status === 503 || res.status === 502) { lastErr = new GreenfieldError(`SP ${res.status}`, 'unavailable', { status: res.status }); continue; }
		if (!res.ok) throw new GreenfieldError(`SP HTTP ${res.status}`, 'unavailable', { status: res.status });
		const bytes = await res.arrayBuffer();
		return {
			bytes,
			contentType: res.headers.get?.('content-type') ?? null,
			contentLength: Number(res.headers.get?.('content-length')) || bytes.byteLength || null,
			sp,
		};
	}
	throw lastErr || new GreenfieldError('all Storage Providers unreachable', 'unavailable');
}

/** The resolved network config (endpoints), for callers/tests that need it. */
export function greenfieldNetwork(network) {
	return net(network);
}
