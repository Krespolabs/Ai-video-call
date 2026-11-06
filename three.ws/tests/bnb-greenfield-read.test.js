/**
 * BNB Greenfield read client — unit tests.
 *
 * Chain (LCD) and Storage-Provider responses are mocked via an injected
 * fetchImpl so the suite is deterministic and offline. Synthetic bucket/object
 * names only — no real third-party buckets. The load-bearing case is the
 * `forbidden` path (a private object read without permission), which the vault
 * relies on as its "locked" signal and which must be a typed error, not a 500.
 */

import { describe, it, expect } from 'vitest';
import {
	headBucket,
	getObjectMeta,
	getObjectPermissions,
	listObjects,
	downloadObject,
	greenfieldNetwork,
	GreenfieldError,
	VISIBILITY,
} from '../api/_lib/bnb/greenfield.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function jsonResponse(obj, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return obj; }, async text() { return JSON.stringify(obj); }, headers: { get: () => null } };
}
function bytesResponse(status, { contentType = 'model/gltf-binary', body = new Uint8Array([1, 2, 3]) } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async arrayBuffer() { return body.buffer; },
		async text() { return ''; },
		headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : h.toLowerCase() === 'content-length' ? String(body.length) : null) },
	};
}

describe('network config', () => {
	it('defaults to testnet and exposes chain + SP endpoints', () => {
		const t = greenfieldNetwork();
		expect(t.chainId).toBe('greenfield_5600-1');
		expect(t.sps.length).toBeGreaterThanOrEqual(2);
		expect(greenfieldNetwork('mainnet').chainId).toBe('greenfield_1017-1');
	});
});

describe('getObjectMeta', () => {
	it('returns object_info on success', async () => {
		const fetchImpl = async () => jsonResponse({ object_info: { object_name: 'model.glb', payload_size: '2048', visibility: VISIBILITY.PUBLIC_READ, owner: OWNER } });
		const meta = await getObjectMeta('syn-bucket', 'model.glb', { fetchImpl });
		expect(meta.object_name).toBe('model.glb');
		expect(meta.visibility).toBe(VISIBILITY.PUBLIC_READ);
	});

	it('maps a "No such object" chain error to typed not_found', async () => {
		const fetchImpl = async () => jsonResponse({ code: 2, message: 'codespace storage code 1101: No such object', details: [] });
		await expect(getObjectMeta('syn-bucket', 'ghost.glb', { fetchImpl })).rejects.toMatchObject({ code: 'not_found' });
	});

	it('rejects a malformed object name before any network call', async () => {
		let called = false;
		const fetchImpl = async () => { called = true; return jsonResponse({}); };
		await expect(getObjectMeta('syn-bucket', 'has space', { fetchImpl })).rejects.toBeInstanceOf(GreenfieldError);
		expect(called).toBe(false);
	});
});

describe('headBucket', () => {
	it('returns bucket_info on success', async () => {
		const fetchImpl = async () => jsonResponse({ bucket_info: { bucket_name: 'syn-bucket', owner: OWNER } });
		const info = await headBucket('syn-bucket', { fetchImpl });
		expect(info.bucket_name).toBe('syn-bucket');
	});
	it('maps "No such bucket" to not_found', async () => {
		const fetchImpl = async () => jsonResponse({ code: 2, message: 'codespace storage code 1100: No such bucket', details: [] });
		await expect(headBucket('ghost', { fetchImpl })).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('getObjectPermissions', () => {
	it('grants a public-read object to any principal', async () => {
		const fetchImpl = async () => jsonResponse({ object_info: { visibility: VISIBILITY.PUBLIC_READ, owner: OWNER } });
		const p = await getObjectPermissions('syn-bucket', 'pub.glb', OTHER, { fetchImpl });
		expect(p.allowed).toBe(true);
		expect(p.reason).toBe('public-read');
	});

	it('grants the owner of a private object', async () => {
		const fetchImpl = async () => jsonResponse({ object_info: { visibility: VISIBILITY.PRIVATE, owner: OWNER } });
		const p = await getObjectPermissions('syn-bucket', 'priv.glb', OWNER, { fetchImpl });
		expect(p.allowed).toBe(true);
		expect(p.reason).toBe('owner');
	});

	it('returns false for a principal not in the policy of a private object', async () => {
		const fetchImpl = async () => jsonResponse({ object_info: { visibility: VISIBILITY.PRIVATE, owner: OWNER } });
		const p = await getObjectPermissions('syn-bucket', 'priv.glb', OTHER, { fetchImpl });
		expect(p.allowed).toBe(false);
	});
});

describe('downloadObject', () => {
	it('returns bytes for a public object', async () => {
		const fetchImpl = async () => bytesResponse(200);
		const out = await downloadObject('syn-bucket', 'pub.glb', { fetchImpl });
		expect(out.bytes.byteLength).toBe(3);
		expect(out.contentType).toBe('model/gltf-binary');
	});

	it('a private object without permission → typed forbidden (not a 500)', async () => {
		const fetchImpl = async () => bytesResponse(403);
		await expect(downloadObject('syn-bucket', 'priv.glb', { fetchImpl })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
	});

	it('missing object → typed not_found', async () => {
		const fetchImpl = async () => bytesResponse(404);
		await expect(downloadObject('syn-bucket', 'ghost.glb', { fetchImpl })).rejects.toMatchObject({ code: 'not_found' });
	});

	it('fails over to the next SP on a 503, then succeeds', async () => {
		let n = 0;
		const fetchImpl = async () => (++n === 1 ? bytesResponse(503) : bytesResponse(200));
		const out = await downloadObject('syn-bucket', 'pub.glb', { fetchImpl });
		expect(out.bytes.byteLength).toBe(3);
		expect(n).toBe(2);
	});

	it('all SPs down → typed unavailable', async () => {
		const fetchImpl = async () => bytesResponse(503);
		await expect(downloadObject('syn-bucket', 'pub.glb', { fetchImpl })).rejects.toMatchObject({ code: 'unavailable' });
	});
});

describe('listObjects', () => {
	it('parses an S3-style XML object list', async () => {
		const xml = '<?xml version="1.0"?><ListObjectsResult><Contents><Key>a.glb</Key></Contents><Contents><Key>b.glb</Key></Contents></ListObjectsResult>';
		const fetchImpl = async () => ({ ok: true, status: 200, async text() { return xml; }, async json() { return {}; }, headers: { get: () => null } });
		const out = await listObjects('syn-bucket', { fetchImpl });
		expect(out.objects.map((o) => o.name)).toEqual(['a.glb', 'b.glb']);
	});

	it('parses a JSON object list', async () => {
		const fetchImpl = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ objects: [{ object_name: 'x.glb', payload_size: '10' }] }); }, async json() { return {}; }, headers: { get: () => null } });
		const out = await listObjects('syn-bucket', { fetchImpl });
		expect(out.objects[0]).toMatchObject({ name: 'x.glb', size: 10 });
	});

	it('private bucket → forbidden', async () => {
		const fetchImpl = async () => ({ ok: false, status: 403, async text() { return ''; }, async json() { return {}; }, headers: { get: () => null } });
		await expect(listObjects('syn-bucket', { fetchImpl })).rejects.toMatchObject({ code: 'forbidden' });
	});
});
