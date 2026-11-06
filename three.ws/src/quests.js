// /quests: today's trading quests, XP level, daily-clear streak, quest badges.
//
// Reads GET /api/quests. Signed out, it shows the real quest catalog with a
// sign-in CTA. Signed in, progress comes from proof tables and anything newly
// earned is awarded by that same read. The $THREE claim appears only when the
// server says rewards are armed (TRADING_QUEST_THREE_REWARDS); by default it
// does not render at all.

import { apiFetch } from './api.js';
import { esc, toast, errorMessage } from './syndicate-shared.js';

const rootEl = document.getElementById('qxRoot');
const resetEl = document.getElementById('qxReset');

const QUEST_BADGES = [
	{ code: 'quest_first', label: 'First Quest', icon: '🎯', how: 'Complete any quest.' },
	{ code: 'quest_clear', label: 'Daily Clear', icon: '⚡', how: 'Clear three quests in one UTC day.' },
	{ code: 'quest_streak_7', label: 'Quest Streak 7', icon: '🏅', how: 'Clear the day seven days running.' },
];

let data = null;
let clockTimer = null;

async function load() {
	rootEl.setAttribute('aria-busy', 'true');
	try {
		const r = await apiFetch('/api/quests', { allowAnonymous: true, headers: { accept: 'application/json' } });
		if (!r.ok) {
			const { message } = await errorMessage(r, `Quests answered ${r.status}.`);
			return renderError(message);
		}
		data = await r.json();
		render();
		for (const n of data.newly_completed || []) {
			const q = (data.quests || []).find((x) => x.code === n.code);
			toast(n.code === 'daily_clear' ? `Day cleared. +${data.daily_clear.xp} XP` : `Quest complete: ${q?.title || n.code}. +${q?.xp ?? 0} XP`);
		}
	} catch {
		renderError('Check your connection.');
	} finally {
		rootEl.setAttribute('aria-busy', 'false');
	}
}

function renderError(message) {
	rootEl.innerHTML = `
		<div class="sy-state" role="alert">
			<h2>Quests did not load</h2>
			<p>${esc(message)} Anything you did today still counts: quests are scored from on-chain proof, so progress shows up the next time this loads.</p>
			<button type="button" class="sy-btn primary" id="qxRetry">Try again</button>
		</div>`;
	document.getElementById('qxRetry').addEventListener('click', load);
}

function ring(progress, target) {
	const r = 18;
	const c = 2 * Math.PI * r;
	const p = target > 0 ? Math.min(1, (progress ?? 0) / target) : 0;
	return `
		<svg class="qx-ring" viewBox="0 0 44 44" aria-hidden="true">
			<circle class="track" cx="22" cy="22" r="${r}" />
			<circle class="fill" cx="22" cy="22" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}" transform="rotate(-90 22 22)" />
			<text x="22" y="26" text-anchor="middle">${progress == null ? target : `${progress}/${target}`}</text>
		</svg>`;
}

function questItem(q, signedIn) {
	const status = q.done ? 'Complete' : signedIn ? `${q.progress} of ${q.target}` : `Goal: ${q.target}`;
	return `
		<li class="qx-quest${q.done ? ' done' : ''}">
			${ring(q.progress, q.target)}
			<div style="min-width:0">
				<div class="qx-q-title">${esc(q.title)} <span class="qx-xp">+${esc(q.xp)} XP</span>${q.done ? ' <span class="sy-badge good">Done</span>' : ''}</div>
				<div class="qx-q-detail">${esc(q.detail)}</div>
				<span class="sr-only">${esc(status)}</span>
			</div>
			${q.done ? '' : `<a class="sy-btn sm" href="${esc(q.cta.href)}">${esc(q.cta.label)}</a>`}
		</li>`;
}

function render() {
	const signedIn = !!data.signed_in;
	const quests = data.quests || [];
	const clear = data.daily_clear;
	tickClock();

	if (!signedIn) {
		const next = encodeURIComponent('/quests');
		rootEl.innerHTML = `
			<div class="sy-panel" style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between">
				<div style="min-width:0;max-width:60ch">
					<b style="font-size:16px">Sign in to start earning XP</b>
					<p class="sy-muted" style="margin:4px 0 0;line-height:1.5">Progress is scored from what you actually do: trades your linked wallet signs, forks, first ghost-copies, copy intents, and your agent's live wins.</p>
				</div>
				<div class="sy-actions"><a class="sy-btn primary" href="/login?next=${next}">Sign in</a><a class="sy-btn" href="/register?next=${next}">Create an account</a></div>
			</div>
			<ul class="qx-list" aria-label="Today's quests">${quests.map((q) => questItem(q, false)).join('')}</ul>
			<p class="sy-fine" style="margin-top:14px">Clear any ${esc(clear.need)} quests in one UTC day for a +${esc(clear.xp)} XP bonus.</p>
			${linksSection()}`;
		return;
	}

	const xp = data.xp;
	const pct = xp.level_span > 0 ? Math.round((xp.into_level / xp.level_span) * 100) : 0;
	const streak = data.clear_streak;
	const earned = new Set((data.badges || []).map((b) => b.code));

	rootEl.innerHTML = `
		<div class="qx-top">
			<section class="sy-panel" aria-label="Your level">
				<div class="qx-level">
					<span class="qx-level-num" aria-hidden="true">${esc(xp.level)}</span>
					<div style="flex:1;min-width:0">
						<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b style="font-size:17px">Level ${esc(xp.level)}</b><span class="sy-faint" style="font-size:13px">${esc(xp.total)} XP total</span></div>
						<div class="qx-bar" role="progressbar" aria-label="Progress to level ${esc(xp.level + 1)}" aria-valuemin="0" aria-valuemax="${esc(xp.level_span)}" aria-valuenow="${esc(xp.into_level)}"><i style="--p:${pct}%"></i></div>
						<div class="sy-faint" style="font-size:12.5px;margin-top:6px">${esc(xp.level_span - xp.into_level)} XP to level ${esc(xp.level + 1)}</div>
					</div>
				</div>
			</section>
			<section class="sy-panel" aria-label="Daily clear streak">
				<div class="qx-clear">
					<div>
						<b style="font-size:17px">${streak.current ? `${esc(streak.current)}-day clear streak` : 'No clear streak yet'}</b>
						<div class="sy-faint" style="font-size:12.5px;margin-top:4px">${streak.longest ? `Longest: ${esc(streak.longest)} ${streak.longest === 1 ? 'day' : 'days'}` : 'Clear three quests today to start one.'}</div>
					</div>
					<div style="text-align:right">
						<div class="qx-pips" aria-hidden="true">${Array.from({ length: clear.need }, (_, i) => `<i class="${i < clear.done_count ? 'on' : ''}"></i>`).join('')}</div>
						<div class="sy-faint" style="font-size:12.5px;margin-top:6px">${clear.cleared ? `<span class="pos">Day cleared · +${esc(clear.xp)} XP</span>` : `${esc(Math.min(clear.done_count, clear.need))} of ${esc(clear.need)} to clear today`}</div>
					</div>
				</div>
			</section>
		</div>

		<ul class="qx-list" aria-label="Today's quests">${quests.map((q) => questItem(q, true)).join('')}</ul>
		${rewardsSection()}

		<section class="sy-section" aria-labelledby="qxBadgesTitle">
			<h2 id="qxBadgesTitle" class="sy-h2">Quest badges <small>earned once, kept forever, shown on your profile</small></h2>
			<div class="qx-badges">
				${QUEST_BADGES.map((b) => `<span class="qx-badge${earned.has(b.code) ? '' : ' locked'}" title="${esc(b.how)}"><span aria-hidden="true">${b.icon}</span>${esc(b.label)}${earned.has(b.code) ? '' : `<span class="sr-only"> (locked: ${esc(b.how)})</span>`}</span>`).join('')}
			</div>
		</section>
		${data.yesterday?.cleared ? '' : data.yesterday?.done_count ? `<p class="sy-fine" style="margin-top:14px">Yesterday: ${esc(data.yesterday.done_count)} of ${esc(clear.need)} quests.</p>` : ''}
		${linksSection()}`;
	wireClaims();
}

function rewardsSection() {
	const rw = data.three_rewards;
	if (!rw?.armed) return '';
	const claims = new Map((rw.claims || []).map((c) => [c.day, c]));
	const days = [
		{ day: data.day, label: 'Today', cleared: data.daily_clear.cleared },
		{ day: data.yesterday.day, label: 'Yesterday', cleared: data.yesterday.cleared },
	].filter((d) => d.cleared);
	if (!days.length) {
		return `<div class="sy-note" style="margin-top:14px">Clear the day to claim ${esc(rw.amount_three)} $THREE to your linked Solana wallet.</div>`;
	}
	return `
		<section class="sy-panel" style="margin-top:14px" aria-labelledby="qxRewardTitle">
			<h2 id="qxRewardTitle" class="sy-h2">$THREE reward <small>${esc(rw.amount_three)} $THREE per cleared day, to your linked wallet</small></h2>
			<div class="sy-actions">
				${days.map((d) => {
					const c = claims.get(d.day);
					if (c?.status === 'sent') return `<a class="sy-btn" href="https://solscan.io/tx/${esc(c.tx_signature)}" target="_blank" rel="noopener">${esc(d.label)}: sent ↗</a>`;
					if (c?.status === 'pending') return `<button type="button" class="sy-btn" disabled>${esc(d.label)}: sending…</button>`;
					return `<button type="button" class="sy-btn primary" data-claim="${esc(d.day)}">${c?.status === 'failed' ? 'Retry' : 'Claim'} ${esc(d.label.toLowerCase())}'s reward</button>`;
				}).join('')}
			</div>
		</section>`;
}

function wireClaims() {
	for (const btn of rootEl.querySelectorAll('[data-claim]')) {
		btn.addEventListener('click', async () => {
			btn.disabled = true;
			const label = btn.textContent;
			btn.textContent = 'Sending…';
			try {
				const r = await apiFetch('/api/quests/claim', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ day: btn.dataset.claim }),
				});
				if (!r.ok) {
					const { message } = await errorMessage(r, 'Could not send the reward.');
					toast(message);
					btn.disabled = false;
					btn.textContent = label;
					return;
				}
				toast('$THREE sent to your linked wallet.');
				load();
			} catch {
				toast('Network error. Nothing was sent; try again.');
				btn.disabled = false;
				btn.textContent = label;
			}
		});
	}
}

function linksSection() {
	return `
		<section class="sy-section" aria-label="Where quests happen">
			<div class="sy-actions">
				<a class="sy-btn" href="/syndicates">Join a syndicate</a>
				<a class="sy-btn" href="/play/arena">Watch the Arena</a>
				<a class="sy-btn" href="/duels">Call a trader duel</a>
				<a class="sy-btn" href="/docs/trading-quests">How quests are scored</a>
			</div>
		</section>`;
}

function tickClock() {
	if (!data?.resets_at) return;
	const ms = new Date(data.resets_at).getTime() - Date.now();
	if (ms <= 0) {
		clearInterval(clockTimer);
		clockTimer = null;
		resetEl.textContent = 'now';
		load();
		return;
	}
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	resetEl.textContent = `in ${h}h ${String(m).padStart(2, '0')}m`;
	if (!clockTimer) clockTimer = setInterval(tickClock, 30_000);
}

load();
