/**
 * Per-skill ratings & reviews surface.
 * ────────────────────────────────────
 * A small, self-contained module that renders the average rating, an
 * accessible star-rating widget, and the review list for a single paid skill
 * on an agent. It talks to /api/skills/review (GET list/aggregate, POST upsert).
 *
 * Designed states: loading skeleton · empty ("be the first") · error (with
 * retry) · populated. The compose form only appears when the caller signals
 * the viewer owns the skill (canReview); everyone can read.
 *
 * Usage:
 *   import { mountSkillReviews } from './skill-reviews.js';
 *   const handle = mountSkillReviews(container, { agentId, skill, canReview, isOwner });
 *   handle.setCanReview(true);   // re-render the form after a purchase completes
 *   handle.destroy();            // detach listeners
 *
 * The widget is keyboard-operable (radiogroup of stars, arrow keys + 1–5) and
 * ARIA-labelled. Styles are injected once, scoped under `.skr-*`, mirroring the
 * agent-detail token vocabulary (--ad-*) so it blends into that page without
 * touching its stylesheet.
 */

import { apiPostWithCsrf } from './shared/skill-purchase.js';
import { log } from './shared/log.js';

const API = '/api';
const PAGE_SIZE = 5;

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}

function relativeTime(iso) {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	const secs = Math.round((Date.now() - then) / 1000);
	const units = [
		['year', 31536000], ['month', 2592000], ['week', 604800],
		['day', 86400], ['hour', 3600], ['minute', 60],
	];
	for (const [name, span] of units) {
		const n = Math.floor(secs / span);
		if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
	}
	return 'just now';
}

// Static (display-only) star row. `value` may be fractional for averages.
function starsStatic(value, { size = 16 } = {}) {
	const v = Math.max(0, Math.min(5, Number(value) || 0));
	let html = `<span class="skr-stars-static" aria-hidden="true" style="--skr-star-size:${size}px">`;
	for (let i = 1; i <= 5; i += 1) {
		const fill = Math.max(0, Math.min(1, v - (i - 1)));
		html += `<span class="skr-star"><span class="skr-star-fill" style="width:${Math.round(fill * 100)}%">★</span><span class="skr-star-empty">★</span></span>`;
	}
	html += '</span>';
	return html;
}

let stylesInjected = false;
function injectStyles() {
	if (stylesInjected || typeof document === 'undefined') return;
	stylesInjected = true;
	const css = `
.skr-root{margin-top:14px;border-top:1px solid var(--ad-line,rgba(255,255,255,.07));padding-top:14px;font:inherit;color:var(--ad-text,#e7e9ee)}
.skr-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.skr-head-avg{display:flex;align-items:baseline;gap:6px}
.skr-avg-num{font-size:22px;font-weight:700;line-height:1}
.skr-avg-count{font-size:12px;color:var(--ad-muted,rgba(231,233,238,.55))}
.skr-stars-static{display:inline-flex;gap:2px;line-height:1}
.skr-star{position:relative;display:inline-block;width:var(--skr-star-size,16px);height:var(--skr-star-size,16px);font-size:var(--skr-star-size,16px)}
.skr-star-empty{color:var(--ad-line-2,rgba(255,255,255,.12))}
.skr-star-fill{position:absolute;left:0;top:0;overflow:hidden;color:var(--ad-amber,#f5a524);white-space:nowrap}
.skr-list{display:flex;flex-direction:column;gap:10px}
.skr-item{background:var(--ad-bg-2,#141414);border:1px solid var(--ad-line,rgba(255,255,255,.07));border-radius:10px;padding:10px 12px;animation:skr-in .25s ease}
.skr-item.is-mine{border-color:var(--ad-cyan,#57c7ff)}
.skr-item-top{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.skr-ava{width:24px;height:24px;border-radius:50%;background:var(--ad-card,#181818);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--ad-muted,rgba(231,233,238,.55));overflow:hidden;flex:0 0 auto}
.skr-ava img{width:100%;height:100%;object-fit:cover}
.skr-author{font-size:13px;font-weight:600}
.skr-mine-tag{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--ad-cyan,#57c7ff);border:1px solid var(--ad-cyan,#57c7ff);border-radius:999px;padding:1px 6px}
.skr-time{font-size:11px;color:var(--ad-dim,rgba(231,233,238,.35));margin-left:auto}
.skr-body{font-size:13px;line-height:1.5;color:var(--ad-text,#e7e9ee);white-space:pre-wrap;word-break:break-word;margin:4px 0 0}
.skr-empty,.skr-error{font-size:13px;color:var(--ad-muted,rgba(231,233,238,.55));padding:14px;text-align:center;background:var(--ad-bg-2,#141414);border:1px dashed var(--ad-line-2,rgba(255,255,255,.12));border-radius:10px}
.skr-error{border-style:solid;color:var(--ad-amber,#f5a524)}
.skr-retry{margin-top:8px;display:inline-block;background:none;border:1px solid var(--ad-line-2,rgba(255,255,255,.12));color:var(--ad-text,#e7e9ee);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.skr-retry:hover{border-color:var(--ad-text,#e7e9ee)}
.skr-more{margin:6px auto 0;display:block;background:none;border:1px solid var(--ad-line-2,rgba(255,255,255,.12));color:var(--ad-muted,rgba(231,233,238,.55));border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}
.skr-more:hover{border-color:var(--ad-text,#e7e9ee);color:var(--ad-text,#e7e9ee)}
.skr-more:disabled{opacity:.5;cursor:default}
.skr-form{margin-top:12px;background:var(--ad-bg-2,#141414);border:1px solid var(--ad-line,rgba(255,255,255,.07));border-radius:10px;padding:12px}
.skr-form-label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ad-muted,rgba(231,233,238,.55));display:block;margin-bottom:6px}
.skr-rate{display:inline-flex;gap:4px;margin-bottom:10px}
.skr-rate-star{background:none;border:none;padding:0;margin:0;cursor:pointer;font-size:26px;line-height:1;color:var(--ad-line-2,rgba(255,255,255,.12));transition:color .12s ease,transform .12s ease}
.skr-rate-star[aria-checked="true"],.skr-rate-star.is-lit{color:var(--ad-amber,#f5a524)}
.skr-rate-star:hover{transform:scale(1.12)}
.skr-rate:focus-within{outline:none}
.skr-rate-star:focus-visible{outline:2px solid var(--ad-cyan,#57c7ff);outline-offset:2px;border-radius:4px}
.skr-textarea{width:100%;box-sizing:border-box;background:var(--ad-bg,#0d0d0d);border:1px solid var(--ad-line,rgba(255,255,255,.07));border-radius:8px;color:var(--ad-text,#e7e9ee);font:inherit;font-size:13px;padding:8px 10px;resize:vertical;min-height:60px}
.skr-textarea:focus{outline:none;border-color:var(--ad-cyan,#57c7ff)}
.skr-form-row{display:flex;align-items:center;gap:10px;margin-top:8px}
.skr-count{font-size:11px;color:var(--ad-dim,rgba(231,233,238,.35));margin-left:auto}
.skr-submit{background:var(--ad-text,#e7e9ee);color:var(--ad-bg,#0d0d0d);border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .12s ease}
.skr-submit:hover{opacity:.85}
.skr-submit:disabled{opacity:.4;cursor:default}
.skr-form-msg{font-size:12px;margin-top:8px}
.skr-form-msg.err{color:var(--ad-amber,#f5a524)}
.skr-form-msg.ok{color:var(--ad-green,#4ade80)}
.skr-skel{display:flex;flex-direction:column;gap:10px}
.skr-skel-row{height:48px;border-radius:10px;background:linear-gradient(100deg,var(--skeleton-base,rgba(255,255,255,.04)) 30%,var(--skeleton-sheen,rgba(255,255,255,.08)) 50%,var(--skeleton-base,rgba(255,255,255,.04)) 70%);background-size:200% 100%;animation:skr-shimmer 1.4s ease-in-out infinite}
@keyframes skr-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes skr-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (max-width:480px){.skr-avg-num{font-size:18px}.skr-rate-star{font-size:22px}}
@media (prefers-reduced-motion:reduce){.skr-item,.skr-skel-row{animation:none}.skr-rate-star:hover{transform:none}}
`;
	const el = document.createElement('style');
	el.id = 'skr-styles';
	el.textContent = css;
	document.head.appendChild(el);
}

/**
 * Mount the reviews surface inside `container` for one (agentId, skill).
 * Returns a handle with { setCanReview, refresh, destroy }.
 */
export function mountSkillReviews(container, { agentId, skill, canReview = false, isOwner = false } = {}) {
	if (!container || !agentId || !skill) {
		return { setCanReview() {}, refresh() {}, destroy() {} };
	}
	injectStyles();

	const state = {
		summary: { rating_avg: 0, rating_count: 0 },
		reviews: [],
		page: 1,
		hasMore: false,
		total: 0,
		myReview: null,
		status: 'loading', // loading | error | ready
		canReview,
		isOwner,
		formRating: 0,
		submitting: false,
	};

	const root = document.createElement('div');
	root.className = 'skr-root';
	root.setAttribute('aria-label', `Reviews for ${skill}`);
	container.appendChild(root);

	function reviewItemHtml(r) {
		const ava = r.author_avatar
			? `<span class="skr-ava"><img loading="lazy" decoding="async" src="${esc(r.author_avatar)}" alt=""></span>`
			: `<span class="skr-ava">${esc((r.author_name || '?').trim().charAt(0).toUpperCase() || '?')}</span>`;
		return `
			<li class="skr-item${r.is_mine ? ' is-mine' : ''}">
				<div class="skr-item-top">
					${ava}
					<span class="skr-author">${esc(r.author_name || 'Anonymous')}</span>
					${r.is_mine ? '<span class="skr-mine-tag">You</span>' : ''}
					${starsStatic(r.rating, { size: 13 })}
					<span class="skr-time">${esc(relativeTime(r.created_at))}</span>
				</div>
				${r.body ? `<p class="skr-body">${esc(r.body)}</p>` : ''}
			</li>`;
	}

	function formHtml() {
		if (state.isOwner) return '';
		if (!state.canReview) return '';
		const editing = !!state.myReview;
		const rating = state.formRating || state.myReview?.rating || 0;
		const bodyVal = state.myReview?.body || '';
		const starBtns = [1, 2, 3, 4, 5].map((n) => `
			<button type="button" role="radio" class="skr-rate-star${n <= rating ? ' is-lit' : ''}"
				aria-checked="${n === rating}" aria-label="${n} star${n === 1 ? '' : 's'}"
				tabindex="${n === (rating || 1) ? '0' : '-1'}" data-val="${n}">★</button>`).join('');
		return `
			<form class="skr-form" novalidate>
				<span class="skr-form-label" id="skr-rate-label-${esc(agentId)}">${editing ? 'Update your rating' : 'Rate this skill'}</span>
				<div class="skr-rate" role="radiogroup" aria-labelledby="skr-rate-label-${esc(agentId)}">${starBtns}</div>
				<textarea class="skr-textarea" maxlength="2000" placeholder="Share what worked (optional)…" aria-label="Review comment">${esc(bodyVal)}</textarea>
				<div class="skr-form-row">
					<span class="skr-count">0 / 2000</span>
					<button type="submit" class="skr-submit" disabled>${editing ? 'Update review' : 'Submit review'}</button>
				</div>
				<div class="skr-form-msg" role="status" aria-live="polite"></div>
			</form>`;
	}

	function listHtml() {
		if (!state.reviews.length) {
			const prompt = state.canReview && !state.isOwner
				? 'Be the first to review this skill.'
				: state.isOwner
					? 'No reviews yet for this skill.'
					: 'No reviews yet — purchase this skill to leave the first one.';
			return `<div class="skr-empty">${esc(prompt)}</div>`;
		}
		const items = state.reviews.map(reviewItemHtml).join('');
		const more = state.hasMore
			? `<button type="button" class="skr-more">Show more reviews</button>`
			: '';
		return `<ul class="skr-list" style="list-style:none;margin:0;padding:0">${items}</ul>${more}`;
	}

	function render() {
		if (state.status === 'loading') {
			root.innerHTML = `<div class="skr-skel">${'<div class="skr-skel-row"></div>'.repeat(3)}</div>`;
			return;
		}
		if (state.status === 'error') {
			root.innerHTML = `<div class="skr-error">Couldn't load reviews.<br><button type="button" class="skr-retry">Retry</button></div>`;
			root.querySelector('.skr-retry')?.addEventListener('click', () => load(1));
			return;
		}
		const count = state.summary.rating_count;
		const head = count
			? `<div class="skr-head">
					<div class="skr-head-avg">
						<span class="skr-avg-num">${state.summary.rating_avg.toFixed(1)}</span>
						${starsStatic(state.summary.rating_avg, { size: 18 })}
					</div>
					<span class="skr-avg-count">${count} review${count === 1 ? '' : 's'}</span>
				</div>`
			: '';
		root.innerHTML = head + listHtml() + formHtml();
		bindAfterRender();
	}

	function bindAfterRender() {
		root.querySelector('.skr-more')?.addEventListener('click', () => load(state.page + 1, true));

		const form = root.querySelector('.skr-form');
		if (!form) return;
		const radiogroup = form.querySelector('.skr-rate');
		const stars = Array.from(form.querySelectorAll('.skr-rate-star'));
		const textarea = form.querySelector('.skr-textarea');
		const counter = form.querySelector('.skr-count');
		const submit = form.querySelector('.skr-submit');
		const msg = form.querySelector('.skr-form-msg');

		function syncCounter() {
			const len = textarea.value.length;
			counter.textContent = `${len} / 2000`;
			submit.disabled = state.submitting || !(state.formRating || state.myReview?.rating);
		}

		function paint(rating, hover) {
			stars.forEach((s) => {
				const v = Number(s.dataset.val);
				const lit = v <= (hover || rating);
				s.classList.toggle('is-lit', lit);
				s.setAttribute('aria-checked', String(v === rating));
				s.tabIndex = v === (rating || 1) ? 0 : -1;
			});
		}

		function setRating(n) {
			state.formRating = n;
			paint(n);
			syncCounter();
		}

		stars.forEach((s) => {
			const v = Number(s.dataset.val);
			s.addEventListener('click', () => { setRating(v); s.focus(); });
			s.addEventListener('mouseenter', () => paint(state.formRating || state.myReview?.rating || 0, v));
			s.addEventListener('keydown', (e) => {
				if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
					e.preventDefault(); setRating(Math.min(5, v + 1));
					stars[Math.min(4, v)].focus();
				} else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
					e.preventDefault(); setRating(Math.max(1, v - 1));
					stars[Math.max(0, v - 2)].focus();
				} else if (e.key === ' ' || e.key === 'Enter') {
					e.preventDefault(); setRating(v);
				} else if (/^[1-5]$/.test(e.key)) {
					e.preventDefault(); const n = Number(e.key); setRating(n); stars[n - 1].focus();
				}
			});
		});
		radiogroup.addEventListener('mouseleave', () => paint(state.formRating || state.myReview?.rating || 0));

		textarea.addEventListener('input', syncCounter);
		// Seed counter/submit from any pre-filled (editing) values.
		state.formRating = state.formRating || state.myReview?.rating || 0;
		paint(state.formRating);
		syncCounter();

		form.addEventListener('submit', async (e) => {
			e.preventDefault();
			const rating = state.formRating || state.myReview?.rating || 0;
			if (!rating || state.submitting) return;
			state.submitting = true;
			submit.disabled = true;
			msg.className = 'skr-form-msg';
			msg.textContent = 'Saving…';
			try {
				const resp = await apiPostWithCsrf(`${API}/skills/review`, {
					agent_id: agentId,
					skill,
					rating,
					body: textarea.value.trim() || null,
				});
				const data = await resp.json().catch(() => ({}));
				if (!resp.ok) {
					const code = data?.error || data?.code;
					const human = code === 'unauthorized'
						? 'Sign in to leave a review.'
						: code === 'not_purchased' || code === 'not_purchasable'
							? 'Purchase this skill before reviewing it.'
							: data?.error_description || data?.message || 'Could not save your review.';
					throw new Error(human);
				}
				msg.className = 'skr-form-msg ok';
				msg.textContent = state.myReview ? 'Review updated.' : 'Thanks for your review!';
				await load(1);
			} catch (err) {
				log.warn('[skill-reviews] submit failed:', err?.message);
				state.submitting = false;
				msg.className = 'skr-form-msg err';
				msg.textContent = err?.message || 'Could not save your review.';
				submit.disabled = false;
			}
		});
	}

	let aborter = null;
	async function load(page = 1, append = false) {
		if (aborter) aborter.abort();
		aborter = new AbortController();
		if (!append) { state.status = 'loading'; render(); }
		try {
			const url = `${API}/skills/review?agent_id=${encodeURIComponent(agentId)}&skill=${encodeURIComponent(skill)}&page=${page}&page_size=${PAGE_SIZE}`;
			const resp = await fetch(url, { credentials: 'include', signal: aborter.signal });
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const { data } = await resp.json();
			state.summary = data.summary || state.summary;
			state.total = data.total || 0;
			state.hasMore = !!data.has_more;
			state.page = data.page || page;
			state.myReview = data.my_review || null;
			state.formRating = state.myReview?.rating || 0;
			state.submitting = false;
			state.reviews = append ? state.reviews.concat(data.reviews || []) : (data.reviews || []);
			state.status = 'ready';
			render();
		} catch (err) {
			if (err?.name === 'AbortError') return;
			log.warn('[skill-reviews] load failed:', err?.message);
			state.status = 'error';
			render();
		}
	}

	load(1);

	return {
		setCanReview(v) {
			if (state.canReview === !!v) return;
			state.canReview = !!v;
			if (state.status === 'ready') render();
		},
		refresh() { load(1); },
		destroy() {
			if (aborter) aborter.abort();
			root.remove();
		},
	};
}
