// Library → Animations tab.
// Aggregates animation clips from every agent the user owns
// (agent.meta.animations is the canonical store). Upload uses the same
// presign → R2 PUT → PATCH agents/:id/animations flow as the legacy dashboard.
// Supports .glb, .fbx, and .bvh inputs — FBX and BVH are converted to GLB
// client-side via three.js loaders before upload.

import { get, put, post, esc, relTime } from '../../api.js';
import { emptyStateHTML, errorStateHTML, attachRetry } from '../../../shared/state-kit.js';

function friendly(err) {
	if (!err) return 'Something went wrong.';
	const status = err.status || 0;
	const msg = err.message || String(err);
	if (status === 401 || /unauthorized|sign in|bearer/i.test(msg)) return 'Your session expired — refresh the page.';
	if (status === 403 || /forbidden/i.test(msg))                   return "You don't have permission for that.";
	if (status === 429 || /rate.?limit/i.test(msg))                 return 'Slow down — try again in a moment.';
	if (status === 413 || /too large/i.test(msg))                   return 'File is too large.';
	return msg.replace(/^HTTP\s+\d+\s*/i, '') || 'Upload failed.';
}

/**
 * Convert an FBX or BVH file to a GLB binary File object.
 * If the input is already .glb it is returned unchanged.
 *
 * @param {File} file       - The source file.
 * @param {(msg:string)=>void} onStatus - Called with progress messages.
 * @returns {Promise<File>} - A .glb File ready for upload.
 */
async function convertToGlb(file, onStatus) {
	const ext = file.name.split('.').pop().toLowerCase();

	if (ext === 'glb') return file;

	const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
	const { Object3D } = await import('three');

	const readAsArrayBuffer = (f) =>
		new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = () => reject(new Error('Failed to read file'));
			reader.readAsArrayBuffer(f);
		});

	const exportGlb = (scene, animations) =>
		new Promise((resolve, reject) => {
			const exporter = new GLTFExporter();
			exporter.parse(
				scene,
				(glb) => resolve(glb),
				(err) => reject(new Error(`GLTFExporter error: ${err?.message || err}`)),
				{ binary: true, animations },
			);
		});

	if (ext === 'fbx') {
		onStatus('Reading FBX file…');
		const buffer = await readAsArrayBuffer(file);

		onStatus('Parsing FBX…');
		const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
		const loader = new FBXLoader();
		const fbxScene = loader.parse(buffer, '');

		const animations = fbxScene.animations || [];
		if (!animations.length) throw new Error('No animation tracks found in this FBX file.');

		onStatus(`Converting ${animations.length} clip${animations.length > 1 ? 's' : ''} to GLB…`);
		const glbBuffer = await exportGlb(fbxScene, animations);

		const baseName = file.name.replace(/\.fbx$/i, '.glb');
		return new File([glbBuffer], baseName, { type: 'model/gltf-binary' });
	}

	if (ext === 'bvh') {
		onStatus('Reading BVH file…');
		const text = await file.text();

		onStatus('Parsing BVH skeleton and clip…');
		const { BVHLoader } = await import('three/addons/loaders/BVHLoader.js');
		const loader = new BVHLoader();
		const result = loader.parse(text);

		if (!result.clip || !result.clip.tracks?.length) {
			throw new Error('No animation tracks found in this BVH file.');
		}

		onStatus('Building scene hierarchy…');
		// BVHLoader gives us a raw skeleton; wire the root bone into an Object3D
		// so GLTFExporter can traverse the hierarchy.
		const root = new Object3D();
		root.name = 'BVHRoot';
		if (result.skeleton?.bones?.length) {
			root.add(result.skeleton.bones[0]);
		}

		onStatus('Converting BVH to GLB…');
		const glbBuffer = await exportGlb(root, [result.clip]);

		const baseName = file.name.replace(/\.bvh$/i, '.glb');
		return new File([glbBuffer], baseName, { type: 'model/gltf-binary' });
	}

	throw new Error(`Unsupported format ".${ext}". Please use .glb, .fbx, or .bvh.`);
}

/** Derive a title-cased clip name from a filename (strip extension, replace separators). */
function clipNameFromFilename(filename) {
	const base = filename.replace(/\.[^.]+$/, ''); // strip extension
	return base
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

export async function renderAnimations(host) {
	host.innerHTML = `
		<div class="anim-head">
			<div>
				<h2 class="dn-panel-title" style="font-size:17px;margin:0 0 4px">Your animation library</h2>
				<div class="dn-panel-sub" style="margin:0">Clips attached to any of your agents. Uploading adds a clip to the agent you select.</div>
			</div>
			<div class="anim-head-actions">
				<a class="dn-btn ghost" href="/temporary">Browse presets →</a>
				<button class="dn-btn primary" id="anim-upload-open" type="button">Upload clip (.glb / .fbx / .bvh)</button>
			</div>
		</div>

		<div id="anim-grid" class="anim-grid"></div>

		<dialog id="anim-upload" class="anim-dialog">
			<form method="dialog" class="anim-upload-form">
				<h3 style="margin:0 0 4px">Upload animation clip</h3>
				<p class="dn-panel-sub" style="margin:0 0 12px">Drop a .glb, .fbx, or .bvh animation clip. FBX and BVH are converted to GLB automatically before uploading.</p>

				<label class="anim-field">
					<span>Attach to agent</span>
					<select id="anim-up-agent" required></select>
				</label>

				<label class="anim-field">
					<span>Clip name</span>
					<input id="anim-up-name" type="text" maxlength="60" placeholder="e.g. my-wave" required />
				</label>

				<label class="anim-field">
					<span>.glb, .fbx, or .bvh file (max 100 MB)</span>
					<input id="anim-up-file" type="file" accept=".glb,.fbx,.bvh,model/gltf-binary" required />
				</label>

				<label class="anim-field-row">
					<input id="anim-up-loop" type="checkbox" checked />
					<span>Loop this clip</span>
				</label>

				<div id="anim-up-status" class="anim-up-status"></div>
				<div id="anim-up-error"  class="anim-up-error"></div>

				<div class="anim-up-actions">
					<button type="button" id="anim-up-cancel" class="dn-btn ghost">Cancel</button>
					<button type="button" id="anim-up-submit" class="dn-btn primary">Upload &amp; attach</button>
				</div>
			</form>
		</dialog>

		<style>
			.anim-head { display:flex; align-items:flex-end; justify-content:space-between; gap:14px; margin-bottom:14px; flex-wrap:wrap; }
			.anim-head-actions { display:flex; gap:8px; flex-wrap:wrap; }
			.anim-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }
			.anim-card { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:8px; transition:border-color .15s, background .15s; }
			.anim-card:hover { border-color:rgba(255,255,255,0.18); background:rgba(255,255,255,0.04); }
			.anim-card-title { font-size:14px; font-weight:600; color:var(--nxt-ink); word-break:break-word; }
			.anim-card-meta { display:flex; flex-wrap:wrap; gap:6px; }
			.anim-card-agent { font-size:11px; color:var(--nxt-ink-fade); }
			.anim-dialog { border:none; background:#11111a; color:var(--nxt-ink); border-radius:14px; padding:0; max-width:480px; width:90vw; }
			.anim-dialog::backdrop { background:rgba(0,0,0,0.6); }
			.anim-upload-form { padding:22px 22px 20px; display:flex; flex-direction:column; gap:12px; }
			.anim-field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--nxt-ink-dim); }
			.anim-field input[type="text"], .anim-field input[type="file"], .anim-field select {
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit;
			}
			.anim-field-row { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--nxt-ink-dim); }
			.anim-up-status { font-size:12px; color:var(--nxt-ink-fade); min-height:16px; }
			.anim-up-error  { font-size:12px; color:#969ba3; min-height:16px; }
			.anim-up-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
		</style>
	`;

	const grid = host.querySelector('#anim-grid');

	let agents = [];
	try {
		const res = await get('/api/agents');
		agents = res?.agents || [];
	} catch (err) {
		grid.innerHTML = errorStateHTML({ title: "Couldn't load agents", body: esc(friendly(err)) });
		attachRetry(grid, () => renderAnimations(host));
		return;
	}

	const allClips = [];
	for (const a of agents) {
		const clips = Array.isArray(a.meta?.animations) ? a.meta.animations : [];
		for (const c of clips) allClips.push({ ...c, _agent: a });
	}

	if (!allClips.length) {
		const hasAgents = agents.length > 0;
		grid.innerHTML = emptyStateHTML({
			icon: '🎬',
			title: 'No animations yet',
			body: hasAgents
				? 'Upload a .glb, .fbx, or .bvh clip to attach it to an agent, or pick from our mocap library.'
				: 'Create an agent first — clips attach to an agent. You can still browse the preset library below.',
			actions: hasAgents
				? [
					{ label: 'Upload a clip', id: 'anim-empty-upload', primary: true },
					{ label: 'Browse presets →', href: '/temporary' },
				]
				: [
					{ label: 'Create an agent', href: '/create', primary: true },
					{ label: 'Browse presets →', href: '/temporary' },
				],
		});
		grid.querySelector('[data-sk-action="anim-empty-upload"]')?.addEventListener('click', () => openUploadDialog(host, agents, refresh));
	} else {
		for (const c of allClips) grid.appendChild(clipCard(c));
	}

	host.querySelector('#anim-upload-open')?.addEventListener('click', () => openUploadDialog(host, agents, refresh));

	async function refresh() {
		await renderAnimations(host);
	}
}

function clipCard(clip) {
	const div = document.createElement('div');
	div.className = 'anim-card';
	const sourceTag = clip.source === 'preset'
		? '<span class="dn-tag success">preset</span>'
		: clip.source === 'mixamo'
			? '<span class="dn-tag">mocap</span>'
			: '<span class="dn-tag warn">uploaded</span>';
	const loopTag = clip.loop === false ? '' : '<span class="dn-tag">loops</span>';
	const added = clip.addedAt ? `added ${esc(relTime(clip.addedAt))}` : '';
	div.innerHTML = `
		<div class="anim-card-title">${esc(clip.name || 'unnamed')}</div>
		<div class="anim-card-meta">${sourceTag}${loopTag}</div>
		<div class="anim-card-agent">on <strong>${esc(clip._agent?.name || 'agent')}</strong>${added ? ' · ' + added : ''}</div>
	`;
	return div;
}

function openUploadDialog(host, agents, onDone) {
	const dialog = host.querySelector('#anim-upload');
	const agentSel = dialog.querySelector('#anim-up-agent');
	agentSel.innerHTML = agents
		.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`)
		.join('');
	if (!agents.length) {
		agentSel.innerHTML = '<option value="" disabled>No agents — create one first</option>';
	}
	dialog.querySelector('#anim-up-name').value = '';
	dialog.querySelector('#anim-up-file').value = '';
	dialog.querySelector('#anim-up-loop').checked = true;
	dialog.querySelector('#anim-up-status').textContent = '';
	dialog.querySelector('#anim-up-error').textContent = '';

	// Auto-fill clip name from filename when a file is picked.
	// Use onchange (assignment) rather than addEventListener so re-opening the
	// shared <dialog> doesn't stack duplicate handlers.
	dialog.querySelector('#anim-up-file').onchange = (e) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const nameInput = dialog.querySelector('#anim-up-name');
		if (!nameInput.value.trim()) {
			nameInput.value = clipNameFromFilename(file.name);
		}
	};

	dialog.querySelector('#anim-up-cancel').onclick = () => dialog.close();
	dialog.querySelector('#anim-up-submit').onclick = async () => {
		const agentId  = agentSel.value;
		const name     = dialog.querySelector('#anim-up-name').value.trim();
		const file     = dialog.querySelector('#anim-up-file').files?.[0];
		const loop     = dialog.querySelector('#anim-up-loop').checked;
		const statusEl = dialog.querySelector('#anim-up-status');
		const errorEl  = dialog.querySelector('#anim-up-error');
		const submitBtn = dialog.querySelector('#anim-up-submit');
		errorEl.textContent = '';

		if (!agentId) { errorEl.textContent = 'Select an agent.'; return; }
		if (!name)    { errorEl.textContent = 'Clip name is required.'; return; }
		if (!file) {
			errorEl.textContent = 'Pick a .glb, .fbx, or .bvh file.';
			return;
		}

		const ext = file.name.split('.').pop().toLowerCase();
		if (!['glb', 'fbx', 'bvh'].includes(ext)) {
			errorEl.textContent = 'Pick a .glb, .fbx, or .bvh file.';
			return;
		}

		const agent = agents.find((a) => a.id === agentId);
		const current = Array.isArray(agent?.meta?.animations) ? [...agent.meta.animations] : [];
		if (current.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
			errorEl.textContent = `"${name}" is already attached to this agent.`;
			return;
		}

		submitBtn.disabled = true;
		try {
			// Convert FBX/BVH → GLB if needed
			statusEl.textContent = ext === 'glb' ? 'Preparing…' : 'Converting…';
			const glbFile = await convertToGlb(file, (msg) => { statusEl.textContent = msg; });

			statusEl.textContent = 'Requesting upload URL…';
			const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anim';
			const presign = await post('/api/animations/presign', {
				size_bytes: glbFile.size,
				content_type: 'model/gltf-binary',
				slug,
			});

			statusEl.textContent = `Uploading ${(glbFile.size / 1024 / 1024).toFixed(1)} MB…`;
			await uploadFile(presign.upload_url, glbFile, (pct) => {
				statusEl.textContent = `Uploading ${pct}%…`;
			});

			const nextClips = [
				...current,
				{ name, url: presign.storage_key, loop, source: 'custom', addedAt: new Date().toISOString() },
			];
			statusEl.textContent = 'Attaching to agent…';
			await put(`/api/agents/${encodeURIComponent(agentId)}/animations`, { animations: nextClips });

			statusEl.textContent = 'Done.';
			dialog.close();
			onDone?.();
		} catch (err) {
			statusEl.textContent = '';
			errorEl.textContent = friendly(err);
		} finally {
			submitBtn.disabled = false;
		}
	};

	dialog.showModal();
}

function uploadFile(url, file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		xhr.setRequestHeader('content-type', 'model/gltf-binary');
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
		};
		xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
			? resolve()
			: reject(new Error(`Upload failed (${xhr.status})`)));
		xhr.onerror = () => reject(new Error('Network error during upload'));
		xhr.send(file);
	});
}
