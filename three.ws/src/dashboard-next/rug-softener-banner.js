// First-rug softener banner for the Sniper dashboard (docs/growth-programs.md).
//
// Renders nothing unless the owner has armed the program AND the signed-in
// account either qualifies or already has a claim on file. While the program is
// disarmed the host stays empty, so the page looks exactly as it did before.
//
//   GET  /api/sniper/rug-softener  eligibility + any existing claim
//   POST /api/sniper/rug-softener  record the claim (CSRF via api.js)

import { get, post, esc } from './api.js';
import { toast } from '../shared/toast.js';

const STYLE_ID = 'rs-banner-style';
const STYLE = `
.rs-banner { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 14px 16px;
	background: color-mix(in srgb, var(--nxt-accent) 7%, var(--nxt-panel)); border: 1px solid color-mix(in srgb, var(--nxt-accent) 35%, var(--nxt-stroke));
	border-radius: var(--nxt-radius); opacity: 0; transform: translateY(-4px); transition: opacity .2s ease, transform .2s ease; }
.rs-banner.in { opacity: 1; transform: none; }
.rs-banner-body { flex: 1; min-width: 220px; }
.rs-banner-title { font-weight: 600; font-size: 15px; }
.rs-banner-sub { font-size: 13px; color: var(--nxt-ink-dim); margin-top: 3px; line-height: 1.45; }
.rs-banner-sub a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.rs-banner-btn { font: inherit; font-weight: 600; font-size: 13px; padding: 8px 14px; border-radius: 8px; cursor: pointer;
	border: 1px solid var(--nxt-accent); background: var(--nxt-accent); color: var(--nxt-accent-ink, #0b0b0f); transition: filter .14s, transform .14s; }
.rs-banner-btn:hover { filter: brightness(1.08); }
.rs-banner-btn:active { transform: translateY(1px); }
.rs-banner-btn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.rs-banner-btn[disabled] { opacity: .6; cursor: progress; }
.rs-banner-status { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .rs-banner { transition: none; transform: none; } }
`;

function ensureStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = STYLE;
	document.head.appendChild(el);
}

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

const STATUS_LABEL = {
	claimed: 'Claim received, payout queued',
	sending: 'Payout sending',
	sent: 'Paid in $THREE',
	failed: 'Payout retrying',
	blocked: 'Payout on hold, contact support',
};

function claimView(claim) {
	const tx = claim.tx_signature
		? ` <a href="https://solscan.io/tx/${encodeURIComponent(claim.tx_signature)}" target="_blank" rel="noopener">View the transfer</a>.`
		: '';
	return `
		<div class="rs-banner-body">
			<div class="rs-banner-title">First-rug softener</div>
			<div class="rs-banner-sub">Your claim for ${usd(claim.usd_value)} in $THREE is on file.${tx}</div>
		</div>
		<span class="rs-banner-status" role="status">${esc(STATUS_LABEL[claim.status] || claim.status)}</span>`;
}

function eligibleView(data) {
	const p = data.position || {};
	const loss = Math.abs(Number(p.realized_pnl_sol || 0)).toFixed(3);
	const card = p.position_id ? ` <a href="/trade/${encodeURIComponent(p.position_id)}">See the trade</a>.` : '';
	return `
		<div class="rs-banner-body">
			<div class="rs-banner-title">Your first trade hit a verified rug</div>
			<div class="rs-banner-sub">You lost ${esc(loss)} SOL on your first live trade, and the coin was verified as a rug.
				The softener pays back ${esc(String(data.program.reimburse_pct))}% of that loss, worth ${usd(data.amount?.usd)} in $THREE, once per account.${card}</div>
		</div>
		<button type="button" class="rs-banner-btn" data-rs-claim>Claim ${usd(data.amount?.usd)} in $THREE</button>`;
}

/**
 * Mount the banner into `host`. Resolves quietly to an empty host on any
 * failure: this is an optional program, never a reason for the page to break.
 * @param {HTMLElement|null} host
 */
export async function mountRugSoftenerBanner(host) {
	if (!host) return;
	let data;
	try {
		data = await get('/api/sniper/rug-softener');
	} catch {
		host.innerHTML = '';
		return;
	}
	if (!data?.program?.armed) {
		host.innerHTML = '';
		return;
	}
	if (!data.claim && !data.eligible) {
		host.innerHTML = '';
		return;
	}

	ensureStyle();
	host.innerHTML = `<section class="rs-banner" aria-label="First-rug softener">${data.claim ? claimView(data.claim) : eligibleView(data)}</section>`;
	const banner = host.firstElementChild;
	requestAnimationFrame(() => banner?.classList.add('in'));

	const btn = host.querySelector('[data-rs-claim]');
	btn?.addEventListener('click', async () => {
		btn.disabled = true;
		btn.textContent = 'Claiming…';
		try {
			const out = await post('/api/sniper/rug-softener', {});
			banner.innerHTML = claimView(out.claim);
			toast('Claim received. The $THREE payout is queued.', { variant: 'success' });
		} catch (err) {
			btn.disabled = false;
			btn.textContent = `Claim ${usd(data.amount?.usd)} in $THREE`;
			const msg =
				err?.code === 'already_claimed'
					? 'A claim is already on file for this account.'
					: err?.code === 'program_not_open'
						? 'The softener closed for claims. Try again later.'
						: err?.message || 'The claim could not be recorded. Try again.';
			toast(msg, { variant: 'error' });
		}
	});
}
