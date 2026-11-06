// /syndicates/:slug: one syndicate's page, and joining or leaving it.
//
// Public data comes from GET /api/syndicates/:slug (cacheable): identity, the
// leaders with their whole records, the roster, the group curve from members'
// real acted copies, and the rival one rank away. The viewer's own membership
// comes from GET /api/syndicates/membership. Joining posts the member's own
// wallet and caps to POST /api/syndicates/membership, which creates ordinary
// guarded copy subscriptions; intents then arrive on /dashboard/copy.

import { apiFetch } from './api.js';
import { esc, fmtSol, fmtPct, tone, avatar, hydrateAvatars, flag, recordLine, toast, currentUser, errorMessage, relTime, curveSvg } from './syndicate-shared.js';

const root = document.getElementById('syRoot');
const content = document.getElementById('syContent');
const leaveDialog = document.getElementById('syLeave');
const leaveBody = document.getElementById('syLeaveBody');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const slug = (() => {
	const seg = location.pathname.replace(/\/+$/, '').split('/').pop() || '';
	try { return decodeURIComponent(seg).toLowerCase(); } catch { return ''; }
})();
const params = new URLSearchParams(location.search);

let data = null;

// ── load ─────────────────────────────────────────────────────────────────────

async function load() {
	root.setAttribute('aria-busy', 'true');
	try {
		const r = await fetch(`/api/syndicates/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } });
		if (r.status === 404 || r.status === 400) return renderMissing();
		if (!r.ok) {
			const { message } = await errorMessage(r, `The syndicate answered ${r.status}.`);
			return renderError(message);
		}
		data = await r.json();
		render();
		loadMembership();
	} catch {
		renderError('Check your connection.');
	} finally {
		root.setAttribute('aria-busy', 'false');
	}
}

function renderMissing() {
	document.title = 'Syndicate not found · three.ws';
	content.innerHTML = `
		<div class="sy-state">
			<h2>No syndicate flies that name</h2>
			<p>The link may be mistyped, or the syndicate may have been renamed. The board lists every active syndicate, and you can start your own in a minute.</p>
			<div class="sy-actions" style="justify-content:center">
				<a class="sy-btn primary" href="/syndicates">Browse the board</a>
				<a class="sy-btn" href="/syndicates?start=1">Start a syndicate</a>
			</div>
		</div>`;
}

function renderError(message) {
	content.innerHTML = `
		<div class="sy-state" role="alert">
			<h2>This syndicate did not load</h2>
			<p>${esc(message)} Your copy subscriptions keep running either way.</p>
			<button type="button" class="sy-btn primary" id="syRetry">Try again</button>
		</div>`;
	document.getElementById('syRetry').addEventListener('click', load);
}

// ── render ───────────────────────────────────────────────────────────────────

function render() {
	const { syndicate: s, leaders, members, performance: p, since_founding: since, standing } = data;
	document.title = `${s.name} · Syndicate · three.ws`;
	const founder = s.founder?.display_name || s.founder?.username;

	content.innerHTML = `
		<header class="sy-head" style="--flag:${esc(s.color)}">
			${flag(s.name, s.color, 'sy-flag lg')}
			<div style="min-width:0">
				<h1>${esc(s.name)}</h1>
				${s.motto ? `<p class="sy-motto">"${esc(s.motto)}"</p>` : ''}
				<div class="sy-head-meta">
					${s.official ? '<span class="sy-badge official" title="Founded by the owner of a leader it follows">Official fan club</span>' : ''}
					${s.network === 'devnet' ? '<span class="sy-badge">devnet</span>' : ''}
					<span>Formed ${esc(relTime(s.created_at))}${founder ? ` by ${esc(founder)}` : ''}</span>
					<button type="button" class="sy-btn sm" id="syShare">Share</button>
					<a class="sy-btn sm primary" href="#syJoin">Membership</a>
				</div>
			</div>
		</header>

		<div class="sy-grid">
			<div style="display:grid;gap:16px;min-width:0">
				<section class="sy-panel" aria-labelledby="syPerfTitle">
					<h2 id="syPerfTitle" class="sy-h2">Group performance <small>members' real copies, priced at each leader's realized return</small></h2>
					<dl class="sy-tiles">
						<div class="sy-tile"><dt>Group P&amp;L</dt><dd class="${tone(p.realized_profit_sol)}">${esc(fmtSol(p.realized_profit_sol))}</dd><small>realized, closed copies</small></div>
						<div class="sy-tile"><dt>Closed copies</dt><dd>${esc(p.closed_copies)}</dd><small>${p.win_rate_pct == null ? 'no closes yet' : `${esc(Math.round(p.win_rate_pct))}% in profit`}</small></div>
						<div class="sy-tile"><dt>Copied</dt><dd>${esc(Number(p.copied_sol).toFixed(2))} SOL</dd><small>${esc(p.acted)} of ${esc(p.intents)} intents acted on</small></div>
						<div class="sy-tile"><dt>Leaders since formed</dt><dd class="${tone(since.leader_roi_pct)}">${since.leader_closes ? esc(fmtPct(since.leader_roi_pct)) : 'n/a'}</dd><small>${since.leader_closes ? `${esc(since.leader_closes)} live closes, ${esc(fmtSol(since.leader_pnl_sol))}` : 'no live closes since founding'}</small></div>
					</dl>
					<div style="margin-top:16px">
						${p.curve.points.length
							? curveSvg(p.curve.points, { color: s.color, label: `${s.name} group equity curve` })
							: `<div class="sy-chart-empty"><div><b>No closed copies yet.</b><br />The curve starts when a member acts on a copy intent and the leader closes that position. Every point is a real copy, winners and losers alike.</div></div>`}
					</div>
				</section>

				<section aria-labelledby="syLeadTitle">
					<h2 id="syLeadTitle" class="sy-h2">Following <small>whole closed records, losses included</small></h2>
					<div class="sy-leaders">${leaders.map(leaderCard).join('')}</div>
				</section>

				<section class="sy-panel" aria-labelledby="syRosterTitle">
					<h2 id="syRosterTitle" class="sy-h2">Roster <small>${esc(members.count)} ${members.count === 1 ? 'member' : 'members'} · ${esc(members.copying)} copying now${members.alumni ? ` · ${esc(members.alumni)} alumni` : ''}</small></h2>
					${members.list.length ? `<ul class="sy-roster">${members.list.map(memberItem).join('')}</ul>` : `<p class="sy-muted" style="margin:0">Nobody has joined yet. The first member sets the pace, and the roster shows usernames only: never a wallet, never a size.</p>`}
					${members.count > members.list.length ? `<p class="sy-fine" style="margin-top:10px">Showing the first ${members.list.length} of ${members.count}.</p>` : ''}
				</section>
			</div>

			<aside class="sy-side" style="display:grid;gap:16px;min-width:0">
				<section class="sy-panel" aria-labelledby="syStandTitle">
					<h2 id="syStandTitle" class="sy-h2">Standing</h2>
					${standingHtml(standing)}
				</section>
				<section class="sy-panel" id="syJoin" aria-labelledby="syJoinTitle" tabindex="-1">
					<h2 id="syJoinTitle" class="sy-h2">Ride with ${esc(s.name)}</h2>
					<div id="syJoinBody"><div class="sy-skel" style="height:120px"></div></div>
				</section>
			</aside>
		</div>`;
	hydrateAvatars(content);
	document.getElementById('syShare').addEventListener('click', share);
}

function leaderCard(l) {
	return `
		<div class="sy-leader">
			${avatar(l.name, l.image)}
			<div style="min-width:0">
				<div class="sy-leader-name">${esc(l.name)}</div>
				<div style="margin-top:4px">${!l.available ? '<span class="sy-badge warn">No longer public</span>' : l.copyable ? '<span class="sy-badge good">Copyable</span>' : '<span class="sy-badge warn">Not copyable right now</span>'}</div>
				<div class="sy-leader-line">${recordLine(l.record)}${l.record.roi_pct != null ? ` · <span class="${tone(l.record.roi_pct)}">${esc(fmtPct(l.record.roi_pct))} ROI</span>` : ''}</div>
				${!l.copyable && l.unmet.length ? `<div class="sy-leader-line">Still short: ${esc(l.unmet.join(', '))}</div>` : ''}
				<div class="sy-leader-links">
					<a href="${esc(l.trader_url)}">Full record</a>
					<a href="/ghost-copy?leader=${esc(l.agent_id)}&amp;budget=1&amp;window=7d">Ghost-copy</a>
				</div>
			</div>
		</div>`;
}

function memberItem(m) {
	const body = `${avatar(m.display_name, m.avatar_url)}<div><b>${esc(m.display_name)}</b><small>${m.role === 'founder' ? 'Founder · ' : ''}joined ${esc(relTime(m.joined_at))}</small></div>`;
	return `<li>${m.username ? `<a href="/u/${encodeURIComponent(m.username)}" style="display:flex;gap:10px;align-items:center;min-width:0">${body}</a>` : body}</li>`;
}

function standingHtml(st) {
	if (!st?.rank) return '<p class="sy-muted" style="margin:0">Not ranked: this syndicate is not active on the board.</p>';
	const rival = st.rival;
	const head = `<p style="margin:0 0 12px"><span style="font-size:32px;font-weight:900;letter-spacing:-.03em">#${esc(st.rank)}</span> <span class="sy-faint">of ${esc(st.total)} on the profit board</span></p>`;
	if (!rival) return `${head}<p class="sy-muted" style="margin:0">No rival yet. The next syndicate to form becomes the one to beat. <a href="/syndicates?start=1">Start one</a>.</p>`;
	const verb = rival.direction === 'ahead'
		? `${esc(fmtSol(rival.gap_sol, { sign: false }))} ahead of you. Catch them.`
		: `${esc(fmtSol(rival.gap_sol, { sign: false }))} behind you and chasing.`;
	return `${head}
		<a class="sy-rival" href="${esc(rival.url)}" style="--flag:${esc(rival.color)}">
			${flag(rival.name, rival.color)}
			<span style="min-width:0"><b style="display:block">${esc(rival.name)}</b><small class="sy-faint">${verb}</small></span>
		</a>`;
}

async function share() {
	const url = `${location.origin}/syndicates/${data.syndicate.slug}`;
	const text = `Ride with ${data.syndicate.name} on three.ws: a copy-trading syndicate where everyone copies from their own wallet under their own caps.`;
	try {
		if (navigator.share) { await navigator.share({ title: data.syndicate.name, text, url }); return; }
		await navigator.clipboard.writeText(url);
		toast('Link copied');
	} catch (err) {
		if (err?.name !== 'AbortError') toast('Copy this link: ' + url);
	}
}

// ── membership ───────────────────────────────────────────────────────────────

const joinBody = () => document.getElementById('syJoinBody');

async function loadMembership() {
	const el = joinBody();
	if (!el) return;
	const user = await currentUser();
	if (!user) return renderSignedOut(el);
	try {
		const r = await apiFetch(`/api/syndicates/membership?slug=${encodeURIComponent(slug)}`, { allowAnonymous: true, headers: { accept: 'application/json' } });
		if (r.status === 401) return renderSignedOut(el);
		if (!r.ok) {
			const { message } = await errorMessage(r, 'Could not load your membership.');
			return renderJoinError(el, message);
		}
		const { membership } = await r.json();
		renderMembership(el, membership, user);
	} catch {
		renderJoinError(el, 'Network error.');
	}
}

function renderJoinError(el, message) {
	el.innerHTML = `<p class="sy-muted" style="margin:0 0 12px">${esc(message)}</p><button type="button" class="sy-btn" id="syJoinRetry">Retry</button>`;
	el.querySelector('#syJoinRetry').addEventListener('click', loadMembership);
}

function renderSignedOut(el) {
	const next = encodeURIComponent(location.pathname);
	el.innerHTML = `
		<p class="sy-muted" style="margin:0 0 12px;line-height:1.55">Copy these leaders from your own wallet with your own caps, and your copies count toward the team's curve. Sign in to join.</p>
		<div class="sy-actions"><a class="sy-btn primary" href="/login?next=${next}">Sign in to join</a><a class="sy-btn" href="/ghost-copy?leader=${esc(data.leaders[0]?.agent_id || '')}">Ghost-copy first</a></div>`;
}

function renderMembership(el, m, user) {
	if (params.get('founded') === '1') {
		toast('Flag raised. Join with your own caps, or share it with followers.');
		history.replaceState(null, '', location.pathname);
		params.delete('founded');
		document.getElementById('syJoin')?.focus();
	}
	if (m.member) return renderMember(el, m);
	if (m.owns_leader) {
		el.innerHTML = `
			<p class="sy-muted" style="margin:0 0 12px;line-height:1.55">You run one of the leaders this syndicate follows, so you cannot copy it: that would pay a performance fee to yourself. Your part is the trading. Share this page with the people who follow you.</p>
			<div class="sy-actions"><button type="button" class="sy-btn primary" id="syShare2">Share with followers</button></div>`;
		el.querySelector('#syShare2').addEventListener('click', share);
		return;
	}
	if (m.other_syndicate) {
		el.innerHTML = `
			<p class="sy-muted" style="margin:0 0 12px;line-height:1.55">You ride with <a href="${esc(m.other_syndicate.url)}"><b>${esc(m.other_syndicate.name)}</b></a>. One syndicate at a time: leave it first if you want to switch sides.</p>
			<div class="sy-actions"><a class="sy-btn" href="${esc(m.other_syndicate.url)}">Go to ${esc(m.other_syndicate.name)}</a></div>`;
		return;
	}
	if (!data.joinable) {
		const blocked = data.leaders.filter((l) => !l.copyable || !l.available);
		el.innerHTML = `
			<p class="sy-muted" style="margin:0;line-height:1.55">Closed to new members for now: ${blocked.map((l) => `<b>${esc(l.name)}</b>`).join(', ')} ${blocked.length === 1 ? 'does' : 'do'} not clear the copyable bar at the moment. It reopens on its own once every leader does.</p>`;
		return;
	}
	renderJoinForm(el, user);
}

function renderMember(el, m) {
	const names = new Map(data.leaders.map((l) => [l.agent_id, l.name]));
	const subs = m.member.subscriptions;
	el.innerHTML = `
		<p style="margin:0 0 10px"><span class="sy-badge good">You ride with this syndicate</span></p>
		<p class="sy-muted" style="margin:0 0 12px;line-height:1.55">Joined ${esc(relTime(m.member.joined_at))}. When a leader trades, a sized intent lands on your copy dashboard; you execute it from your own wallet.</p>
		<ul style="list-style:none;margin:0 0 14px;padding:0;display:grid;gap:6px">
			${subs.map((s) => `<li class="sy-leader-line" style="display:flex;justify-content:space-between;gap:10px"><span>${esc(names.get(s.leader_agent_id) || 'Leader')}</span><span>${s.status === 'active' ? '<span class="pos">copying</span>' : s.status === 'paused' ? `<span class="sy-faint">${s.paused_reason === 'leader_drawdown_breach' ? 'paused by your drawdown limit' : 'paused'}</span>` : '<span class="neg">stopped</span>'}</span></li>`).join('')}
		</ul>
		<div class="sy-actions">
			<a class="sy-btn primary" href="/dashboard/copy">Open copy intents</a>
			<button type="button" class="sy-btn danger" id="syLeaveBtn">Leave</button>
		</div>
		<p class="sy-fine" style="margin-top:12px">Pause, resume, or change caps per leader on your copy dashboard; the syndicate follows those settings.</p>`;
	el.querySelector('#syLeaveBtn').addEventListener('click', () => openLeave(m));
}

function renderJoinForm(el, user) {
	const wallet = user?.wallet_address && BASE58_RE.test(user.wallet_address) ? user.wallet_address : '';
	el.innerHTML = `
		<form class="sy-form" id="syJoinForm" novalidate>
			<label class="sy-field">
				<span class="sy-label">Your Solana wallet</span>
				<input class="sy-input" id="syWallet" autocomplete="off" spellcheck="false" inputmode="text" placeholder="The wallet you copy from" value="${esc(wallet)}" required />
				<span class="sy-hint">You sign every copy from this wallet. We store its address, never a key.</span>
			</label>
			<div class="sy-row2">
				<label class="sy-field"><span class="sy-label">SOL per copy</span><input class="sy-input" id="syFixed" type="number" min="0.01" step="0.01" value="0.1" required /></label>
				<label class="sy-field"><span class="sy-label">Max per trade</span><input class="sy-input" id="syCap" type="number" min="0.01" step="0.05" value="0.5" required /></label>
			</div>
			<div class="sy-row2">
				<label class="sy-field"><span class="sy-label">Daily budget (SOL)</span><input class="sy-input" id="syDaily" type="number" min="0.01" step="0.1" value="1" required /></label>
				<label class="sy-field"><span class="sy-label">Pause at drawdown (%)</span><input class="sy-input" id="syDd" type="number" min="1" max="100" step="1" value="35" placeholder="never" /></label>
			</div>
			<p class="sy-hint" style="margin:0">These caps apply to each leader this syndicate follows (${esc(data.leaders.length)}). If you already copy one of them, your existing settings are kept, not replaced.</p>
			<div id="syJoinErr" class="sy-err" role="alert" hidden></div>
			<button type="submit" class="sy-btn primary" id="syJoinSubmit">Join ${esc(data.syndicate.name)}</button>
			<p class="sy-fine">Your username appears on the roster; your wallet and sizes never do. Copy trading is risky and you execute every trade yourself.</p>
		</form>`;
	el.querySelector('#syJoinForm').addEventListener('submit', submitJoin);
}

async function submitJoin(e) {
	e.preventDefault();
	const el = joinBody();
	const errEl = el.querySelector('#syJoinErr');
	const btn = el.querySelector('#syJoinSubmit');
	errEl.hidden = true;
	const wallet = el.querySelector('#syWallet').value.trim();
	if (!BASE58_RE.test(wallet)) return showErr(errEl, 'Enter a valid Solana wallet address.');
	const num = (id) => Number(el.querySelector(id).value);
	const dd = el.querySelector('#syDd').value.trim();
	const body = {
		slug,
		action: 'join',
		copier_wallet: wallet,
		sizing_rule: 'fixed',
		fixed_sol: num('#syFixed'),
		per_trade_cap_sol: num('#syCap'),
		daily_budget_sol: num('#syDaily'),
		max_drawdown_pct: dd === '' ? null : Number(dd),
	};
	if (!(body.fixed_sol > 0)) return showErr(errEl, 'SOL per copy must be more than 0.');
	if (body.fixed_sol > body.per_trade_cap_sol) return showErr(errEl, 'SOL per copy cannot be above your max per trade.');

	btn.disabled = true;
	btn.textContent = 'Joining…';
	try {
		const r = await apiFetch('/api/syndicates/membership', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			const { body: b, message } = await errorMessage(r, 'Could not join.');
			if (Array.isArray(b.leaders) && b.leaders.length) {
				errEl.innerHTML = `<strong>${esc(message)}</strong><ul>${b.leaders.map((l) => `<li>${esc(l.name)}: ${esc((l.unmet || []).join(', '))}</li>`).join('')}</ul>`;
				errEl.hidden = false;
			} else {
				showErr(errEl, message);
			}
			btn.disabled = false;
			btn.textContent = `Join ${data.syndicate.name}`;
			return;
		}
		toast(`Welcome to ${data.syndicate.name}. Intents will land on your copy dashboard.`);
		await refresh();
	} catch {
		showErr(errEl, 'Network error. Nothing changed; try again.');
		btn.disabled = false;
		btn.textContent = `Join ${data.syndicate.name}`;
	}
}

function openLeave(m) {
	const names = new Map(data.leaders.map((l) => [l.agent_id, l.name]));
	const made = m.member.subscriptions.filter((s) => s.created_by_join);
	const kept = m.member.subscriptions.filter((s) => !s.created_by_join);
	leaveBody.innerHTML = `
		<p class="sy-muted" style="margin:0 0 12px;line-height:1.55">Leaving takes you off the roster, and your copies stop counting toward the team curve.</p>
		${made.length ? `<p style="margin:0 0 6px"><b>Stops copying</b> (joining started these):</p><ul class="sy-leader-line" style="margin:0 0 12px">${made.map((s) => `<li>${esc(names.get(s.leader_agent_id) || 'Leader')}</li>`).join('')}</ul>` : ''}
		${kept.length ? `<p style="margin:0 0 6px"><b>Keeps copying</b> (you followed these before joining):</p><ul class="sy-leader-line" style="margin:0 0 12px">${kept.map((s) => `<li>${esc(names.get(s.leader_agent_id) || 'Leader')}</li>`).join('')}</ul>` : ''}
		<p class="sy-fine" style="margin:0 0 14px">Positions you already hold are yours and are not touched.</p>
		<div id="syLeaveErr" class="sy-err" role="alert" hidden></div>
		<div class="sy-actions">
			<button type="button" class="sy-btn danger" id="syLeaveConfirm">Leave ${esc(data.syndicate.name)}</button>
			<button type="button" class="sy-btn" data-close>Stay</button>
		</div>`;
	leaveDialog.showModal();
	leaveBody.querySelector('#syLeaveConfirm').addEventListener('click', confirmLeave);
}

async function confirmLeave() {
	const btn = leaveBody.querySelector('#syLeaveConfirm');
	const errEl = leaveBody.querySelector('#syLeaveErr');
	btn.disabled = true;
	btn.textContent = 'Leaving…';
	try {
		const r = await apiFetch('/api/syndicates/membership', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ slug, action: 'leave' }),
		});
		if (!r.ok) {
			const { message } = await errorMessage(r, 'Could not leave.');
			showErr(errEl, message);
			btn.disabled = false;
			btn.textContent = `Leave ${data.syndicate.name}`;
			return;
		}
		leaveDialog.close();
		toast(`You left ${data.syndicate.name}.`);
		await refresh();
	} catch {
		showErr(errEl, 'Network error. You are still a member; try again.');
		btn.disabled = false;
		btn.textContent = `Leave ${data.syndicate.name}`;
	}
}

async function refresh() {
	try {
		const r = await fetch(`/api/syndicates/${encodeURIComponent(slug)}?fresh=${Date.now()}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
		if (r.ok) { data = await r.json(); render(); }
	} catch {
		// The page already shows the last good state; the membership panel below still refreshes.
	}
	await loadMembership();
}

function showErr(el, msg) {
	el.textContent = msg;
	el.hidden = false;
}

leaveDialog.addEventListener('click', (e) => {
	if (e.target === leaveDialog || e.target.closest('[data-close]')) leaveDialog.close();
});

load();
