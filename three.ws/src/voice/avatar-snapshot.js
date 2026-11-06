/**
 * Avatar snapshot capture + upload.
 *
 * Given a TalkScene-shaped renderer (anything that exposes
 * `.renderer.domElement` as a WebGL canvas), grabs a JPEG poster of the
 * current view and shuttles it through three.ws's existing thumbnail flow:
 *
 *     POST  /api/avatars/:id?action=presign-thumbnail   → presigned PUT URL
 *     PUT   <upload_url>                                → JPEG bytes
 *     POST  /api/avatars/:id?action=auto-tag            → sets thumbnail_key,
 *                                                         runs Claude vision
 *                                                         for tags + desc
 *
 * All three calls are real wires against the existing endpoints in
 * api/avatars/_actions.js. The auto-tag step is best-effort: a failure
 * there doesn't undo the thumbnail upload.
 *
 * Intended caller: avatar-edit.js after a successful Save. The render is
 * driven through the already-mounted TalkScene so we don't pay for a second
 * GLB load.
 */

import { log } from '../shared/log.js';
const JPEG_QUALITY = 0.86;
const MIN_BYTES = 2_000;             // smaller than this means the canvas is blank
const MAX_BYTES = 2 * 1024 * 1024;   // 2 MB ceiling (matches server-side cap)

/**
 * Capture the current frame of the scene's WebGL canvas as a JPEG Blob.
 *
 * three.js renders with `preserveDrawingBuffer: false` by default, which
 * means `canvas.toBlob` after the render-loop tick can hand back a blank
 * frame. We force one render via the scene's renderer immediately before
 * reading the pixels so the result is whatever's currently on screen.
 *
 * @param {{ renderer:any, scene:any, camera:any }} talkScene
 * @returns {Promise<Blob>}
 */
export function captureSnapshotBlob(talkScene) {
	if (!talkScene?.renderer || !talkScene.scene || !talkScene.camera) {
		throw new Error('captureSnapshotBlob: scene/renderer/camera required');
	}
	// Force a synchronous render so toBlob sees a fresh frame even if the
	// backing buffer was cleared by the previous tick.
	talkScene.renderer.render(talkScene.scene, talkScene.camera);
	const canvas = talkScene.renderer.domElement;
	if (!canvas || typeof canvas.toBlob !== 'function') {
		throw new Error('captureSnapshotBlob: renderer.domElement is not an HTMLCanvasElement');
	}
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) return reject(new Error('canvas.toBlob returned null'));
				if (blob.size < MIN_BYTES) {
					return reject(new Error('snapshot is suspiciously small — likely a blank frame'));
				}
				if (blob.size > MAX_BYTES) {
					return reject(new Error(`snapshot too large: ${blob.size} > ${MAX_BYTES}`));
				}
				resolve(blob);
			},
			'image/jpeg',
			JPEG_QUALITY,
		);
	});
}

/**
 * End-to-end: capture → presign → PUT → auto-tag.
 *
 * Returns `{ ok: true, thumbKey, autoTagged }` on success. Throws on a
 * presign or upload failure; logs and continues on auto-tag failure (the
 * thumbnail itself is still in R2 and will get linked to the avatar by the
 * next auto-tag call).
 *
 * @param {object} args
 * @param {string} args.avatarId
 * @param {{ renderer:any, scene:any, camera:any }} args.scene
 * @returns {Promise<{ ok: true, thumbKey: string, autoTagged: object | null }>}
 */
export async function uploadAvatarSnapshot({ avatarId, scene }) {
	if (!avatarId) throw new Error('uploadAvatarSnapshot: avatarId required');
	const blob = await captureSnapshotBlob(scene);

	// 1) Presign
	const presignRes = await fetch(
		`/api/avatars/${encodeURIComponent(avatarId)}?action=presign-thumbnail`,
		{
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ avatar_id: avatarId, size_bytes: blob.size }),
		},
	);
	if (!presignRes.ok) {
		const j = await presignRes.json().catch(() => ({}));
		throw new Error(j.error_description || `presign-thumbnail failed (${presignRes.status})`);
	}
	const { thumb_key, upload_url } = await presignRes.json();
	if (!thumb_key || !upload_url) {
		throw new Error('presign-thumbnail returned no upload target');
	}

	// 2) PUT bytes to R2
	const putRes = await fetch(upload_url, {
		method: 'PUT',
		headers: { 'content-type': 'image/jpeg' },
		body: blob,
	});
	if (!putRes.ok) {
		throw new Error(`R2 upload failed (${putRes.status})`);
	}

	// 3) auto-tag — sets thumbnail_key on the avatar + best-effort tags via
	//    Claude vision. Failure here doesn't fail the snapshot.
	let autoTagged = null;
	try {
		const tagRes = await fetch(
			`/api/avatars/${encodeURIComponent(avatarId)}?action=auto-tag`,
			{
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ avatar_id: avatarId, thumb_key }),
			},
		);
		if (tagRes.ok) autoTagged = await tagRes.json();
	} catch (err) {
		log.warn('[snapshot] auto-tag failed, thumbnail still uploaded:', err?.message);
	}

	return { ok: true, thumbKey: thumb_key, autoTagged };
}

// Exported for tests + the rare caller that wants to inspect the constants.
export const SNAPSHOT_CONSTANTS = {
	JPEG_QUALITY,
	MIN_BYTES,
	MAX_BYTES,
};
