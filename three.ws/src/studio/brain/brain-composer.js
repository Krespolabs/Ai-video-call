/**
 * Brain Studio — card composer (P1)
 * =================================
 * The agent's mind, edited as a clean, ordered stack of configuration cards
 * instead of a free-form node canvas. Each card is one part of the pipeline —
 * Persona → Memory → Skills → Market signals → Model → Avatar output — and its
 * fields edit the SAME node `data` the rest of the brain stack already consumes.
 *
 * Why a composer, not a graph: the wiring of a single agent brain is a fixed
 * linear pipeline (everything feeds the model, the model drives the avatar). A
 * drag-the-wires editor made the user do the platform's job. The composer keeps
 * the graph data model — `toGraph()` synthesizes a fully-wired, normalized graph
 * every serialize — so `compileBrain`, `brain-runtime`, the templates, and the
 * persisted `meta.studio.brain` format are all unchanged. A card that exists is
 * wired in; remove the card to remove it from the circuit.
 *
 * This class is a drop-in for the old BrainGraphView: it exposes the same public
 * surface the controller and the runtime depend on, including the live
 * "watch it think" animation — which now lights up cards in pipeline order.
 *
 * Public API:
 *   new BrainComposer(host, { onChange, getProviders, getSkills })
 *   .load(graph) / .toGraph()
 *   .addNode(type) / .removeNode(id) / .updateNodeData(id, patch)
 *   Animation (driven by brain-runtime.js):
 *   .circuit() / .setActive(nodeIds) / .pulseNode(id)
 *   .setNodeBusy(id, busy) / .setNodeStat(id, text) / .clearActive()
 */

import { NODE_TYPES, makeNode, edge } from './brain-nodes.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class BrainComposer {
	constructor(host, { onChange, getProviders, getSkills } = {}) {
		this.host = host;
		this.onChange = onChange || (() => {});
		this.getProviders = getProviders || (() => []);
		this.getSkills = getSkills || (() => []);
		this.nodes = [];
		this._cardEls = new Map(); // nodeId → card element (for animation + stats)
		this.host.classList.add('brainstudio__composer');
	}

	// ── Load / serialize ──────────────────────────────────────────────────────

	load(graph) {
		const nodes = (graph?.nodes || []).map((n) => ({ ...n, data: { ...n.data } }));
		// Guarantee a complete pipeline: a malformed or partial stored graph can't
		// leave the composer without a Persona / Model / Output card to render.
		for (const type of ['persona', 'model', 'output']) {
			if (!nodes.some((n) => n.type === type)) nodes.push(makeNode(type, 0, 0));
		}
		this.nodes = nodes;
		this._renderAll();
	}

	// Synthesize the canonical fully-wired graph the rest of the platform consumes.
	// Every present card is part of the live circuit, by design.
	toGraph() {
		const persona = this.nodes.find((n) => n.type === 'persona');
		const memory = this.nodes.find((n) => n.type === 'memory');
		const model = this.nodes.find((n) => n.type === 'model');
		const output = this.nodes.find((n) => n.type === 'output');
		const skills = this.nodes.filter((n) => n.type === 'skill');
		const markets = this.nodes.filter((n) => n.type === 'market');

		const edges = [];
		if (persona && model) edges.push(edge(persona, 'identity', model, 'identity'));
		if (memory && model) edges.push(edge(memory, 'recall', model, 'context'));
		for (const s of skills) if (model) edges.push(edge(s, 'tool', model, 'tools'));
		for (const m of markets) if (model) edges.push(edge(m, 'signal', model, 'context'));
		if (model && output) edges.push(edge(model, 'reply', output, 'reply'));

		return {
			version: 1,
			nodes: this.nodes.map((n) => ({ id: n.id, type: n.type, x: Math.round(n.x || 0), y: Math.round(n.y || 0), data: { ...n.data } })),
			edges,
		};
	}

	_emitChange() { this.onChange(this.toGraph()); }

	// ── Mutations ─────────────────────────────────────────────────────────────

	addNode(type) {
		const spec = NODE_TYPES[type];
		if (!spec) return null;
		if (spec.single && this.nodes.some((n) => n.type === type)) return null;
		const node = makeNode(type, 0, 0);
		this.nodes.push(node);
		this._renderAll();
		this._emitChange();
		// Focus the first field of the freshly added card so the user can type at once.
		this._cardEls.get(node.id)?.querySelector('[data-field]')?.focus();
		return node;
	}

	removeNode(id) {
		const node = this.nodes.find((n) => n.id === id);
		if (!node || NODE_TYPES[node.type]?.single) return; // structural cards stay
		this.nodes = this.nodes.filter((n) => n.id !== id);
		this._renderAll();
		this._emitChange();
	}

	updateNodeData(id, patch) {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		Object.assign(node.data, patch);
		this._emitChange();
	}

	// ── Render ────────────────────────────────────────────────────────────────

	_renderAll() {
		this._cardEls.clear();
		const frag = document.createDocumentFragment();

		frag.appendChild(this._card(this.nodes.find((n) => n.type === 'persona')));
		frag.appendChild(this._memorySection());
		frag.appendChild(this._repeatSection('skill', 'Skills', 'Give the agent tools it can call. Add a skill the agent already has enabled.'));
		frag.appendChild(this._repeatSection('market', 'Market signals', 'Reasoning rules for the live mint supplied at runtime. $THREE is the only coin the platform promotes.'));
		frag.appendChild(this._card(this.nodes.find((n) => n.type === 'model')));
		frag.appendChild(this._card(this.nodes.find((n) => n.type === 'output')));

		this.host.replaceChildren(frag);
	}

	// A single editable node card. `removable` adds a delete control (skill/market).
	_card(node, { removable = false } = {}) {
		const spec = NODE_TYPES[node.type];
		const el = document.createElement('section');
		el.className = `bcard bcard--${spec.accent}`;
		el.dataset.id = node.id;
		el.innerHTML = `
			<header class="bcard__head">
				<span class="bcard__dot bcard__dot--${spec.accent}"></span>
				<h3 class="bcard__title">${esc(spec.title)}</h3>
				<span class="bcard__stat" hidden></span>
				${removable ? '<button class="bcard__remove" type="button" aria-label="Remove">Remove</button>' : ''}
			</header>
			<div class="bcard__fields"></div>`;
		const fields = el.querySelector('.bcard__fields');
		for (const f of spec.fields) fields.appendChild(this._field(node, f));
		if (removable) el.querySelector('.bcard__remove').addEventListener('click', () => this.removeNode(node.id));
		this._cardEls.set(node.id, el);
		return el;
	}

	// Memory is optional: render its card when present, otherwise an add affordance.
	_memorySection() {
		const node = this.nodes.find((n) => n.type === 'memory');
		if (node) {
			const card = this._card(node);
			const head = card.querySelector('.bcard__head');
			const off = document.createElement('button');
			off.className = 'bcard__remove';
			off.type = 'button';
			off.textContent = 'Turn off';
			off.addEventListener('click', () => {
				this.nodes = this.nodes.filter((n) => n.type !== 'memory');
				this._renderAll();
				this._emitChange();
			});
			head.appendChild(off);
			return card;
		}
		const el = document.createElement('section');
		el.className = 'bcard bcard--memory bcard--add';
		el.innerHTML = `
			<header class="bcard__head">
				<span class="bcard__dot bcard__dot--memory"></span>
				<h3 class="bcard__title">Memory</h3>
			</header>
			<p class="bcard__hint">Off. The agent answers without recalling past conversations.</p>
			<button class="studio__btn bcard__addbtn" type="button">Turn on memory</button>`;
		el.querySelector('.bcard__addbtn').addEventListener('click', () => this.addNode('memory'));
		return el;
	}

	// A repeatable group (skills, market signals): a labelled section, one card per
	// node, plus an "add" button.
	_repeatSection(type, title, hint) {
		const spec = NODE_TYPES[type];
		const wrap = document.createElement('section');
		wrap.className = `bgroup bgroup--${spec.accent}`;
		const head = document.createElement('div');
		head.className = 'bgroup__head';
		head.innerHTML = `<span class="bcard__dot bcard__dot--${spec.accent}"></span><h3 class="bgroup__title">${esc(title)}</h3>`;
		const add = document.createElement('button');
		add.className = 'studio__btn bgroup__add';
		add.type = 'button';
		add.textContent = `+ ${spec.title}`;
		add.addEventListener('click', () => this.addNode(type));
		head.appendChild(add);
		wrap.appendChild(head);

		const items = this.nodes.filter((n) => n.type === type);
		if (!items.length) {
			const empty = document.createElement('p');
			empty.className = 'bgroup__empty';
			empty.textContent = hint;
			wrap.appendChild(empty);
		} else {
			for (const n of items) wrap.appendChild(this._card(n, { removable: true }));
		}
		return wrap;
	}

	// ── Fields ────────────────────────────────────────────────────────────────

	_field(node, field) {
		const wrap = document.createElement('div');
		wrap.className = 'bcard__field';
		const id = `f_${node.id}_${field.key}`;
		const value = node.data[field.key];
		wrap.innerHTML = `<label class="bcard__label" for="${id}">${esc(field.label)}</label>${this._control(id, field, value)}`;
		const input = wrap.querySelector('[data-field]');
		if (input) {
			const ev = input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input';
			input.addEventListener(ev, () => this.updateNodeData(node.id, { [field.key]: this._readField(field, input) }));
		}
		return wrap;
	}

	_control(id, field, value) {
		switch (field.type) {
			case 'textarea':
				return `<textarea class="bcard__input" id="${id}" data-field="${field.key}" rows="2">${esc(value || '')}</textarea>`;
			case 'number':
				return `<input class="bcard__input" id="${id}" data-field="${field.key}" type="number" min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.step ?? 1}" value="${esc(value ?? '')}" />`;
			case 'toggle':
				return `<label class="brainstudio__toggle"><input id="${id}" data-field="${field.key}" type="checkbox" ${value ? 'checked' : ''} /><span></span></label>`;
			case 'select':
				return `<select class="bcard__input" id="${id}" data-field="${field.key}">${field.options.map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
			case 'provider':
				return this._providerSelect(id, field.key, value);
			case 'skill':
				return this._skillSelect(id, field.key, value);
			case 'tags':
				return `<input class="bcard__input" id="${id}" data-field="${field.key}" type="text" value="${esc((value || []).join(', '))}" placeholder="comma, separated" />`;
			default:
				return `<input class="bcard__input" id="${id}" data-field="${field.key}" type="text" value="${esc(value ?? '')}" placeholder="${esc(field.placeholder || '')}" />`;
		}
	}

	_providerSelect(id, key, value) {
		const providers = this.getProviders();
		const list = providers.length ? providers : [{ key: value || 'claude-sonnet-4-6', label: value || 'Claude Sonnet 4.6', available: true, tier: '' }];
		const opts = list.map((p) => `<option value="${esc(p.key)}" ${p.key === value ? 'selected' : ''} ${p.available ? '' : 'disabled'}>${esc(p.label)}${p.available ? '' : ' (no key)'}${p.tier ? ` · ${esc(p.tier)}` : ''}</option>`).join('');
		return `<select class="bcard__input" id="${id}" data-field="${key}">${opts}</select>`;
	}

	_skillSelect(id, key, value) {
		const skills = this.getSkills();
		if (!skills.length) return `<input class="bcard__input" id="${id}" data-field="${key}" type="text" value="${esc(value || '')}" placeholder="no skills enabled yet — turn some on in the Skills tab" />`;
		const opts = ['<option value="">— pick a skill —</option>', ...skills.map((s) => `<option value="${esc(s)}" ${s === value ? 'selected' : ''}>${esc(s)}</option>`)].join('');
		return `<select class="bcard__input" id="${id}" data-field="${key}">${opts}</select>`;
	}

	// Model availability is fetched async (GET /api/brain/chat) and can land after the
	// composer first renders. Refresh the Model card's picker in place — targeted, so a
	// user mid-edit on another card keeps focus and unsaved text.
	setProviders() {
		const model = this.nodes.find((n) => n.type === 'model');
		const sel = model && this._cardEls.get(model.id)?.querySelector('[data-field="provider"]');
		if (!sel) return;
		const fresh = document.createRange().createContextualFragment(this._providerSelect(sel.id, 'provider', model.data.provider)).firstElementChild;
		fresh.addEventListener('change', () => this.updateNodeData(model.id, { provider: fresh.value }));
		sel.replaceWith(fresh);
	}

	_readField(field, inp) {
		switch (field.type) {
			case 'number': return Number(inp.value);
			case 'toggle': return inp.checked;
			case 'tags': return inp.value.split(',').map((s) => s.trim()).filter(Boolean);
			default: return inp.value;
		}
	}

	// ── Live "watch it think" animation ─────────────────────────────────────────
	// The runtime walks the compiled circuit and pulses each stage as it runs. With
	// the composer, every present card is in the circuit, so we light up cards in
	// pipeline order — the same moment, rendered as a flowing stack.

	circuit() {
		return { nodeIds: this.nodes.map((n) => n.id), edgeIds: [] };
	}

	setActive(nodeIds = []) {
		const set = new Set(nodeIds);
		for (const [id, el] of this._cardEls) el.classList.toggle('is-active', set.has(id));
	}

	pulseNode(id) {
		const el = this._cardEls.get(id);
		if (!el) return;
		el.classList.remove('is-pulse');
		void el.offsetWidth; // restart the animation
		el.classList.add('is-pulse');
		el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
	}

	setNodeBusy(id, busy) {
		this._cardEls.get(id)?.classList.toggle('is-busy', !!busy);
	}

	setNodeStat(id, text) {
		const stat = this._cardEls.get(id)?.querySelector('.bcard__stat');
		if (!stat) return;
		stat.textContent = text || '';
		stat.hidden = !text;
	}

	clearActive() {
		for (const el of this._cardEls.values()) {
			el.classList.remove('is-active', 'is-pulse', 'is-busy');
			const stat = el.querySelector('.bcard__stat');
			if (stat) { stat.textContent = ''; stat.hidden = true; }
		}
	}
}
