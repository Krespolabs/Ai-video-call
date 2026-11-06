// /dad — "Make Dad a 3D avatar" page controller.
//
// Flow (all real, no mocks):
//   pick/drop photo → normalize (downscale / HEIC→JPEG) → /api/forge-upload
//   (presigned R2 PUT) → public URL → /api/forge-rembg (human matte; graceful
//   skip if unconfigured) → preview → /api/dad/generate (headless
//   image→rigged-GLB reconstruct) → poll → <agent-3d> decoration viewer
//   (idle/walk/wave) → share permalink.
//
// Isolated feature: imports only shared, generic services (object storage,
// background removal, the reconstruct provider) — never the forge generation
// pipeline. The <agent-3d> element handles canonicalize + retarget so any
// rigged humanoid GLB idles and walks with no per-rig code.

import './dad.css';

// /api/forge-upload caps at 8 MB; anything larger (or any non-accepted type) is
// downscaled + re-encoded to JPEG client-side before upload, so the three.ws
// "up to 8 MB" contract always holds and phone HEIC photos work where decodable.
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
// Sanity ceiling on the raw file we'll even attempt to decode.
const MAX_RAW_BYTES = 40 * 1024 * 1024;
// Longest-edge cap for the re-encoded upload — plenty for reconstruction.
const MAX_DIM = 1536;
const ACCEPT = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Heaviest a reconstruct can reasonably take before we stop waiting.
const GEN_TIMEOUT_MS = 4 * 60 * 1000;
const REMBG_TIMEOUT_MS = 60 * 1000;
const POLL_MS = 2500;

// Hosts a shared (?a=) GLB may legitimately come from: our own origin, the R2
// bucket, and the reconstruct providers' delivery CDNs. Anything else is
// refused so a crafted permalink can't make a victim's browser parse arbitrary
// GLB bytes on the three.ws origin.
const ALLOWED_GLB_HOST = /(^|\.)(r2\.dev|replicate\.delivery|storage\.googleapis\.com|googleusercontent\.com|hf\.space)$/i;

// The <agent-3d> decoration runtime is ~3.5 MB — load it only when we actually
// have an avatar to show, not on the upload screen.
const AGENT3D_LOADER = '/agent-3d/latest/agent-3d.js';

const DEV = Boolean(import.meta.env && import.meta.env.DEV);

const root = document.getElementById('dad');
const els = {
	drop: document.getElementById('dad-drop'),
	file: document.getElementById('dad-file'),
	previewImg: document.getElementById('dad-preview-img'),
	generate: document.getElementById('dad-generate'),
	progressText: document.getElementById('dad-progress-text'),
	viewer: document.getElementById('dad-viewer'),
	animIdle: document.getElementById('dad-anim-idle'),
	animWalk: document.getElementById('dad-anim-walk'),
	animWave: document.getElementById('dad-anim-wave'),
	share: document.getElementById('dad-share'),
	shareCopied: document.getElementById('dad-share-copied'),
	download: document.getElementById('dad-download'),
	errorTitle: document.getElementById('dad-error-title'),
	errorMsg: document.getElementById('dad-error-msg'),
	retry: document.getElementById('dad-retry'),
};

const regions = {};
for (const box of root.querySelectorAll('[data-region]')) {
	regions[box.dataset.region] = box;
}

// Monotonic id so a slow upload/matte chain that resolves AFTER the user reset
// or picked a different photo becomes a no-op instead of clobbering fresh state.
let runId = 0;

// Mutable run state for the current photo → avatar attempt.
const state = {
	/** Public URL of the matted (or raw) photo fed to the reconstruct. */
	sourceUrl: null,
	/** ObjectURL we created locally — revoked on reset to avoid leaks. */
	localObjectUrl: null,
	glbUrl: null,
	viewerEl: null,
	viewerReady: false,
	readyFallback: null,
	agent3dReady: null,
};

// ── Stage routing ───────────────────────────────────────────────────────────

function setStage(stage) {
	root.dataset.stage = stage;
	for (const [name, box] of Object.entries(regions)) {
		box.hidden = name !== stage;
	}
	// Move focus to the new stage's heading for screen-reader continuity.
	const heading = regions[stage]?.querySelector('h1, h2');
	if (heading && stage !== 'intro') {
		heading.setAttribute('tabindex', '-1');
		heading.focus({ preventScroll: true });
	}
}

function showError(title, message) {
	els.errorTitle.textContent = title;
	els.errorMsg.textContent = message;
	setStage('error');
}

// ── Upload + preprocess ─────────────────────────────────────────────────────

function validate(file) {
	if (!file) return 'No file selected.';
	const isImage =
		(file.type && file.type.startsWith('image/')) ||
		/\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(file.name || '');
	if (!isImage) return 'Please choose an image file (JPG, PNG, HEIC, or WebP).';
	if (file.size > MAX_RAW_BYTES) return 'That image is too large — please use one under 40 MB.';
	return null;
}

function decodeViaImg(file) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('decode failed'));
		};
		img.src = url;
	});
}

// Return an upload-ready File: accepted type and ≤ 8 MB. Already-fine images
// pass through untouched (no quality loss); everything else (oversized, or a
// HEIC/odd format the browser can decode) is drawn onto a white-matted canvas
// and re-encoded to JPEG so alpha never reaches the reconstruct as ambiguity.
async function prepareImage(file) {
	if (ACCEPT.has(file.type) && file.size <= UPLOAD_MAX_BYTES) return file;

	let bitmap = null;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		bitmap = await decodeViaImg(file).catch(() => null);
	}
	if (!bitmap) {
		throw new Error(
			'We couldn’t read that photo. iPhone HEIC photos sometimes fail — set Camera → Formats → “Most Compatible”, or upload a JPG.',
		);
	}

	const iw = bitmap.naturalWidth || bitmap.width;
	const ih = bitmap.naturalHeight || bitmap.height;
	const scale = Math.min(1, MAX_DIM / Math.max(iw, ih));
	const w = Math.max(1, Math.round(iw * scale));
	const h = Math.max(1, Math.round(ih * scale));

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, w, h);
	ctx.drawImage(bitmap, 0, 0, w, h);
	bitmap.close?.();

	const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
	if (!blob) throw new Error('We couldn’t process that photo. Please try a different one.');
	return new File([blob], 'dad.jpg', { type: 'image/jpeg' });
}

async function presignAndPut(file) {
	const presignRes = await fetch('/api/forge-upload', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ content_type: file.type, size_bytes: file.size }),
	});
	if (presignRes.status === 503) {
		throw new Error('Photo uploads are temporarily unavailable. Please try again shortly.');
	}
	if (presignRes.status === 429) {
		throw new Error("You've uploaded a lot just now — give it a minute and try again.");
	}
	const presign = await presignRes.json().catch(() => ({}));
	if (!presignRes.ok || !presign.upload_url || !presign.public_url) {
		throw new Error(presign.message || 'Could not start the upload.');
	}
	const put = await fetch(presign.upload_url, {
		method: presign.method || 'PUT',
		headers: presign.headers || { 'content-type': file.type },
		body: file,
	});
	if (!put.ok) throw new Error('The photo failed to upload. Check your connection and retry.');
	return presign.public_url;
}

// Human-subject background removal. Best-effort: if the service is unconfigured
// or fails, fall back to the raw photo rather than blocking the whole flow.
async function matte(publicUrl) {
	let start;
	try {
		start = await fetch('/api/forge-rembg', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ image_url: publicUrl, model: 'u2net_human_seg' }),
		});
	} catch {
		return publicUrl;
	}
	if (!start.ok) return publicUrl; // 503 unconfigured / 429 / etc. → use raw.
	const { job_id: jobId } = await start.json().catch(() => ({}));
	if (!jobId) return publicUrl;

	const deadline = Date.now() + REMBG_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		let poll;
		try {
			poll = await fetch(`/api/forge-rembg?job=${encodeURIComponent(jobId)}`);
		} catch {
			return publicUrl;
		}
		const data = await poll.json().catch(() => ({}));
		if (data.result_url) return data.result_url;
		if (isFailed(data.status)) {
			if (DEV) console.warn('[dad] rembg failed, using raw photo:', data.error);
			return publicUrl;
		}
	}
	if (DEV) console.warn('[dad] rembg timed out, using raw photo');
	return publicUrl; // timed out → raw photo is a fine input too.
}

async function handleFile(file) {
	const myRun = ++runId;

	const err = validate(file);
	if (err) {
		showError('That photo won’t work', err);
		return;
	}

	// Instant local preview so the screen never sits empty while we upload.
	revokeLocal();
	state.localObjectUrl = URL.createObjectURL(file);
	els.previewImg.src = state.localObjectUrl;
	setStage('preview');
	els.generate.disabled = true;
	els.generate.textContent = 'Preparing photo…';

	try {
		const prepared = await prepareImage(file);
		if (myRun !== runId) return;
		const publicUrl = await presignAndPut(prepared);
		if (myRun !== runId) return;
		const matted = await matte(publicUrl);
		if (myRun !== runId) return;
		state.sourceUrl = matted;
		// Swap the local preview for the processed (matted) one.
		els.previewImg.src = matted;
		els.generate.disabled = false;
		els.generate.textContent = 'Make the 3D avatar';
	} catch (e) {
		if (myRun !== runId) return;
		showError('Upload trouble', e.message || 'Could not prepare that photo. Try another.');
	}
}

// ── Generate ────────────────────────────────────────────────────────────────

async function generate() {
	if (!state.sourceUrl) {
		showError('No photo yet', 'Pick a photo of your dad first.');
		return;
	}
	setStage('generating');

	let startRes;
	try {
		startRes = await fetch('/api/dad/generate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ image_url: state.sourceUrl }),
		});
	} catch {
		showError('Network hiccup', 'We couldn’t reach the avatar service. Check your connection and retry.');
		return;
	}

	if (startRes.status === 503) {
		showError(
			'Avatar engine offline',
			'The 3D avatar engine isn’t available right now. We’ve been notified — please try again later.',
		);
		return;
	}
	if (startRes.status === 429) {
		showError('Slow down a touch', "You've made a lot of avatars just now. Give it a minute and try again.");
		return;
	}
	const start = await startRes.json().catch(() => ({}));
	if (!startRes.ok || !start.job_id) {
		showError('Couldn’t start', start.message || start.error_description || 'The avatar job failed to start.');
		return;
	}

	els.progressText.textContent = 'Reconstructing geometry from the photo…';

	const deadline = Date.now() + GEN_TIMEOUT_MS;
	let ticks = 0;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		ticks += 1;
		// Status copy advances on real elapsed polling — the bar itself is
		// indeterminate (CSS), since the reconstruct API reports no true percent.
		if (ticks === 4) els.progressText.textContent = 'Building textures and rigging the skeleton…';
		if (ticks === 10) els.progressText.textContent = 'Almost there — finishing the mesh…';

		let poll;
		try {
			poll = await fetch(`/api/dad/generate?job=${encodeURIComponent(start.job_id)}`);
		} catch {
			continue; // transient — keep polling until the deadline.
		}
		const data = await poll.json().catch(() => ({}));
		const glb = data.glb_url || data.result_url;
		if (glb && isDone(data.status)) {
			await showResult(glb);
			return;
		}
		if (isFailed(data.status)) {
			showError(
				'Couldn’t build the avatar',
				data.error || 'The photo couldn’t be turned into a clean 3D model. A brighter, front-facing shot usually fixes it.',
			);
			return;
		}
	}
	showError('Took too long', 'The avatar took longer than expected. Please try again.');
}

// ── Result + viewer ─────────────────────────────────────────────────────────

function loadAgent3d() {
	if (state.agent3dReady) return state.agent3dReady;
	const p = new Promise((resolve, reject) => {
		if (customElements.get('agent-3d')) return resolve();
		// If a previous attempt left a script tag that already errored, remove it
		// so we can inject a fresh one — otherwise attaching a 'load' listener on
		// a dead script hangs the promise forever.
		const existing = document.querySelector(`script[data-agent3d]`);
		if (existing) {
			if (existing.dataset.agent3dFailed) {
				existing.remove();
			} else {
				existing.addEventListener('load', () => resolve());
				existing.addEventListener('error', () => reject(new Error('viewer failed to load')));
				return;
			}
		}
		const s = document.createElement('script');
		s.type = 'module';
		s.src = AGENT3D_LOADER;
		s.dataset.agent3d = '1';
		s.addEventListener('load', () => resolve());
		s.addEventListener('error', () => {
			s.dataset.agent3dFailed = '1';
			reject(new Error('viewer failed to load'));
		});
		document.head.appendChild(s);
	});
	state.agent3dReady = p;
	// Clear the cache on failure so the next showResult() call retries the load
	// rather than immediately re-resolving with a permanently rejected promise.
	p.catch(() => { state.agent3dReady = null; });
	return p;
}

function setChipsEnabled(on) {
	for (const c of [els.animIdle, els.animWalk, els.animWave]) c.disabled = !on;
}

async function showResult(glbUrl) {
	state.glbUrl = glbUrl;
	els.download.href = glbUrl;

	try {
		await loadAgent3d();
		await customElements.whenDefined('agent-3d');
	} catch {
		// Viewer bundle unavailable — still give them the file + share link.
		showError(
			'Preview unavailable',
			'Your avatar is ready to download, but the 3D preview couldn’t load here. Try the Download button.',
		);
		return;
	}

	els.viewer.replaceChildren();
	const el = document.createElement('agent-3d');
	el.setAttribute('src', glbUrl);
	el.setAttribute('clip', 'idle');
	el.setAttribute('background', 'transparent');
	el.setAttribute('responsive', '');
	el.style.width = '100%';
	el.style.height = '100%';
	els.viewer.appendChild(el);
	state.viewerEl = el;

	// Chips stay disabled until the scene actually mounts, so a click can't
	// no-op while the avatar is still loading (which would desync the active
	// chip). The avatar idles on its own via the `clip` attribute meanwhile.
	state.viewerReady = false;
	setChipsEnabled(false);
	setActiveChip(els.animIdle);
	const onReady = () => {
		if (state.viewerEl !== el) return; // a newer avatar took over
		clearTimeout(state.readyFallback);
		state.viewerReady = true;
		setChipsEnabled(true);
	};
	el.addEventListener('agent:ready', onReady, { once: true });
	// Defensive: never strand the controls if that event doesn't arrive.
	clearTimeout(state.readyFallback);
	state.readyFallback = setTimeout(onReady, 6000);

	setStage('result');
}

function setActiveChip(active) {
	for (const c of [els.animIdle, els.animWalk, els.animWave]) {
		const on = c === active;
		c.classList.toggle('is-active', on);
		c.setAttribute('aria-pressed', String(on));
	}
}

function playClip(name, chip) {
	const el = state.viewerEl;
	if (!el || !state.viewerReady) return;
	try {
		if (name === 'wave' && typeof el.wave === 'function') el.wave();
		else if (typeof el.playClip === 'function') el.playClip(name, { userInitiated: true });
		else if (typeof el.play === 'function') el.play(name, { loop: name !== 'wave' });
	} catch {
		/* a single clip miss shouldn't break the toolbar */
	}
	// Wave is a one-shot that settles back into idle — reflect that in the UI.
	setActiveChip(name === 'wave' ? els.animIdle : chip);
}

// ── Share ───────────────────────────────────────────────────────────────────

function shareUrl() {
	const u = new URL('/dad', location.origin);
	u.searchParams.set('a', state.glbUrl);
	return u.toString();
}

async function share() {
	if (!state.glbUrl) return; // nothing to share (e.g. preview-unavailable path)
	const url = shareUrl();
	const shareData = {
		title: 'My dad, in 3D',
		text: 'I turned my dad into a 3D avatar on three.ws. Happy Father’s Day.',
		url,
	};
	if (navigator.share) {
		try {
			await navigator.share(shareData);
			return;
		} catch {
			/* user dismissed the sheet — fall through to copy */
		}
	}
	try {
		await navigator.clipboard.writeText(url);
		els.shareCopied.hidden = false;
		clearTimeout(share._t);
		share._t = setTimeout(() => {
			els.shareCopied.hidden = true;
		}, 2600);
	} catch {
		window.prompt('Copy this link to share your dad:', url);
	}
}

function isAllowedGlbUrl(raw) {
	let url;
	try {
		url = new URL(raw, location.origin);
	} catch {
		return false;
	}
	if (!/^https?:$/.test(url.protocol)) return false;
	if (url.origin === location.origin) return true;
	return ALLOWED_GLB_HOST.test(url.hostname);
}

// Render a shared avatar straight from a permalink (?a=<glb url>).
async function maybeRenderShared() {
	const a = new URL(location.href).searchParams.get('a');
	if (!a) return false;
	// Only load GLBs from our origin or known provider CDNs — a crafted ?a= must
	// not make the browser parse arbitrary bytes on the three.ws origin.
	if (!isAllowedGlbUrl(a)) return false;
	setStage('generating');
	els.progressText.textContent = 'Loading the shared avatar…';
	await showResult(new URL(a, location.origin).toString());
	return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function isDone(status) {
	const s = String(status || '').toLowerCase();
	return s === 'succeeded' || s === 'completed' || s === 'done' || s === 'success';
}

function isFailed(status) {
	const s = String(status || '').toLowerCase();
	return s === 'failed' || s === 'error' || s === 'canceled' || s === 'cancelled';
}

function revokeLocal() {
	if (state.localObjectUrl) {
		URL.revokeObjectURL(state.localObjectUrl);
		state.localObjectUrl = null;
	}
}

function reset() {
	runId += 1; // invalidate any in-flight upload/matte chain
	clearTimeout(state.readyFallback);
	revokeLocal();
	state.sourceUrl = null;
	state.glbUrl = null;
	state.viewerEl = null;
	state.viewerReady = false;
	els.viewer.replaceChildren();
	els.file.value = '';
	els.shareCopied.hidden = true;
	// Drop ?a= so a reset from a shared link returns to the uploader cleanly.
	if (new URL(location.href).searchParams.has('a')) {
		history.replaceState(null, '', '/dad');
	}
	setStage('intro');
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function pickFile() {
	els.file.click();
}

els.drop.addEventListener('click', pickFile);
els.drop.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' || e.key === ' ') {
		e.preventDefault();
		pickFile();
	}
});
els.file.addEventListener('change', () => {
	const f = els.file.files?.[0];
	if (f) handleFile(f);
});

for (const evt of ['dragenter', 'dragover']) {
	els.drop.addEventListener(evt, (e) => {
		e.preventDefault();
		els.drop.classList.add('is-drag');
	});
}
for (const evt of ['dragleave', 'drop']) {
	els.drop.addEventListener(evt, (e) => {
		e.preventDefault();
		els.drop.classList.remove('is-drag');
	});
}
els.drop.addEventListener('drop', (e) => {
	const f = e.dataTransfer?.files?.[0];
	if (f) handleFile(f);
});

els.generate.addEventListener('click', generate);
els.retry.addEventListener('click', () => {
	if (state.sourceUrl) generate();
	else reset();
});
els.share.addEventListener('click', share);

// A cross-origin <a download> is ignored by the browser (it navigates to the
// binary instead). Fetch the GLB and download the blob; fall back to opening it
// if the provider CDN blocks the cross-origin fetch.
els.download.addEventListener('click', async (e) => {
	if (!state.glbUrl) return;
	e.preventDefault();
	try {
		const r = await fetch(state.glbUrl);
		if (!r.ok) throw new Error('fetch failed');
		const blob = await r.blob();
		const u = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = u;
		a.download = 'dad-avatar.glb';
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(u), 1000);
	} catch {
		window.open(state.glbUrl, '_blank', 'noopener');
	}
});

els.animIdle.addEventListener('click', () => playClip('idle', els.animIdle));
els.animWalk.addEventListener('click', () => playClip('walk', els.animWalk));
els.animWave.addEventListener('click', () => playClip('wave', els.animWave));

for (const id of ['dad-reset-1', 'dad-reset-2', 'dad-reset-3']) {
	document.getElementById(id)?.addEventListener('click', reset);
}

window.addEventListener('beforeunload', revokeLocal);

maybeRenderShared().then((shared) => {
	if (!shared) setStage('intro');
});
