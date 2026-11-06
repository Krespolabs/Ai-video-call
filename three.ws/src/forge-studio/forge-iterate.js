// Iterate — conversational, iterative 3D refinement layered onto the forge
// result viewer.
//
// Talk to the model you just generated: describe a change ("make it
// metallic", "bigger helmet", "add wings") and Apply re-generates a NEW
// version anchored to the current one — the prior prompt carries forward and
// the change folds in, so form/subject/materials persist. Real generation,
// never a faked diff: api/forge-iterate.js runs composeRefinement, the same
// pure core mcp-server/src/tools/refine-model.js (the paid MCP tool) and the
// free /api/mcp-studio endpoint use, so wording behaves identically
// everywhere on three.ws.
//
// Every application is recorded in an immutable version lineage (parent →
// child) rendered as a strip of chips below the prompt box: click an earlier
// version to revert the viewer to it instantly (no network call — the GLB is
// already known), or Apply again from that point to branch a new line of
// versions off it. History is never mutated, only extended.
//
// A successful iteration is a REAL owned creation — unlike the free studio's
// refine_model (a server-to-server call with no client identity),
// api/forge-iterate.js forwards this browser's x-forge-client through to
// /api/forge, so the result lands in the gallery and can be published to the
// remix bazaar exactly like a fresh generation. It re-broadcasts
// forge:model-ready, so every other result-panel tool (Stylize, Optimize,
// local Refine, Embed, AR, Remix) treats the new version as the live model.

const resultPanel = document.getElementById('state-result');
const viewer = document.getElementById('viewer');
const viewerShell = document.getElementById('viewer-shell');

if (resultPanel && viewer) {
	// Reuse the forge anonymous client id (set by forge.js) so an iteration is
	// attributed to the same owner as the model it started from.
	const CLIENT_HEADERS = (() => {
		try {
			const id = localStorage.getItem('forge:cid');
			return id ? { 'x-forge-client': id } : {};
		} catch {
			return {};
		}
	})();

	injectStyles();
	const { panel, input, applyBtn, strip, status, downloadLink } = injectPanel();

	// The model this panel is anchored to — updated on every genuine new source
	// (a real forge.js generation, or one of our own applied iterations).
	// Equality-guarded against our own forge:model-ready echo.
	let current = { glbUrl: '', prompt: '', creationId: null };
	let lineage = null; // null until the first Apply; then an immutable array
	let activeIndex = 0;
	let busy = false;
	let elapsedTimer = null;

	function setStatus(text, kind = '') {
		status.textContent = text || '';
		status.dataset.kind = kind;
	}

	function stopElapsed() {
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
	}

	function startElapsed(label) {
		stopElapsed();
		const t0 = performance.now();
		const tick = () => setStatus(`${label} — ${Math.floor((performance.now() - t0) / 1000)}s`, 'busy');
		tick();
		elapsedTimer = setInterval(tick, 1000);
	}

	function setBusy(next) {
		busy = next;
		applyBtn.disabled = next || !input.value.trim();
		input.disabled = next;
		for (const chip of strip.querySelectorAll('.iterate-chip')) chip.disabled = next;
		panel.dataset.busy = next ? 'true' : 'false';
	}

	// A real cross-fade, not a pop: the current model stays visible (dimmed)
	// until the next one has actually finished loading or failed — never a
	// blank or frozen frame.
	function crossfadeViewer(url) {
		viewerShell?.classList.add('is-loading');
		viewer.style.transition = 'opacity .22s ease';
		const restore = () => {
			viewer.style.opacity = '1';
			viewerShell?.classList.remove('is-loading');
		};
		viewer.addEventListener('load', restore, { once: true });
		viewer.addEventListener('error', restore, { once: true });
		viewer.style.opacity = '0.35';
		viewer.setAttribute('src', url);
	}

	function truncate(s, n) {
		const t = String(s || '');
		return t.length > n ? `${t.slice(0, n - 1)}…` : t;
	}

	function renderStrip() {
		strip.innerHTML = '';
		if (!lineage || lineage.length < 2) {
			strip.hidden = true;
			return;
		}
		strip.hidden = false;
		for (const v of lineage) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'iterate-chip';
			chip.dataset.index = String(v.index);
			chip.setAttribute('aria-pressed', String(v.index === activeIndex));
			chip.title = v.instruction || 'The original model';
			chip.textContent = v.index === 0 ? 'Original' : `v${v.index} · ${truncate(v.instruction || '', 22)}`;
			chip.addEventListener('click', () => selectVersion(v.index));
			strip.appendChild(chip);
		}
	}

	// Revert/branch point: an instant, no-network swap to an earlier version —
	// history is immutable, so this is only ever a pointer move.
	function selectVersion(index) {
		if (!lineage || busy) return;
		const v = lineage.find((x) => x.index === index);
		if (!v || index === activeIndex) return;
		activeIndex = index;
		current = { glbUrl: v.glbUrl, prompt: v.prompt || current.prompt, creationId: current.creationId };
		crossfadeViewer(v.glbUrl);
		downloadLink.href = v.glbUrl;
		downloadLink.hidden = false;
		renderStrip();
		setStatus(
			index === lineage.length - 1
				? 'Showing the latest version. Describe another change, or apply from here to keep going.'
				: 'Showing an earlier version — apply a change to branch a new line from here.',
			'',
		);
	}

	async function apply() {
		const instruction = input.value.trim();
		if (!instruction || busy || !current.glbUrl) return;
		setBusy(true);
		startElapsed('Iterating');
		try {
			const res = await fetch('/api/forge-iterate', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
				body: JSON.stringify({
					glb_url: current.glbUrl,
					instruction,
					parent_prompt: current.prompt || '',
					...(lineage ? { parent_lineage: lineage } : {}),
					...(lineage && activeIndex !== lineage.length - 1 ? { parent_index: activeIndex } : {}),
				}),
			});
			const data = await res.json().catch(() => ({}));
			stopElapsed();
			if (!res.ok || !data?.ok) {
				setBusy(false);
				const msg =
					res.status === 429
						? data?.message || 'Too many iterations right now — try again shortly.'
						: data?.message || 'That change could not be applied. Try rephrasing it.';
				setStatus(msg, 'error');
				return;
			}
			lineage = data.lineage;
			activeIndex = data.activeIndex;
			current = { glbUrl: data.glbUrl, prompt: data.prompt, creationId: data.creationId };
			crossfadeViewer(data.glbUrl);
			downloadLink.href = data.glbUrl;
			downloadLink.hidden = false;
			renderStrip();
			input.value = '';
			setStatus(`Applied: "${instruction}". Describe another change, or pick an earlier version to branch from.`, 'done');
			// A real, owned model — hand it to every other result-panel tool
			// (Stylize, Optimize, local Refine, Embed, AR, Remix) as the live model.
			document.dispatchEvent(
				new CustomEvent('forge:model-ready', {
					detail: { glbUrl: data.glbUrl, label: instruction, prompt: data.prompt, creationId: data.creationId },
				}),
			);
		} catch (err) {
			stopElapsed();
			setStatus(err?.message || 'Iteration failed. Check your connection and try again.', 'error');
		} finally {
			setBusy(false);
		}
	}

	input.addEventListener('input', () => {
		if (!busy) applyBtn.disabled = !input.value.trim();
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			apply();
		}
	});
	applyBtn.addEventListener('click', apply);

	function onNewSource(detail) {
		const glbUrl = detail?.glbUrl;
		if (!glbUrl || glbUrl === current.glbUrl) return; // ignore our own echo
		current = { glbUrl, prompt: detail.prompt || '', creationId: detail.creationId ?? null };
		lineage = null;
		activeIndex = 0;
		renderStrip();
		downloadLink.hidden = true;
		setBusy(false);
		input.value = '';
		setStatus('Describe a change and Apply — it regenerates a new version anchored to this one.', '');
		panel.hidden = false;
	}

	document.addEventListener('forge:model-ready', (e) => onNewSource(e.detail));
	if (viewer.getAttribute('src')) {
		onNewSource({ glbUrl: viewer.getAttribute('src'), prompt: '', creationId: null });
	}

	// ── markup + styles (self-contained so the panel survives template edits) ──

	function injectPanel() {
		const el = document.createElement('div');
		el.className = 'iterate-panel';
		el.id = 'iterate-panel';
		el.dataset.busy = 'false';
		el.hidden = true;
		el.innerHTML = `
			<div class="iterate-head">
				<h3>Iterate <span class="iterate-badge">Conversational · free</span></h3>
				<p class="iterate-sub">
					Talk to this model. Describe a change and it regenerates a new version
					anchored to the one you see — form and materials carry forward.
				</p>
			</div>
			<div class="iterate-row">
				<input
					type="text"
					id="iterate-input"
					class="iterate-input"
					placeholder='e.g. "make it metallic", "bigger helmet", "add wings"'
					maxlength="500"
					aria-label="Describe the change to make"
				/>
				<button class="btn" type="button" id="iterate-apply" disabled>Apply</button>
			</div>
			<div class="iterate-strip" id="iterate-strip" role="group" aria-label="Version history" hidden></div>
			<div class="iterate-foot">
				<a class="btn btn-ghost" id="iterate-download" download hidden>Download this version</a>
			</div>
			<div class="iterate-status" id="iterate-status" role="status" aria-live="polite"></div>
		`;
		// Sits above Stylize/Optimize/Refine — it's the primary "talk to your
		// model" interaction, the mesh-cleanup tools are secondary polish.
		const anchor = document.getElementById('stylize-panel');
		if (anchor && anchor.parentElement === resultPanel) anchor.before(el);
		else resultPanel.appendChild(el);
		return {
			panel: el,
			input: el.querySelector('#iterate-input'),
			applyBtn: el.querySelector('#iterate-apply'),
			strip: el.querySelector('#iterate-strip'),
			status: el.querySelector('#iterate-status'),
			downloadLink: el.querySelector('#iterate-download'),
		};
	}

	function injectStyles() {
		if (document.getElementById('iterate-panel-styles')) return;
		const style = document.createElement('style');
		style.id = 'iterate-panel-styles';
		style.textContent = `
			.iterate-panel { margin-top: var(--space-lg, 24px); padding-top: var(--space-md, 16px); border-top: 1px solid var(--stroke, rgba(255,255,255,.08)); }
			.iterate-head h3 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:0 0 4px; font-family: var(--font-display, inherit); font-size: var(--text-lg, 1.1rem); color: var(--ink, #fff); }
			.iterate-badge { font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing:.04em; text-transform:uppercase; color: var(--accent, #7c9cff); background: var(--accent-soft, rgba(124,156,255,.12)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: 999px; padding: 2px 8px; }
			.iterate-sub { margin:0 0 var(--space-md,16px); font-size: var(--text-sm, .85rem); color: var(--ink-dim, #9aa); line-height: var(--leading-normal, 1.5); max-width: 60ch; }
			.iterate-row { display:flex; gap: var(--space-sm, 10px); flex-wrap: wrap; }
			.iterate-input { flex: 1 1 240px; min-width: 0; padding: var(--space-sm,10px) var(--space-md,14px); background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-md, 10px); color: var(--ink, #fff); font-size: var(--text-sm, .9rem); }
			.iterate-input:focus-visible { outline: 2px solid var(--accent, #7c9cff); outline-offset: 1px; }
			.iterate-input:disabled { opacity: .6; }
			.iterate-row .btn:disabled { opacity: .5; cursor: progress; }
			.iterate-strip { display:flex; gap: var(--space-xs, 6px); flex-wrap: wrap; margin-top: var(--space-sm, 10px); }
			.iterate-chip { padding: 4px 10px; font-size: var(--text-xs, .72rem); border-radius: 999px; border: 1px solid var(--stroke, rgba(255,255,255,.1)); background: var(--surface-1, rgba(255,255,255,.03)); color: var(--ink-dim, #9aa); cursor: pointer; transition: border-color .15s, background .15s, color .15s; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.iterate-chip:hover { border-color: var(--stroke-strong, rgba(255,255,255,.25)); }
			.iterate-chip:focus-visible { outline: 2px solid var(--accent, #7c9cff); outline-offset: 2px; }
			.iterate-chip[aria-pressed="true"] { border-color: var(--accent, #7c9cff); background: var(--accent-soft, rgba(124,156,255,.12)); color: var(--ink, #fff); }
			.iterate-chip:disabled { opacity: .5; cursor: progress; }
			.iterate-foot { margin-top: var(--space-sm, 8px); }
			.iterate-status { margin-top: var(--space-sm,10px); font-size: var(--text-xs,.72rem); min-height: 1.2em; color: var(--ink-dim,#9aa); }
			.iterate-status[data-kind="busy"] { color: var(--accent, #7c9cff); }
			.iterate-status[data-kind="done"] { color: var(--success, #5fd38a); }
			.iterate-status[data-kind="error"] { color: var(--danger, #ff6b6b); }
			@media (prefers-reduced-motion: reduce) { .iterate-chip { transition: none; } }
		`;
		document.head.appendChild(style);
	}
}
