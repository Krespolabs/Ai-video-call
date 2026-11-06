// Shared rendering helpers for /syndicates, /syndicates/:slug and /quests.

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Signed SOL with a sign and adaptive precision: "+0.042 SOL", "-1.20 SOL". */
export function fmtSol(v, { sign = true } = {}) {
	const n = num(v);
	const abs = Math.abs(n);
	const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
	const s = abs.toFixed(digits);
	if (!sign || n === 0) return `${n < 0 ? '-' : ''}${s} SOL`;
	return `${n > 0 ? '+' : '\u2212'}${s} SOL`;
}

export function fmtPct(v, { sign = true } = {}) {
	if (v == null || !Number.isFinite(Number(v))) return 'n/a';
	const n = Number(v);
	return `${sign && n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
}

/** CSS class for a signed number. */
export const tone = (v) => (num(v) > 0 ? 'pos' : num(v) < 0 ? 'neg' : 'flat');

export function relTime(iso) {
	if (!iso) return '';
	const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	const d = Math.round(h / 24);
	return d < 60 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** Round avatar, falling back to an initial when there is no image. Call
 *  hydrateAvatars(root) after inserting, so a broken image swaps to the initial. */
export function avatar(name, image, cls = 'sy-ava') {
	const initial = esc((String(name || '?').trim()[0] || '?').toUpperCase());
	if (image) {
		return `<img class="${cls}" src="${esc(image)}" alt="" loading="lazy" decoding="async" data-initial="${initial}" />`;
	}
	return `<span class="${cls}" aria-hidden="true">${initial}</span>`;
}

export function hydrateAvatars(root) {
	for (const img of root.querySelectorAll('img[data-initial]')) {
		img.addEventListener('error', () => {
			const span = document.createElement('span');
			span.className = img.className;
			span.setAttribute('aria-hidden', 'true');
			span.textContent = img.dataset.initial || '?';
			img.replaceWith(span);
		}, { once: true });
	}
}

/** A syndicate's flag: its color and the first letter of its name. */
export function flag(name, color, cls = 'sy-flag') {
	return `<span class="${cls}" style="--flag:${esc(color)}" aria-hidden="true">${esc((String(name || '?').trim()[0] || '?').toUpperCase())}</span>`;
}

/** One line describing a leader's whole closed record. */
export function recordLine(record) {
	if (!record) return '';
	const parts = [`${num(record.settled)} closed trades`];
	if (record.win_rate_pct != null) parts.push(`${Math.round(record.win_rate_pct)}% wins`);
	parts.push(`<span class="${tone(record.realized_pnl_sol)}">${esc(fmtSol(record.realized_pnl_sol))}</span> on ${esc(num(record.deployed_sol).toFixed(2))} SOL`);
	if (record.max_drawdown_pct != null) parts.push(`${esc(Math.round(record.max_drawdown_pct))}% max drawdown`);
	return parts.join(' · ');
}

let toastTimer;
export function toast(msg, el = document.getElementById('syToast')) {
	if (!el) return;
	el.textContent = msg;
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/** The signed-in user, or null. Never throws; a failed probe reads as signed out. */
let mePromise = null;
export function currentUser() {
	if (!mePromise) {
		mePromise = fetch('/api/auth/me', { credentials: 'include', headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => d?.user || null)
			.catch(() => null);
	}
	return mePromise;
}

/** The API's human message for a failed response. */
export async function errorMessage(res, fallback) {
	const body = await res.json().catch(() => ({}));
	return { body, message: body?.error_description || body?.message || fallback };
}

/** Equity curve SVG path over cumulative SOL points. */
export function curveSvg(points, { width = 600, height = 180, color = 'var(--sy-accent)', label = 'Group equity curve' } = {}) {
	if (!points?.length) return '';
	const ys = points.map((p) => num(p.cum_sol));
	const min = Math.min(0, ...ys);
	const max = Math.max(0, ...ys);
	const span = max - min || 1;
	const pad = 8;
	const x = (i) => (points.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (points.length - 1));
	const y = (v) => pad + ((max - v) * (height - pad * 2)) / span;
	const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(num(p.cum_sol)).toFixed(1)}`).join(' ');
	const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
	const last = ys[ys.length - 1];
	return `
		<svg class="sy-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: ${esc(fmtSol(last))} after ${points.length} closed copies">
			<line x1="0" x2="${width}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="var(--sy-line)" stroke-dasharray="4 4" />
			<path d="${area}" fill="${color}" opacity="0.12" />
			<path d="${line}" fill="none" stroke="${color}" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
		</svg>`;
}
