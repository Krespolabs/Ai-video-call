// /syndicates: the board of copier teams, and the founding flow.
//
// Reads GET /api/syndicates (the ranked board; while it is empty it also carries
// the leaders a first syndicate could form around) and founds through POST
// /api/syndicates. Founding never subscribes anyone: it lands on the new
// syndicate's page, where the founder joins with their own wallet and caps like
// any other member. Every state is designed: loading, error, empty, populated.

import { apiFetch } from './api.js';
import { esc, fmtSol, fmtPct, tone, avatar, hydrateAvatars, flag, recordLine, toast, currentUser, errorMessage, relTime } from './syndicate-shared.js';

const boardEl = document.getElementById('syBoard');
const countEl = document.getElementById('syCount');
const moreBtn = document.getElementById('syMore');
const sortSeg = document.getElementById('sySort');
const candWrap = document.getElementById('syCandidatesWrap');
const candEl = document.getElementById('syCandidates');
const dialog = document.getElementById('syCreate');
const dialogBody = document.getElementById('syCreateBody');

const PAGE = 24;
const params = new URLSearchParams(location.search);
const state = {
	sort: ['profit', 'members', 'new'].includes(params.get('sort')) ? params.get('sort') : 'profit',
	offset: 0,
	rows: [],
	total: 0,
	colors: ['#7c5cff', '#22d3ee', '#34d399', '#f59e0b', '#fb7185', '#f472b6', '#60a5fa', '#a3e635'],
	maxLeaders: 3,
	candidates: null,
};
let loadSeq = 0;

// ── board ────────────────────────────────────────────────────────────────────

function skeleton() {
	boardEl.setAttribute('aria-busy', 'true');
	boardEl.innerHTML = `<div style="display:grid;gap:10px">${'<div class="sy-skel" style="height:86px"></div>'.repeat(4)}</div>`;
}

function renderError(message) {
	boardEl.setAttribute('aria-busy', 'false');
	boardEl.innerHTML = `
		<div class="sy-state" role="alert">
			<h3>The board did not load</h3>
			<p>${esc(message || 'The syndicates service is unreachable right now.')} Your memberships and copy subscriptions are unaffected.</p>
			<button type="button" class="sy-btn primary" id="syRetry">Try again</button>
		</div>`;
	document.getElementById('syRetry').addEventListener('click', () => load(true));
}

function rowHtml(s) {
	const p = s.performance;
	const since = s.since_founding;
	const leaders = s.leaders.map((l) => avatar(l.name, l.image)).join('');
	const leaderNames = s.leaders.map((l) => esc(l.name)).join(', ');
	return `
		<li>
			<a class="sy-row" href="${esc(s.url)}" style="--flag:${esc(s.color)}" aria-label="${esc(s.name)}, rank ${esc(s.rank)}, ${esc(s.members)} members, group P&amp;L ${esc(fmtSol(p.realized_profit_sol))}">
				<span class="sy-rank">#${esc(s.rank)}</span>
				${flag(s.name, s.color)}
				<span class="sy-row-main">
					<span class="sy-row-name">${esc(s.name)} ${s.official ? '<span class="sy-badge official" title="Founded by the owner of a leader it follows">Official</span>' : ''}</span>
					${s.motto ? `<span class="sy-row-motto">${esc(s.motto)}</span>` : ''}
					<span class="sy-row-meta"><span class="sy-ava-stack">${leaders}</span> <span>follows ${leaderNames}</span> <span>· formed ${esc(relTime(s.created_at))}</span></span>
				</span>
				<span class="sy-row-stats">
					<span class="sy-stat"><b>${esc(s.members)}</b><span>members</span></span>
					<span class="sy-stat"><b class="${tone(p.realized_profit_sol)}">${esc(fmtSol(p.realized_profit_sol))}</b><span>group P&amp;L</span></span>
					<span class="sy-stat"><b class="${tone(since.leader_roi_pct)}">${since.leader_closes ? esc(fmtPct(since.leader_roi_pct)) : 'n/a'}</b><span>leaders since formed</span></span>
				</span>
			</a>
		</li>`;
}

function renderBoard() {
	boardEl.setAttribute('aria-busy', 'false');
	if (!state.rows.length) return renderEmpty();
	countEl.textContent = `${state.total} ${state.total === 1 ? 'syndicate' : 'syndicates'}`;
	boardEl.innerHTML = `<ol class="sy-board" aria-label="Syndicates ranked">${state.rows.map(rowHtml).join('')}</ol>`;
	hydrateAvatars(boardEl);
	moreBtn.hidden = state.rows.length >= state.total;
	if (state.candidates) renderCandidates(state.candidates, { compact: true });
}

function renderEmpty() {
	countEl.textContent = '';
	moreBtn.hidden = true;
	const copyable = (state.candidates?.leaders || []).filter((l) => l.copyable);
	boardEl.innerHTML = `
		<div class="sy-hero-empty">
			<p class="sy-kicker">No syndicates yet · be the first flag on the board</p>
			<h2 style="margin:0 0 8px;font-size:clamp(20px,3.6vw,28px);letter-spacing:-.02em">Copying alone is lonely. Start the first team.</h2>
			<p class="sy-muted" style="margin:0;max-width:62ch;line-height:1.55">
				A syndicate turns following a trader into a side you are on. It takes a minute and moves no money:
			</p>
			<ol class="sy-steps">
				<li><b>Raise a flag</b>Name your syndicate, pick its color, and choose one to three verified trader agents to follow.</li>
				<li><b>Ride under your own caps</b>Every member copies from their own wallet with their own per-trade cap, daily budget, and drawdown limit.</li>
				<li><b>Climb the board</b>Your group curve comes from members' real copies. Beat the syndicate one rank above you.</li>
			</ol>
			<div class="sy-actions">
				<button type="button" class="sy-btn primary" data-start>${copyable.length ? `Start the first syndicate` : 'See what a leader needs'}</button>
				<a class="sy-btn" href="/ghost-copy">Ghost-copy a leader first</a>
			</div>
			${copyable.length ? `<p class="sy-fine" style="margin-top:12px">${copyable.length} ${copyable.length === 1 ? 'leader clears' : 'leaders clear'} the copyable bar right now. Their full records are below, losses included.</p>` : ''}
		</div>`;
	boardEl.querySelector('[data-start]').addEventListener('click', () => (copyable.length ? openCreate() : candWrap.scrollIntoView({ behavior: 'smooth' })));
	if (state.candidates) renderCandidates(state.candidates, { compact: false });
}

function candidateCard(l) {
	return `
		<div class="sy-leader">
			${avatar(l.name, l.image)}
			<div style="min-width:0">
				<div class="sy-leader-name">${esc(l.name)}</div>
				<div style="margin-top:4px">${l.copyable ? '<span class="sy-badge good">Copyable</span>' : '<span class="sy-badge warn">Not copyable yet</span>'}</div>
				<div class="sy-leader-line">${recordLine(l.record)}</div>
				${l.copyable ? '' : `<div class="sy-leader-line">Still short: ${esc(l.unmet.join(', '))}</div>`}
				<div class="sy-leader-links">
					<a href="${esc(l.trader_url)}">Full record</a>
					<a href="${esc(l.ghost_url)}">Ghost-copy</a>
					${l.copyable ? `<button type="button" class="sy-rally" data-found="${esc(l.agent_id)}">Rally around</button>` : ''}
				</div>
			</div>
		</div>`;
}

function renderCandidates(data, { compact }) {
	const leaders = data?.leaders || [];
	if (!leaders.length) {
		candWrap.hidden = false;
		candEl.innerHTML = `
			<div class="sy-state" style="grid-column:1/-1">
				<h3>No trader has a closed record yet</h3>
				<p>A syndicate forms around an agent with real closed on-chain trades. Deploy one in the Strategy Lab and it can be followed once it clears the bar.</p>
				<a class="sy-btn primary" href="/strategy-lab">Open the Strategy Lab</a>
			</div>`;
		return;
	}
	const shown = compact ? leaders.filter((l) => l.copyable).slice(0, 6) : leaders;
	if (!shown.length) { candWrap.hidden = true; return; }
	candWrap.hidden = false;
	candEl.innerHTML = shown.map(candidateCard).join('');
	hydrateAvatars(candEl);
}

candEl.addEventListener('click', (e) => {
	const a = e.target.closest('[data-found]');
	if (!a) return;
	e.preventDefault();
	openCreate([a.dataset.found]);
});

async function load(reset = true) {
	const seq = ++loadSeq;
	if (reset) { state.offset = 0; state.rows = []; skeleton(); }
	moreBtn.disabled = true;
	try {
		const q = new URLSearchParams({ sort: state.sort, limit: String(PAGE), offset: String(state.offset) });
		if (reset) q.set('include', 'candidates');
		const r = await fetch(`/api/syndicates?${q}`, { headers: { accept: 'application/json' } });
		if (!r.ok) {
			const { message } = await errorMessage(r, `The board answered ${r.status}.`);
			if (seq === loadSeq) renderError(message);
			return;
		}
		const body = await r.json();
		if (seq !== loadSeq) return;
		state.total = Number(body.total) || 0;
		state.rows = reset ? body.syndicates : state.rows.concat(body.syndicates);
		if (Array.isArray(body.colors) && body.colors.length) state.colors = body.colors;
		if (body.max_leaders) state.maxLeaders = body.max_leaders;
		if (body.candidates) state.candidates = body.candidates;
		renderBoard();
	} catch {
		if (seq === loadSeq) renderError('Check your connection.');
	} finally {
		moreBtn.disabled = false;
	}
}

sortSeg.addEventListener('click', (e) => {
	const btn = e.target.closest('button[data-sort]');
	if (!btn || btn.dataset.sort === state.sort) return;
	state.sort = btn.dataset.sort;
	for (const b of sortSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
	const u = new URL(location.href);
	if (state.sort === 'profit') u.searchParams.delete('sort'); else u.searchParams.set('sort', state.sort);
	history.replaceState(null, '', u);
	load(true);
});

moreBtn.addEventListener('click', () => {
	state.offset = state.rows.length;
	load(false);
});

// ── founding ─────────────────────────────────────────────────────────────────

const form = { name: '', motto: '', color: null, leaders: new Set() };

async function candidatesForForm() {
	if (state.candidates?.leaders) return state.candidates;
	const r = await fetch('/api/syndicates/leaders?limit=24', { headers: { accept: 'application/json' } });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	state.candidates = await r.json();
	return state.candidates;
}

async function openCreate(preselect = []) {
	for (const id of preselect) form.leaders.add(id);
	if (!form.color) form.color = state.colors[Math.floor(Math.random() * state.colors.length)];
	if (!dialog.open) dialog.showModal();
	dialogBody.innerHTML = `<div style="display:grid;gap:10px"><div class="sy-skel" style="height:44px"></div><div class="sy-skel" style="height:120px"></div></div>`;

	const user = await currentUser();
	if (!user) {
		const next = encodeURIComponent(`/syndicates?start=1${preselect[0] ? `&leader=${preselect[0]}` : ''}`);
		dialogBody.innerHTML = `
			<div class="sy-state" style="border:0;padding:12px 0">
				<h3>Sign in to raise a flag</h3>
				<p>Founding a syndicate is free and moves no money. You need an account so the syndicate has a founder, and so you can join it with your own wallet afterwards.</p>
				<div class="sy-actions" style="justify-content:center">
					<a class="sy-btn primary" href="/login?next=${next}">Sign in</a>
					<a class="sy-btn" href="/register?next=${next}">Create an account</a>
				</div>
			</div>`;
		return;
	}

	let cands;
	try {
		cands = await candidatesForForm();
	} catch {
		dialogBody.innerHTML = `
			<div class="sy-state" style="border:0;padding:12px 0">
				<h3>Could not load the leaders</h3>
				<p>The list of traders a syndicate can follow did not load. Nothing was created.</p>
				<button type="button" class="sy-btn primary" id="syCandRetry">Try again</button>
			</div>`;
		dialogBody.querySelector('#syCandRetry').addEventListener('click', () => openCreate());
		return;
	}
	renderCreateForm(cands.leaders || []);
}

function renderCreateForm(leaders) {
	const copyable = leaders.filter((l) => l.copyable);
	for (const id of [...form.leaders]) if (!copyable.some((l) => l.agent_id === id)) form.leaders.delete(id);

	dialogBody.innerHTML = `
		<form class="sy-form" id="syForm" novalidate>
			<div class="sy-row2">
				<label class="sy-field">
					<span class="sy-label">Name</span>
					<input class="sy-input" id="syName" maxlength="40" minlength="3" required autocomplete="off" placeholder="Night Shift Degens" value="${esc(form.name)}" />
					<span class="sy-hint">3 to 40 characters. It becomes your address: three.ws/syndicates/<span id="sySlug">${esc(slugPreview(form.name) || 'your-name')}</span></span>
				</label>
				<label class="sy-field">
					<span class="sy-label">Motto <span class="sy-faint" style="text-transform:none;letter-spacing:0">(optional)</span></span>
					<input class="sy-input" id="syMotto" maxlength="140" autocomplete="off" placeholder="We ride the 3am tape together." value="${esc(form.motto)}" />
				</label>
			</div>
			<div class="sy-field">
				<span class="sy-label" id="syColorLbl">Flag color</span>
				<div class="sy-swatches" role="radiogroup" aria-labelledby="syColorLbl" id="sySwatches">
					${state.colors.map((c) => `<button type="button" class="sy-swatch" role="radio" style="--c:${esc(c)}" data-color="${esc(c)}" aria-checked="${c === form.color}" aria-label="Color ${esc(c)}" tabindex="${c === form.color ? '0' : '-1'}"></button>`).join('')}
				</div>
			</div>
			<div class="sy-field">
				<span class="sy-label" id="syLeadLbl">Leaders to follow <span class="sy-faint" style="text-transform:none;letter-spacing:0">(1 to ${state.maxLeaders}, copyable only)</span></span>
				${copyable.length ? '' : '<div class="sy-note">No trader clears the copyable bar right now, so a syndicate cannot form yet. Every record below shows exactly what is still missing.</div>'}
				<div class="sy-leaders" role="group" aria-labelledby="syLeadLbl" id="syLeaderPick">
					${leaders.map((l) => `
						<button type="button" class="sy-leader" data-leader="${esc(l.agent_id)}" aria-pressed="${form.leaders.has(l.agent_id)}" ${l.copyable ? '' : 'disabled'}>
							<span class="sy-check" aria-hidden="true">✓</span>
							${avatar(l.name, l.image)}
							<span style="min-width:0;display:block">
								<span class="sy-leader-name" style="display:block">${esc(l.name)}</span>
								<span class="sy-leader-line" style="display:block">${recordLine(l.record)}</span>
								${l.copyable ? '' : `<span class="sy-leader-line" style="display:block">Still short: ${esc(l.unmet.join(', '))}</span>`}
							</span>
						</button>`).join('')}
				</div>
			</div>
			<div class="sy-note">Founding moves no money and subscribes nobody. On the next screen you can join with your own wallet and caps, or share the page with followers.</div>
			<div id="syFormErr" class="sy-err" role="alert" hidden></div>
			<div class="sy-actions">
				<button type="submit" class="sy-btn primary" id="sySubmit" ${copyable.length ? '' : 'disabled'}>Raise the flag</button>
				<button type="button" class="sy-btn" id="syCancel">Cancel</button>
			</div>
		</form>`;
	hydrateAvatars(dialogBody);

	const nameEl = dialogBody.querySelector('#syName');
	const slugEl = dialogBody.querySelector('#sySlug');
	nameEl.addEventListener('input', () => { form.name = nameEl.value; slugEl.textContent = slugPreview(form.name) || 'your-name'; });
	dialogBody.querySelector('#syMotto').addEventListener('input', (e) => { form.motto = e.target.value; });
	dialogBody.querySelector('#syCancel').addEventListener('click', () => dialog.close());

	const swatches = dialogBody.querySelector('#sySwatches');
	const pickColor = (btn) => {
		form.color = btn.dataset.color;
		for (const b of swatches.querySelectorAll('.sy-swatch')) {
			const on = b === btn;
			b.setAttribute('aria-checked', String(on));
			b.tabIndex = on ? 0 : -1;
		}
		btn.focus();
	};
	swatches.addEventListener('click', (e) => { const b = e.target.closest('.sy-swatch'); if (b) pickColor(b); });
	swatches.addEventListener('keydown', (e) => {
		const all = [...swatches.querySelectorAll('.sy-swatch')];
		const i = all.findIndex((b) => b.dataset.color === form.color);
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		pickColor(all[(i + step + all.length) % all.length]);
	});

	const pick = dialogBody.querySelector('#syLeaderPick');
	pick.addEventListener('click', (e) => {
		const b = e.target.closest('button[data-leader]');
		if (!b || b.disabled) return;
		const id = b.dataset.leader;
		if (form.leaders.has(id)) form.leaders.delete(id);
		else if (form.leaders.size >= state.maxLeaders) return toast(`A syndicate follows at most ${state.maxLeaders} leaders.`);
		else form.leaders.add(id);
		b.setAttribute('aria-pressed', String(form.leaders.has(id)));
	});

	dialogBody.querySelector('#syForm').addEventListener('submit', submitCreate);
	if (!form.name) nameEl.focus();
}

function slugPreview(name) {
	return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function submitCreate(e) {
	e.preventDefault();
	const errEl = dialogBody.querySelector('#syFormErr');
	const btn = dialogBody.querySelector('#sySubmit');
	errEl.hidden = true;
	const name = form.name.trim();
	if (name.length < 3) return showFormErr(errEl, 'Give your syndicate a name of at least 3 characters.');
	if (!form.leaders.size) return showFormErr(errEl, 'Pick at least one leader to follow.');

	btn.disabled = true;
	btn.textContent = 'Raising the flag…';
	try {
		const r = await apiFetch('/api/syndicates', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ name, motto: form.motto.trim() || null, color: form.color, leader_agent_ids: [...form.leaders] }),
		});
		if (!r.ok) {
			const { body, message } = await errorMessage(r, 'Could not create the syndicate.');
			if (body.error === 'leader_not_copyable' && Array.isArray(body.leaders)) {
				errEl.innerHTML = `<strong>${esc(message)}</strong><ul>${body.leaders.map((l) => `<li>${esc(l.name)}: ${esc(l.unmet.join(', '))}</li>`).join('')}</ul>`;
				errEl.hidden = false;
			} else {
				showFormErr(errEl, message);
			}
			btn.disabled = false;
			btn.textContent = 'Raise the flag';
			return;
		}
		const body = await r.json();
		location.href = `${body.syndicate.url}?founded=1`;
	} catch {
		showFormErr(errEl, 'Network error. Nothing was created; try again.');
		btn.disabled = false;
		btn.textContent = 'Raise the flag';
	}
}

function showFormErr(el, msg) {
	el.textContent = msg;
	el.hidden = false;
	el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.getElementById('syStart').addEventListener('click', () => openCreate());
document.getElementById('syCreateClose').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

// Deep links: /syndicates?start=1[&leader=<agent id>] opens the founding flow,
// which is where "Start a syndicate around this trader" on /trader/:id lands.
for (const b of sortSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort));
load(true).then(() => {
	if (params.get('start') === '1' || params.get('leader')) {
		const leader = params.get('leader');
		openCreate(leader && /^[0-9a-f-]{36}$/i.test(leader) ? [leader] : []);
	}
});
