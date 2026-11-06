/**
 * Prompt → 3D avatar controller for the merged Studio page (/forge-studio).
 *
 * This is an isolated copy of src/create-prompt.js, restructured for the merged
 * page so it can never interfere with the live /create/prompt page:
 *   - Every DOM id is namespaced `cp-*` (the live page keeps the bare ids).
 *   - All markup lives under `#studio-avatar`; class queries are scoped to it
 *     so they don't pick up Forge's `.step`/`.example`/`.composer` elements.
 *   - Nothing runs at import time. `initCreatePrompt()` is called once, the
 *     first time the user switches to the Avatar mode, by forge-studio.html.
 *
 * Flow (reuses the same backend as the selfie pipeline):
 *   prompt text
 *     -> POST /api/avatars/reconstruct { name, prompt, visibility }
 *          (server turns the prompt into a frontal reference image via Flux,
 *           then runs the identical reconstruct -> auto-rig pipeline)
 *     -> poll /api/avatars/regenerate-status?jobId=...
 *     -> on { status:'done', resultAvatarId } -> fetch the avatar, preview it,
 *        and offer "Open in editor" / "Make another"
 */

import { log } from '../shared/log.js';

const SUBMIT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000;
const RETURN_PATH = '/forge-studio';
const ROOT_SEL = '#studio-avatar';

const root = () => /** @type {HTMLElement} */ (document.querySelector(ROOT_SEL));
const $ = (sel) => /** @type {HTMLElement} */ (root()?.querySelector(sel));

let _inited = false;
let _submitting = false;
let _startedAt = 0;
let _elapsedTimer = 0;

// Resolved in initCreatePrompt() once the markup is in the DOM.
let promptEl, counterEl, generateBtn, composeError, buildError, buildPrompt, buildStatus, progressFill, elapsedEl;

function showStep(step) {
	for (const el of root().querySelectorAll('.step')) {
		el.classList.toggle('active', el.getAttribute('data-step') === step);
	}
}

function setError(box, message) {
	if (!box) return;
	if (message) {
		box.innerHTML = message;
		box.classList.add('show');
	} else {
		box.textContent = '';
		box.classList.remove('show');
	}
}

// ── Compose ─────────────────────────────────────────────────────────────────

function updateCounter() {
	const n = promptEl.value.length;
	counterEl.textContent = `${n} / 600`;
	counterEl.classList.toggle('warn', n > 600);
	generateBtn.disabled = promptEl.value.trim().length < 3 || _submitting;
}

// ── Submit + poll ────────────────────────────────────────────────────────────

function nameFromPrompt(prompt) {
	const words = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
	return (words.length > 60 ? words.slice(0, 60) : words) || 'Prompt avatar';
}

async function start() {
	if (_submitting) return;
	const prompt = promptEl.value.trim();
	if (prompt.length < 3) {
		setError(composeError, 'Add a few words describing what you want.');
		return;
	}

	_submitting = true;
	generateBtn.disabled = true;
	setError(composeError, '');

	buildPrompt.textContent = `“${prompt}”`;
	setError(buildError, '');
	setProgress(8, 'Rendering a reference image…');
	startElapsed();
	showStep('building');

	let jobId;
	try {
		const res = await fetch(SUBMIT_ENDPOINT, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: nameFromPrompt(prompt), prompt, visibility: 'private' }),
		});
		if (res.status === 401) {
			window.location.assign(`/login?next=${encodeURIComponent(RETURN_PATH)}`);
			return;
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.jobId) {
			throw new ApiError(mapSubmitError(res.status, data));
		}
		jobId = data.jobId;
	} catch (err) {
		failBuild(err);
		return;
	}

	try {
		const final = await pollUntilDone(jobId);
		await renderDone(final.resultAvatarId);
	} catch (err) {
		failBuild(err);
	}
}

class ApiError extends Error {}

/** @param {string | null | undefined} raw */
function friendlyJobError(raw) {
	if (!raw) return 'Generation failed. Try a different prompt.';
	const lower = raw.toLowerCase();
	if (lower.includes('face') && (lower.includes('detect') || lower.includes('no face')))
		return 'Couldn\'t find a face in the generated reference image. Try rewording your prompt to describe the person more clearly.';
	if (lower.includes('nsfw'))
		return 'Content safety blocked this image. Try a different prompt.';
	if (lower.includes('unreachable') || lower.includes('502') || lower.includes('503'))
		return 'The avatar engine is temporarily unavailable. Try again in a few minutes.';
	if (lower.includes('timeout') || lower.includes('timed out'))
		return 'The engine took too long. Try again in a moment.';
	if (lower.includes('oom') || lower.includes('memory'))
		return 'The engine ran out of resources. Try a simpler prompt.';
	return 'Generation failed. Try a different prompt.';
}

function mapSubmitError(status, data) {
	// The API error envelope is { error: <code string>, error_description: <message> }
	// (see api/_lib/http.js error()). Read those fields directly.
	const code = typeof data?.error === 'string' ? data.error : data?.code;
	const description = data?.error_description;
	if (code === 'txt2img_rate_limited' || status === 429) {
		return 'The image engine is busy right now — wait a moment and try again.';
	}
	if (code === 'regen_unconfigured' || code === 'txt2img_unconfigured') {
		return 'The avatar generator isn\'t configured on this deployment yet. Try the <a href="/create/selfie">selfie scanner</a> instead.';
	}
	if (code === 'txt2img_billing') return 'The image engine is temporarily unavailable (provider billing). Try again later.';
	if (code === 'txt2img_unreachable') return 'Couldn\'t reach the image engine. Check your connection and try again.';
	if (code === 'txt2img_error') return 'Couldn\'t render a reference image from that prompt. Try rewording it.';
	if (code === 'regen_needs_byok')
		return 'Avatar generation needs a 3D engine key on this deployment. Add a Meshy or Tripo key in <a href="/settings">settings</a>, or try the <a href="/create/selfie">selfie scanner</a>.';
	if (code === 'regen_provider_error')
		return 'The avatar engines are all busy right now. Try again in a moment, or use the <a href="/create/selfie">selfie scanner</a> instead.';
	return description || `The avatar engine returned ${status}. Try again.`;
}

async function pollUntilDone(jobId) {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		let data;
		try {
			const res = await fetch(`${STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`, {
				credentials: 'include',
			});
			if (res.status === 401) {
				window.location.assign(`/login?next=${encodeURIComponent(RETURN_PATH)}`);
				throw new ApiError('redirecting');
			}
			data = await res.json().catch(() => ({}));
			if (!res.ok) throw new ApiError(data?.error_description || `status ${res.status}`);
		} catch (err) {
			if (err instanceof ApiError) throw err;
			// Transient network blip — keep polling until the deadline.
			log.warn('[studio-prompt] poll blip', err);
			continue;
		}

		advanceProgress(data.status);

		if (data.status === 'done' && data.resultAvatarId) {
			setProgress(100, 'Done.');
			return data;
		}
		if (data.status === 'failed') {
			throw new ApiError(friendlyJobError(data.error));
		}
	}
	throw new ApiError('This is taking longer than expected. Your avatar may still finish — check your dashboard in a minute.');
}

// Map backend job states to human progress. The bar creeps within each phase so
// it always feels alive, then jumps on real state transitions.
const PHASE = {
	queued: { pct: 18, label: 'Rendering a reference image…' },
	running: { pct: 55, label: 'Reconstructing it into 3D…' },
	rigging: { pct: 85, label: 'Adding a skeleton so it can move…' },
};
function advanceProgress(status) {
	const phase = PHASE[status];
	if (phase) setProgress(phase.pct, phase.label);
}
function setProgress(pct, label) {
	progressFill.style.width = `${pct}%`;
	if (label) buildStatus.textContent = label;
}

// ── Done ─────────────────────────────────────────────────────────────────────

async function renderDone(avatarId) {
	let avatar = null;
	try {
		const res = await fetch(`/api/avatars/${encodeURIComponent(avatarId)}`, { credentials: 'include' });
		const data = await res.json().catch(() => ({}));
		avatar = data?.avatar || data || null;
	} catch (err) {
		log.warn('[studio-prompt] could not fetch finished avatar', err);
	}

	const editorUrl = `/avatars/${encodeURIComponent(avatarId)}/edit`;
	$('#cp-open-editor').setAttribute('href', editorUrl);
	$('#cp-make-another').addEventListener('click', () => resetToCompose());

	const modelUrl = avatar?.model_url || avatar?.modelUrl;
	const viewer = /** @type {any} */ ($('#cp-done-model'));
	if (modelUrl && viewer) viewer.setAttribute('src', modelUrl);

	// Bring it alive — hand the finished avatar to the real talk stack (voice in,
	// LLM brain, voice out, lip-sync). Per-agent memory rides along via agent_id.
	const talkBtn = $('#cp-talk');
	if (talkBtn) {
		const name = avatar?.display_name || avatar?.name || 'Your avatar';
		talkBtn.hidden = !modelUrl;
		talkBtn.addEventListener('click', async () => {
			talkBtn.disabled = true;
			try {
				const { launchTalk } = await import('./talk-launch.js');
				await launchTalk({ name, glbUrl: modelUrl, id: avatarId, agentId: avatar?.agent_id, kind: 'avatar' });
			} catch (err) {
				log.error('[studio-prompt] talk', err);
			} finally {
				talkBtn.disabled = false;
			}
		});
	}

	const rigged = avatar?.source_meta?.is_rigged ?? avatar?.tags?.includes?.('rigged');
	const tagsEl = $('#cp-done-tags');
	tagsEl.innerHTML = '';
	const tag = (text, ok) => {
		const s = document.createElement('span');
		s.className = `tag${ok ? ' ok' : ''}`;
		s.textContent = text;
		tagsEl.appendChild(s);
	};
	if (rigged) tag('Animation-ready', true);
	else tag('Static mesh — riggable in editor', false);
	tag('Private to you', false);

	stopElapsed();
	// If the model can't render (no URL yet), go straight to the editor rather
	// than showing an empty viewer box.
	if (!modelUrl) {
		window.location.assign(editorUrl);
		return;
	}
	showStep('done');
	// Let the site-wide discovery layer offer the natural next steps
	// (Studio, agent wizard, Walk) with this avatar pre-loaded.
	document.dispatchEvent(
		new CustomEvent('tws:feature-done', {
			detail: {
				feature: 'prompt',
				avatarId,
				model: {
					glbUrl: modelUrl,
					label: avatar?.display_name || avatar?.name || 'Prompt avatar',
				},
			},
		}),
	);
}

function resetToCompose() {
	_submitting = false;
	stopElapsed();
	setError(composeError, '');
	updateCounter();
	showStep('compose');
	promptEl.focus();
}

// ── Failure ──────────────────────────────────────────────────────────────────

function failBuild(err) {
	if (err instanceof ApiError && err.message === 'redirecting') return;
	stopElapsed();
	_submitting = false;
	log.error('[studio-prompt]', err);
	const message =
		err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
	setError(buildError, `${message} <button id="cp-build-retry" class="example" style="margin-left:8px">Back</button>`);
	const retry = root().querySelector('#cp-build-retry');
	if (retry) retry.addEventListener('click', resetToCompose);
}

// ── Elapsed clock ────────────────────────────────────────────────────────────

function startElapsed() {
	_startedAt = Date.now();
	stopElapsed();
	_elapsedTimer = window.setInterval(() => {
		const s = Math.floor((Date.now() - _startedAt) / 1000);
		elapsedEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}, 1000);
}
function stopElapsed() {
	if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = 0; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Init (called once, lazily, by the mode switch) ────────────────────────────

export function initCreatePrompt() {
	if (_inited) return;
	const scope = root();
	if (!scope) return;
	_inited = true;

	promptEl = /** @type {HTMLTextAreaElement} */ ($('#cp-prompt'));
	counterEl = $('#cp-counter');
	generateBtn = /** @type {HTMLButtonElement} */ ($('#cp-generate-btn'));
	composeError = $('#cp-compose-error');
	buildError = $('#cp-build-error');
	buildPrompt = $('#cp-build-prompt');
	buildStatus = $('#cp-build-status');
	progressFill = $('#cp-progress-fill');
	elapsedEl = $('#cp-elapsed');

	promptEl.addEventListener('input', () => {
		updateCounter();
		if (composeError.classList.contains('show')) setError(composeError, '');
	});

	// Cmd/Ctrl+Enter submits.
	promptEl.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !generateBtn.disabled) {
			e.preventDefault();
			start();
		}
	});

	for (const chip of scope.querySelectorAll('.example')) {
		chip.addEventListener('click', () => {
			promptEl.value = chip.textContent.trim();
			updateCounter();
			promptEl.focus();
		});
	}

	generateBtn.addEventListener('click', start);

	updateCounter();
}

export function focusPrompt() {
	if (promptEl) promptEl.focus();
}
