const NAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

const DENYLIST = new Set([
	'admin',
	'root',
	'system',
	'anthropic',
	'claude',
	'openai',
	'null',
	'undefined',
	'test',
]);

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

export class AgentNaming {
	constructor({ container, initialName = '', agentId = null, onSubmit }) {
		this._container = container;
		this._initialName = initialName;
		this._agentId = agentId;
		this._onSubmit = onSubmit;
		this._debounceTimer = null;
		this._abort = null;
		this._checkState = 'idle'; // idle | loading | valid | invalid
		this._lastCheckedName = null;
		// Granite identity-integrity (advisory): idle | loading | clear | review | block
		this._integrityState = 'idle';
		this._integrityTimer = null;
		this._integrityAbort = null;
		this._root = null;
	}

	mount() {
		this._root = document.createElement('div');
		this._root.className = 'agent-naming';
		this._root.innerHTML = `
<style>
.agent-naming { display: flex; flex-direction: column; gap: 16px; max-width: 480px; font-family: inherit; }
.an-field { display: flex; flex-direction: column; gap: 4px; }
.an-field label { font-size: 14px; font-weight: 600; }
.an-required { color: #e53; }
.an-input-wrap { display: flex; align-items: center; gap: 8px; }
.an-input-wrap input { flex: 1; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
.an-status { font-size: 13px; min-width: 20px; white-space: nowrap; }
.an-status[data-state="valid"] { color: #2a9d2a; }
.an-status[data-state="invalid"] { color: #c0392b; }
.an-status[data-state="loading"] { color: #888; }
.an-hint { font-size: 12px; color: #888; }
.an-field textarea { padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; resize: vertical; }
.an-counter { font-size: 12px; color: #888; text-align: right; }
.an-integrity { font-size: 13px; border-radius: 8px; padding: 10px 12px; display: none; line-height: 1.45; transition: opacity .15s ease; }
.an-integrity[data-state="loading"] { display: block; color: #71717a; background: #f4f4f5; }
.an-integrity[data-state="clear"] { display: block; color: #1a7f37; background: #eaf7ee; }
.an-integrity[data-state="review"] { display: block; color: #9a6700; background: #fff8e6; }
.an-integrity[data-state="block"] { display: block; color: #b42318; background: #fdecea; }
.an-int-title { font-weight: 600; }
.an-int-detail { margin-top: 4px; opacity: .92; }
.an-int-brand { font-size: 11px; opacity: .65; margin-top: 6px; }
.an-submit { padding: 10px 20px; background: #4f46e5; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.an-submit:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
<div class="an-field">
	<label for="an-name">Name <span class="an-required">*</span></label>
	<div class="an-input-wrap">
		<input id="an-name" type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="my-agent" />
		<span class="an-status" aria-live="polite" data-state=""></span>
	</div>
	<div class="an-hint">3–32 chars · letters, numbers, _ and - only</div>
</div>
<div class="an-field">
	<label for="an-desc">Description</label>
	<textarea id="an-desc" maxlength="280" rows="3" placeholder="What does your agent do?"></textarea>
	<div class="an-counter">0 / 280</div>
</div>
<div class="an-integrity" aria-live="polite" data-state=""></div>
<button class="an-submit" type="button" disabled>Create agent</button>
`;

		this._nameInput = this._root.querySelector('#an-name');
		this._descInput = this._root.querySelector('#an-desc');
		this._statusEl = this._root.querySelector('.an-status');
		this._submitBtn = this._root.querySelector('.an-submit');
		this._counterEl = this._root.querySelector('.an-counter');
		this._integrityEl = this._root.querySelector('.an-integrity');

		this._onNameInput = () => this._handleNameInput();
		this._onDescInput = () => this._handleDescInput();
		this._onSubmitClick = () => this._handleSubmit();

		this._nameInput.addEventListener('input', this._onNameInput);
		this._descInput.addEventListener('input', this._onDescInput);
		this._submitBtn.addEventListener('click', this._onSubmitClick);

		this._container.appendChild(this._root);

		if (this._initialName) {
			this._nameInput.value = this._initialName;
			this._handleNameInput();
		}
	}

	unmount() {
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		if (this._integrityTimer) clearTimeout(this._integrityTimer);
		if (this._abort) this._abort.abort();
		if (this._integrityAbort) this._integrityAbort.abort();
		this._nameInput?.removeEventListener('input', this._onNameInput);
		this._descInput?.removeEventListener('input', this._onDescInput);
		this._submitBtn?.removeEventListener('click', this._onSubmitClick);
		this._root?.remove();
		this._root = null;
	}

	_handleNameInput() {
		const name = this._nameInput.value;

		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		if (this._abort) this._abort.abort();

		const localError = this._validateLocal(name);
		if (localError) {
			this._setStatus('invalid', localError);
			this._setIntegrity('idle');
			return;
		}

		this._setStatus('loading', '');
		this._debounceTimer = setTimeout(() => this._runCheck(name), 400);
		this._scheduleIntegrity();
	}

	_handleDescInput() {
		const len = this._descInput.value.length;
		this._counterEl.textContent = `${len} / 280`;
		this._scheduleIntegrity();
	}

	_validateLocal(name) {
		if (!name) return 'Name is required.';
		if (name.length < 3) return 'At least 3 characters required.';
		if (name.length > 32) return '32 characters maximum.';
		if (!NAME_RE.test(name)) return 'Letters, numbers, _ and - only.';
		if (DENYLIST.has(name.toLowerCase())) return 'That name is reserved.';
		return null;
	}

	async _runCheck(name) {
		this._abort = new AbortController();
		try {
			const res = await fetch(`/api/agents/check-name?name=${encodeURIComponent(name)}`, {
				signal: this._abort.signal,
				credentials: 'include',
			});
			const data = await res.json();
			this._lastCheckedName = name;
			if (data.available) {
				this._setStatus('valid', '');
			} else {
				this._setStatus('invalid', this._reasonText(data.reason));
			}
		} catch (err) {
			if (err.name === 'AbortError') return;
			this._lastCheckedName = null;
			this._setStatus('invalid', 'Could not check availability.');
		}
	}

	_reasonText(reason) {
		if (reason === 'taken') return 'Name is already taken.';
		if (reason === 'denylisted') return 'That name is reserved.';
		return 'Name is not available.';
	}

	_setStatus(state, message) {
		this._checkState = state;
		this._statusEl.dataset.state = state;
		if (state === 'loading') {
			this._statusEl.textContent = '…';
		} else if (state === 'valid') {
			this._statusEl.textContent = '✓';
		} else if (state === 'invalid') {
			this._statusEl.textContent = message ? `✗  ${message}` : '✗';
		} else {
			this._statusEl.textContent = '';
		}
		this._updateSubmit();
	}

	// Submit is enabled only when the name passed its availability check AND the
	// Granite identity check has not hard-blocked the identity. 'review' is
	// advisory — it warns but does not prevent submission.
	_updateSubmit() {
		if (!this._submitBtn) return;
		this._submitBtn.disabled = this._checkState !== 'valid' || this._integrityState === 'block';
	}

	// ── Granite identity-integrity (advisory) ──────────────────────────────────

	_scheduleIntegrity() {
		// Only meaningful once the name passes local validation.
		if (this._validateLocal(this._nameInput.value)) {
			this._setIntegrity('idle');
			return;
		}
		if (this._integrityTimer) clearTimeout(this._integrityTimer);
		if (this._integrityAbort) this._integrityAbort.abort();
		this._setIntegrity('loading');
		this._integrityTimer = setTimeout(() => this._runIntegrity(), 600);
	}

	async _runIntegrity() {
		const name = this._nameInput.value.trim();
		const description = this._descInput.value.trim();
		this._integrityAbort = new AbortController();
		try {
			const body = { name, description };
			if (this._agentId) body.agent_id = this._agentId;
			const res = await fetch('/api/agents/identity-check', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				signal: this._integrityAbort.signal,
				body: JSON.stringify(body),
			});
			// 401 (not signed in), 429, 5xx → advisory only; never obstruct creation.
			if (!res.ok) {
				this._setIntegrity('idle');
				return;
			}
			this._renderIntegrity(await res.json());
		} catch (err) {
			if (err.name === 'AbortError') return;
			this._setIntegrity('idle');
		}
	}

	_renderIntegrity(data) {
		// watsonx unconfigured (or no verdict) → stay silent, don't obstruct.
		if (!data || !data.configured || data.status === 'unavailable') {
			this._setIntegrity('idle');
			return;
		}
		this._integrityState = data.status;
		const el = this._integrityEl;
		el.dataset.state = data.status;

		const pct = data.uniqueness != null ? Math.round(data.uniqueness * 100) : null;
		const reason = (data.reasons && data.reasons[0]) || '';
		let title;
		if (data.status === 'block') title = '✗ Identity conflict';
		else if (data.status === 'review') title = '⚠ Similar identity exists';
		else title = `✓ Distinct identity${pct != null ? ` · ${pct}% unique` : ''}`;

		const detail = data.status === 'clear' ? '' : `<div class="an-int-detail">${escapeHtml(reason)}</div>`;
		el.innerHTML =
			`<div class="an-int-title">${escapeHtml(title)}</div>${detail}` +
			`<div class="an-int-brand">Verified with IBM Granite embeddings + Granite Guardian</div>`;
		this._updateSubmit();
	}

	_setIntegrity(state) {
		const el = this._integrityEl;
		if (!el) return;
		if (state === 'loading') {
			this._integrityState = 'loading';
			el.dataset.state = 'loading';
			el.innerHTML = '<div class="an-int-title">Checking identity with IBM Granite…</div>';
		} else {
			this._integrityState = 'idle';
			el.dataset.state = '';
			el.innerHTML = '';
		}
		this._updateSubmit();
	}

	async _handleSubmit() {
		const name = this._nameInput.value;

		const localError = this._validateLocal(name);
		if (localError) {
			this._setStatus('invalid', localError);
			return;
		}

		// Re-run server check if input changed since last confirmed check.
		if (this._lastCheckedName !== name) {
			if (this._debounceTimer) clearTimeout(this._debounceTimer);
			await this._runCheck(name);
			if (this._checkState !== 'valid') return;
		}

		// A hard identity conflict is surfaced in the panel and the server would
		// 409 anyway — don't attempt the create.
		if (this._integrityState === 'block') return;

		this._submitBtn.disabled = true;
		try {
			await this._onSubmit({ name, description: this._descInput.value.trim() });
		} finally {
			// Re-enable only if still mounted.
			if (this._root) this._updateSubmit();
		}
	}
}
