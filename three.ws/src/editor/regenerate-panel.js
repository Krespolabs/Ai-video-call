/**
 * RegeneratePanel — UI for avatar mesh/texture/rig regeneration.
 *
 * Usage:
 *   import { mountRegeneratePanel } from './regenerate-panel.js';
 *   mountRegeneratePanel(document.getElementById('regen-container'), {
 *     avatarId: 'uuid-…',
 *     onResult: (newAvatarId) => { … },
 *   });
 *
 * Do NOT auto-mount. Caller controls where and when the panel appears.
 */

const MODES = [
	{ value: 'remesh',  label: 'Re-mesh',   desc: 'Regenerate mesh topology' },
	{ value: 'retex',   label: 'Re-texture', desc: 'Rebuild materials and textures' },
	{ value: 'rerig',   label: 'Re-rig',     desc: 'Rebind the skeleton' },
	{ value: 'restyle', label: 'Re-style',   desc: 'Change appearance from description' },
];

const STATUS_LABELS = {
	queued:    'Queued — waiting for a worker…',
	running:   'Running…',
	done:      'Complete',
	failed:    'Failed',
};

const CSS = `
.rp-root {
	padding: 20px;
	border-top: 1px solid var(--border, #1a1a1a);
}
.rp-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--text, #e8e8e8);
	margin: 0 0 16px;
	letter-spacing: -0.01em;
}
.rp-field {
	margin-bottom: 14px;
}
.rp-label {
	display: block;
	font-size: 11px;
	font-weight: 500;
	color: var(--muted, #888);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	margin-bottom: 6px;
}
.rp-select, .rp-textarea {
	width: 100%;
	box-sizing: border-box;
	background: var(--panel-elev, #111);
	border: 1px solid var(--border, #1a1a1a);
	border-radius: 6px;
	color: var(--text, #e8e8e8);
	font-size: 13px;
	padding: 8px 10px;
	outline: none;
	transition: border-color 0.15s;
	appearance: none;
}
.rp-select:focus, .rp-textarea:focus {
	border-color: var(--border-strong, #2a2a2a);
}
.rp-textarea {
	height: 80px;
	resize: vertical;
	font-family: 'SF Mono', 'Fira Mono', ui-monospace, monospace;
	font-size: 12px;
	line-height: 1.5;
}
.rp-submit {
	width: 100%;
	padding: 9px 16px;
	background: var(--accent, #fff);
	color: var(--accent-ink, #000);
	border: none;
	border-radius: 6px;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
	transition: opacity 0.15s;
}
.rp-submit:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}
.rp-status {
	margin-top: 12px;
	padding: 10px 12px;
	background: var(--panel-elev, #111);
	border: 1px solid var(--border, #1a1a1a);
	border-radius: 6px;
	font-size: 12px;
	color: var(--muted, #888);
	display: flex;
	align-items: center;
	gap: 8px;
}
.rp-status-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex-shrink: 0;
	background: #555;
}
.rp-status-dot.queued  { background: #6b7280; }
.rp-status-dot.running { background: #facc15; animation: rp-pulse 1.2s ease-in-out infinite; }
.rp-status-dot.done    { background: #4ade80; }
.rp-status-dot.failed  { background: var(--danger, #f87171); }
@keyframes rp-pulse {
	0%, 100% { opacity: 1; }
	50%       { opacity: 0.4; }
}
.rp-error {
	margin-top: 10px;
	padding: 9px 12px;
	background: var(--danger-dim, #4a1a1a);
	border: 1px solid rgba(248,113,113,.2);
	border-radius: 6px;
	font-size: 12px;
	color: var(--danger, #f87171);
}
.rp-notice {
	padding: 14px;
	background: var(--panel-elev, #111);
	border: 1px solid var(--border, #1a1a1a);
	border-radius: 8px;
	font-size: 13px;
	color: var(--muted, #888);
	line-height: 1.5;
}
.rp-notice strong {
	display: block;
	color: var(--text, #e8e8e8);
	margin-bottom: 6px;
	font-size: 13px;
}
.rp-notice a {
	color: var(--text, #e8e8e8);
	text-decoration: underline;
	text-underline-offset: 2px;
}
`;

let _cssInjected = false;
function ensureCSS() {
	if (_cssInjected) return;
	const el = document.createElement('style');
	el.textContent = CSS;
	document.head.appendChild(el);
	_cssInjected = true;
}

export function mountRegeneratePanel(container, { avatarId, onResult }) {
	ensureCSS();
	const panel = new RegeneratePanel(container, { avatarId, onResult });
	panel.render();
	return panel;
}

class RegeneratePanel {
	constructor(container, { avatarId, onResult }) {
		this.container = container;
		this.avatarId = avatarId;
		this.onResult = onResult;
		this.state = {
			mode: 'remesh',
			params: '{}',
			inFlight: false,
			unconfigured: false,
			jobId: null,
			status: null,
			error: null,
		};
		this.pollTimer = null;
	}

	render() {
		this.container.innerHTML = '';

		const root = document.createElement('div');
		root.className = 'rp-root';

		const title = document.createElement('p');
		title.className = 'rp-title';
		title.textContent = 'Regenerate avatar';
		root.appendChild(title);

		if (this.state.unconfigured) {
			root.appendChild(this._buildNoticeBanner());
			this.container.appendChild(root);
			return;
		}

		root.appendChild(this._buildModeField());
		root.appendChild(this._buildParamsField());
		root.appendChild(this._buildSubmitBtn());

		if (this.state.error) root.appendChild(this._buildError());
		if (this.state.jobId) root.appendChild(this._buildStatusRow());

		this.container.appendChild(root);
	}

	_buildModeField() {
		const field = document.createElement('div');
		field.className = 'rp-field';

		const label = document.createElement('label');
		label.className = 'rp-label';
		label.textContent = 'Mode';
		field.appendChild(label);

		const sel = document.createElement('select');
		sel.className = 'rp-select';
		MODES.forEach(({ value, label: lbl, desc }) => {
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = `${lbl} — ${desc}`;
			if (value === this.state.mode) opt.selected = true;
			sel.appendChild(opt);
		});
		sel.addEventListener('change', (e) => { this.state.mode = e.target.value; });
		field.appendChild(sel);
		return field;
	}

	_buildParamsField() {
		const field = document.createElement('div');
		field.className = 'rp-field';

		const label = document.createElement('label');
		label.className = 'rp-label';
		label.textContent = 'Parameters (JSON)';
		field.appendChild(label);

		const ta = document.createElement('textarea');
		ta.className = 'rp-textarea';
		ta.value = this.state.params;
		ta.spellcheck = false;
		ta.autocomplete = 'off';
		ta.addEventListener('change', (e) => { this.state.params = e.target.value; });
		field.appendChild(ta);
		return field;
	}

	_buildSubmitBtn() {
		const btn = document.createElement('button');
		btn.className = 'rp-submit';
		btn.type = 'button';
		btn.disabled = this.state.inFlight;
		btn.textContent = this.state.inFlight ? 'Working…' : 'Start regeneration';
		btn.addEventListener('click', () => this._submit());
		return btn;
	}

	_buildError() {
		const el = document.createElement('div');
		el.className = 'rp-error';
		el.textContent = this.state.error;
		return el;
	}

	_buildStatusRow() {
		const row = document.createElement('div');
		row.className = 'rp-status';

		const dot = document.createElement('span');
		dot.className = `rp-status-dot ${this.state.status || 'queued'}`;
		row.appendChild(dot);

		const text = document.createElement('span');
		text.textContent = STATUS_LABELS[this.state.status] || 'Queued…';
		row.appendChild(text);

		return row;
	}

	_buildNoticeBanner() {
		const el = document.createElement('div');
		el.className = 'rp-notice';
		el.innerHTML = `
			<strong>Mesh regeneration needs a backend</strong>
			Re-mesh, re-texture, and re-rig require a platform ML backend (Replicate, GCP, or HuggingFace).
			Set <code>AVATAR_REGEN_PROVIDER</code> and the matching API token in your environment to enable it.
			<br><br>
			<a href="/docs/avatar-creation" target="_blank" rel="noopener">Read the setup guide →</a>
		`;
		return el;
	}

	async _submit() {
		if (this.state.inFlight) return;

		let params;
		try {
			params = JSON.parse(this.state.params);
		} catch (e) {
			this.state.error = `Invalid JSON: ${e.message}`;
			this.render();
			return;
		}

		this.state.inFlight = true;
		this.state.error = null;
		this.render();

		try {
			const resp = await fetch('/api/avatars/regenerate', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					sourceAvatarId: this.avatarId,
					mode: this.state.mode,
					params,
				}),
			});

			const body = await resp.json().catch(() => ({}));

			if (!resp.ok) {
				if (resp.status === 501 && body.error === 'regen_unconfigured') {
					this.state.unconfigured = true;
					this.state.inFlight = false;
					this.render();
					return;
				}
				throw new Error(body.error_description || body.message || `HTTP ${resp.status}`);
			}

			this.state.jobId = body.jobId;
			this.state.status = body.status;
			this.state.inFlight = false;
			this.render();
			this._startPolling();
		} catch (err) {
			this.state.error = err.message;
			this.state.inFlight = false;
			this.render();
		}
	}

	_startPolling() {
		this.pollTimer = setInterval(async () => {
			try {
				const resp = await fetch(
					`/api/avatars/regenerate-status?jobId=${encodeURIComponent(this.state.jobId)}`,
					{ credentials: 'include' },
				);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const body = await resp.json();
				this.state.status = body.status;
				if (body.error) this.state.error = body.error;
				this.render();

				if (body.status === 'done' || body.status === 'failed') {
					clearInterval(this.pollTimer);
					this.pollTimer = null;
					if (body.status === 'done' && body.resultAvatarId && this.onResult) {
						this.onResult(body.resultAvatarId);
					}
				}
			} catch (err) {
				this.state.error = err.message;
				this.render();
				clearInterval(this.pollTimer);
				this.pollTimer = null;
			}
		}, 3000);
	}

	unmount() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.container.innerHTML = '';
	}
}
