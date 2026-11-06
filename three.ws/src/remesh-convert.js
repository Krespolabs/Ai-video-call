/**
 * Server-side mesh conversion via /api/forge-remesh.
 *
 * FBX is the one export format we can't build in the browser — there is no
 * Three.js FBX exporter, and a rigged FBX needs Blender's exporter to write the
 * bone hierarchy + skin weights. So FBX goes through the remesh worker: we hand
 * it a public GLB URL, it runs a `convert` (which preserves the skeleton), and
 * returns a downloadable FBX URL.
 *
 * Two entry points depending on what the caller already has:
 *   - fbxFromUrl(glbUrl, …)   — saved avatars already host a public GLB.
 *   - fbxFromBlob(glbBlob, …) — the create/review flow has only an in-memory
 *                               blob, so we presign-upload it first.
 */

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 180_000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upload a GLB blob to R2 and return its public https URL. Reuses the same
 * presign endpoint the /play "bring your own avatar" drop zone uses.
 */
async function uploadGlbForConversion(blob, filename) {
	const presignRes = await fetch('/api/avatar/presign-glb', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			filename: `${filename}.glb`,
			content_type: 'model/gltf-binary',
			bytes: blob.size,
		}),
	});
	const presign = await presignRes.json().catch(() => ({}));
	if (presignRes.status === 413) {
		throw new Error('Model is too large to convert to FBX (16 MB max). Download GLB instead.');
	}
	if (!presignRes.ok || !presign?.upload_url || !presign?.public_url) {
		throw new Error(presign?.message || 'Could not get an upload URL for conversion.');
	}

	const put = await fetch(presign.upload_url, {
		method: 'PUT',
		headers: { 'content-type': 'model/gltf-binary' },
		body: blob,
	});
	if (!put.ok) throw new Error(`Upload failed (${put.status}).`);

	return presign.public_url;
}

async function startRemeshConvert(meshUrl, format) {
	const res = await fetch('/api/forge-remesh', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mesh_url: meshUrl, operation: 'convert', output_format: format }),
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 503) {
		throw new Error(`${format.toUpperCase()} conversion isn't available right now.`);
	}
	if (!res.ok || !data?.job_id) {
		throw new Error(data?.message || `Couldn't start ${format.toUpperCase()} conversion.`);
	}
	return data.job_id;
}

async function pollRemesh(jobId, onStatus) {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const res = await fetch(`/api/forge-remesh?job=${encodeURIComponent(jobId)}`);
		const data = await res.json().catch(() => ({}));
		if (data?.status === 'done' && data.result_url) return data.result_url;
		if (data?.status === 'failed') throw new Error(data.error || 'Conversion failed.');
		onStatus?.('Converting…');
	}
	throw new Error('Conversion timed out — try again.');
}

/**
 * Convert a public GLB URL to another server-side format. Returns the result
 * URL to download. Currently used for FBX.
 *
 * @param {string} glbUrl — public https URL of the source GLB
 * @param {object} opts
 * @param {string} [opts.format='fbx']
 * @param {(msg: string) => void} [opts.onStatus]
 * @returns {Promise<string>} downloadable result URL
 */
export async function fbxFromUrl(glbUrl, { format = 'fbx', onStatus } = {}) {
	if (!glbUrl) throw new Error('No source GLB to convert.');
	onStatus?.('Converting…');
	const jobId = await startRemeshConvert(glbUrl, format);
	return pollRemesh(jobId, onStatus);
}

/**
 * Convert an in-memory GLB blob: upload it for a public URL, then convert.
 *
 * @param {Blob} glbBlob
 * @param {object} opts
 * @param {string} [opts.filename='avatar']
 * @param {string} [opts.format='fbx']
 * @param {(msg: string) => void} [opts.onStatus]
 * @returns {Promise<string>} downloadable result URL
 */
export async function fbxFromBlob(glbBlob, { filename = 'avatar', format = 'fbx', onStatus } = {}) {
	if (!(glbBlob instanceof Blob)) throw new Error('No GLB source for conversion.');
	onStatus?.('Uploading…');
	const meshUrl = await uploadGlbForConversion(glbBlob, filename);
	onStatus?.('Converting…');
	const jobId = await startRemeshConvert(meshUrl, format);
	return pollRemesh(jobId, onStatus);
}

/** Trigger a browser download of a remote URL with a suggested filename. */
export function downloadUrl(href, filename) {
	const a = document.createElement('a');
	a.href = href;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
}
