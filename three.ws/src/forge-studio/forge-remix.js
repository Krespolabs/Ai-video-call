// Remix — the composable-asset economy layered onto the forge result viewer.
//
// Two halves, both real, both wired against the existing remix rails
// (api/remix-feed.js free browse/publish, api/x402/remix-asset.js paid remix):
//
//   1. Publish — opt the model you just made into the remix bazaar: set a
//      royalty rate (capped at 20%), a license, and the Solana wallet that
//      collects it. Requires a real, owned creation id (forge.js / the
//      Iterate panel both set one on generation — a gallery-reopened model
//      you own also has one). Free — publishing itself costs nothing.
//
//   2. Bazaar — browse OTHER creators' published, remixable models with their
//      provenance and royalty terms visible up front, and remix one for a
//      real $0.25 USDC x402 payment. The platform generates a new version
//      anchored to the source and automatically routes the source creator's
//      royalty slice on-chain — a real second USDC transfer, not a ledger
//      entry. The receipt shown here carries the real settlement signature.
//
// $THREE-policy clean: USDC is the settlement asset only, no coin is named.

import { ensureX402 } from '../shared/x402-loader.js';
import { buildReceiptHTML } from '../shared/payment-receipt.js';

const resultPanel = document.getElementById('state-result');
const viewer = document.getElementById('viewer');
const viewerShell = document.getElementById('viewer-shell');

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WALLET_STORAGE_KEY = 'forge:remix-wallet';
const LICENSES = [
	{ value: 'remix-royalty', label: 'Remix allowed · royalty on remix', hint: 'The common choice — you earn every time someone builds on this.' },
	{ value: 'remix-cc', label: 'Remix freely · no royalty', hint: 'Open for anyone to build on, no payout.' },
	{ value: 'remix-nc', label: 'Remix, non-commercial', hint: 'Remixable with attribution norms, no payout.' },
	{ value: 'all-rights', label: 'Display only · not remixable', hint: 'Publishes to your profile only — no one can remix it.' },
];

if (resultPanel && viewer) {
	const CLIENT_HEADERS = (() => {
		try {
			const id = localStorage.getItem('forge:cid');
			return id ? { 'x-forge-client': id } : {};
		} catch {
			return {};
		}
	})();

	injectStyles();
	const els = injectPanel();

	let current = { glbUrl: '', prompt: '', creationId: null };
	let feedItems = [];
	let feedCursor = null;
	let feedLoaded = false;

	// ── Publish ──────────────────────────────────────────────────────────────

	function esc(s) {
		return String(s ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function savedWallet() {
		try {
			return localStorage.getItem(WALLET_STORAGE_KEY) || '';
		} catch {
			return '';
		}
	}

	function updatePublishAvailability() {
		const has = Boolean(current.creationId);
		els.publishSection.hidden = !has;
		els.publishNote.hidden = has;
	}

	function setPublishStatus(text, kind = '') {
		els.publishStatus.textContent = text || '';
		els.publishStatus.dataset.kind = kind;
	}

	async function publish() {
		if (!current.creationId) return;
		const wallet = els.publishWallet.value.trim();
		if (wallet && !WALLET_RE.test(wallet)) {
			setPublishStatus('That doesn’t look like a Solana address — check it and try again.', 'error');
			return;
		}
		const license = els.publishLicense.value;
		const royaltyBps = Math.round(Number(els.publishRoyalty.value || 0) * 100);
		els.publishBtn.disabled = true;
		setPublishStatus('Publishing…', 'busy');
		try {
			const res = await fetch('/api/remix-feed', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
				body: JSON.stringify({
					action: 'publish',
					creation_id: current.creationId,
					license,
					royalty_bps: license === 'all-rights' ? 0 : royaltyBps,
					...(wallet ? { creator_wallet: wallet } : {}),
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data?.published) {
				setPublishStatus(data?.error || 'Could not publish this model. Try again.', 'error');
				els.publishBtn.disabled = false;
				return;
			}
			if (wallet) {
				try {
					localStorage.setItem(WALLET_STORAGE_KEY, wallet);
				} catch {
					/* best-effort */
				}
			}
			const p = data.published;
			if (p.remixable) {
				setPublishStatus(
					p.royaltyPayable
						? `Published — remixable at ${p.royaltyPercent}% royalty. It now appears in the bazaar below.`
						: `Published — remixable at ${p.royaltyPercent}% royalty, but add a wallet above to actually collect it.`,
					'done',
				);
			} else {
				setPublishStatus('Published to your profile — display only, not remixable.', 'done');
			}
			feedLoaded = false; // force a refresh so the new listing shows up
			loadFeed({ reset: true });
		} catch (err) {
			setPublishStatus(err?.message || 'Publishing failed. Check your connection and try again.', 'error');
		} finally {
			els.publishBtn.disabled = false;
		}
	}

	els.publishRoyalty.addEventListener('input', () => {
		els.publishRoyaltyOut.textContent = `${els.publishRoyalty.value}%`;
	});
	els.publishLicense.addEventListener('change', () => {
		const opt = LICENSES.find((l) => l.value === els.publishLicense.value);
		els.publishLicenseHint.textContent = opt?.hint || '';
		const isAllRights = els.publishLicense.value === 'all-rights';
		els.publishRoyaltyRow.hidden = isAllRights;
	});
	els.publishLicense.dispatchEvent(new Event('change'));
	els.publishWallet.value = savedWallet();
	els.publishBtn.addEventListener('click', publish);

	// ── Bazaar (browse + remix) ─────────────────────────────────────────────

	function promptHue(str) {
		let h = 0;
		for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
		return h;
	}

	function cardHTML(item) {
		const hue = promptHue(item.id || item.prompt || '');
		const promptText = item.prompt ? truncate(item.prompt, 90) : 'A remixable 3D model';
		return `
			<article class="remix-card" data-id="${esc(item.id)}">
				<div class="remix-thumb" style="background: linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 70% 14%));">
					${item.isDerived ? '<span class="remix-derived-badge" title="This is itself a remix">remix</span>' : ''}
				</div>
				<p class="remix-prompt" title="${esc(item.prompt || '')}">${esc(promptText)}</p>
				<div class="remix-terms">
					<span class="remix-term" title="Royalty routed to the original creator on remix">${item.royaltyPercent}% royalty</span>
					<span class="remix-term ${item.royaltyPayable ? 'is-payable' : 'is-unpayable'}" title="${item.royaltyPayable ? 'This creator has a payout wallet set' : 'No payout wallet set yet — royalty won’t route'}">
						${item.royaltyPayable ? 'payable' : 'no payout wallet'}
					</span>
				</div>
				<div class="remix-actions">
					<a class="btn btn-ghost btn-sm" href="${esc(item.viewerUrl)}" target="_blank" rel="noopener noreferrer">View</a>
					<button class="btn btn-sm" type="button" data-remix-open="${esc(item.id)}">Remix — $0.25</button>
				</div>
				<div class="remix-inline is-hidden" data-remix-inline="${esc(item.id)}">
					<input type="text" class="remix-inline-input" placeholder='Describe the change, e.g. "make it metallic"' maxlength="500" />
					<button class="btn btn-sm" type="button" data-remix-pay="${esc(item.id)}">Pay &amp; remix</button>
					<div class="remix-inline-status" role="status" aria-live="polite"></div>
				</div>
			</article>
		`;
	}

	function truncate(s, n) {
		const t = String(s || '');
		return t.length > n ? `${t.slice(0, n - 1)}…` : t;
	}

	function renderFeed(append) {
		if (!append) els.feedGrid.innerHTML = '';
		const html = feedItems
			.slice(append ? els.feedGrid.children.length : 0)
			.map(cardHTML)
			.join('');
		els.feedGrid.insertAdjacentHTML('beforeend', html);
		els.feedEmpty.hidden = feedItems.length > 0;
		els.feedMore.hidden = !feedCursor;
	}

	async function loadFeed({ reset = false } = {}) {
		if (feedLoaded && !reset) return;
		els.feedStatus.textContent = 'Loading the remix bazaar…';
		els.feedStatus.dataset.kind = 'busy';
		try {
			const url = feedCursor && !reset ? `/api/remix-feed?before=${encodeURIComponent(feedCursor)}` : '/api/remix-feed';
			const res = await fetch(url, { headers: { accept: 'application/json' } });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || `feed returned ${res.status}`);
			if (!data.enabled) {
				els.feedStatus.textContent = 'The remix bazaar is temporarily unavailable.';
				els.feedStatus.dataset.kind = 'error';
				return;
			}
			feedItems = reset ? data.items || [] : [...feedItems, ...(data.items || [])];
			feedCursor = data.next || null;
			feedLoaded = true;
			renderFeed(!reset);
			els.feedStatus.textContent = '';
			els.feedStatus.dataset.kind = '';
		} catch (err) {
			els.feedStatus.textContent = err?.message || 'Could not load the remix bazaar.';
			els.feedStatus.dataset.kind = 'error';
		}
	}

	els.feedMore.addEventListener('click', () => loadFeed());

	els.feedGrid.addEventListener('click', async (e) => {
		const openId = e.target.closest('[data-remix-open]')?.dataset.remixOpen;
		if (openId) {
			const inline = els.feedGrid.querySelector(`[data-remix-inline="${cssEscape(openId)}"]`);
			inline?.classList.toggle('is-hidden');
			if (!inline?.classList.contains('is-hidden')) inline?.querySelector('input')?.focus();
			return;
		}
		const payId = e.target.closest('[data-remix-pay]')?.dataset.remixPay;
		if (payId) return remixOne(payId, e.target.closest('.remix-card'));
	});

	function cssEscape(s) {
		return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
	}

	async function remixOne(sourceId, cardEl) {
		const inline = cardEl?.querySelector('[data-remix-inline]');
		const input = inline?.querySelector('.remix-inline-input');
		const statusEl = inline?.querySelector('.remix-inline-status');
		const payBtn = cardEl?.querySelector(`[data-remix-pay="${cssEscape(sourceId)}"]`);
		const instruction = input?.value.trim();
		if (!instruction) {
			if (statusEl) statusEl.textContent = 'Describe the change first.';
			return;
		}
		if (payBtn) payBtn.disabled = true;
		if (statusEl) {
			statusEl.textContent = 'Opening the payment window…';
			statusEl.dataset.kind = 'busy';
		}
		try {
			const X402 = await ensureX402();
			const out = await X402.pay({
				endpoint: '/api/x402/remix-asset',
				method: 'POST',
				body: { source_creation_id: sourceId, instruction },
				merchant: 'three.ws Remix Bazaar',
				action: `Remix this model — $0.25 USDC (a royalty routes to its creator)`,
			});
			const result = out?.result;
			if (!result?.ok || !result?.remix?.glbUrl) {
				throw new Error(result?.message || 'Remix did not complete.');
			}
			const sig = out?.payment?.transaction || null;
			const royaltyLine = result.royalty?.paid
				? buildReceiptHTML({
						usdAmount: result.royalty.creatorUsd,
						recipientLabel: 'the original creator',
						explorerUrl: result.royalty.creatorTx ? `https://solscan.io/tx/${result.royalty.creatorTx}` : undefined,
						signature: result.royalty.creatorTx,
					})
				: `<span class="receipt-note">No creator royalty routed (${esc(result.royalty?.reason || 'no payout wallet')}).</span>`;
			if (statusEl) {
				statusEl.innerHTML = `${buildReceiptHTML({ usdAmount: result.fee?.usd, recipientLabel: 'three.ws', explorerUrl: sig ? `https://solscan.io/tx/${sig}` : undefined, signature: sig })}<br>${royaltyLine}`;
				statusEl.dataset.kind = 'done';
			}
			if (input) input.value = '';
			// The remix is a real, new model — show it live and hand it to every
			// other result-panel tool (Iterate, Stylize, Embed, AR…).
			viewerShell?.classList.add('is-loading');
			viewer.style.transition = 'opacity .22s ease';
			viewer.style.opacity = '0.35';
			const restore = () => {
				viewer.style.opacity = '1';
				viewerShell?.classList.remove('is-loading');
			};
			viewer.addEventListener('load', restore, { once: true });
			viewer.addEventListener('error', restore, { once: true });
			viewer.setAttribute('src', result.remix.glbUrl);
			document.dispatchEvent(
				new CustomEvent('forge:model-ready', {
					detail: {
						glbUrl: result.remix.glbUrl,
						label: `Remix: ${instruction}`,
						prompt: result.remix.prompt,
						creationId: result.remix.creationId,
					},
				}),
			);
			resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
		} catch (err) {
			const cancelled = /cancel|dismiss|closed|denied/i.test(String(err?.message || ''));
			if (statusEl) {
				statusEl.textContent = cancelled ? 'Payment cancelled — nothing was charged.' : err?.message || 'Remix failed — no funds moved.';
				statusEl.dataset.kind = cancelled ? '' : 'error';
			}
		} finally {
			if (payBtn) payBtn.disabled = false;
		}
	}

	// ── shared model tracking ───────────────────────────────────────────────

	function onNewSource(detail) {
		const glbUrl = detail?.glbUrl;
		if (!glbUrl) return;
		current = { glbUrl, prompt: detail.prompt || '', creationId: detail.creationId ?? null };
		updatePublishAvailability();
		setPublishStatus('', '');
		els.panel.hidden = false;
		if (!feedLoaded) loadFeed({ reset: true });
	}

	document.addEventListener('forge:model-ready', (e) => onNewSource(e.detail));
	if (viewer.getAttribute('src')) {
		onNewSource({ glbUrl: viewer.getAttribute('src'), prompt: '', creationId: null });
	}

	// ── markup + styles ──────────────────────────────────────────────────────

	function injectPanel() {
		const el = document.createElement('div');
		el.className = 'remix-panel';
		el.id = 'remix-panel';
		el.hidden = true;
		el.innerHTML = `
			<div class="remix-head">
				<h3>Remix economy <span class="remix-badge">Provenance &amp; royalties</span></h3>
				<p class="remix-sub">
					Publish this model so other creators can build on it — a royalty (up to 20%) routes back
					to you on-chain every time it's remixed. Or remix someone else's published model below.
				</p>
			</div>

			<div class="remix-publish" id="remix-publish-section">
				<div class="remix-field">
					<label for="remix-license">License</label>
					<select id="remix-license" class="remix-select">
						${LICENSES.map((l) => `<option value="${l.value}">${esc(l.label)}</option>`).join('')}
					</select>
					<p class="remix-hint" id="remix-license-hint"></p>
				</div>
				<div class="remix-field" id="remix-royalty-row">
					<label for="remix-royalty">Royalty rate <output id="remix-royalty-out">10%</output></label>
					<input type="range" id="remix-royalty" min="0" max="20" step="1" value="10" />
				</div>
				<div class="remix-field">
					<label for="remix-wallet">Payout wallet (Solana, optional)</label>
					<input type="text" id="remix-wallet" class="remix-input" placeholder="Paste your Solana address to actually collect royalties" />
				</div>
				<button class="btn" type="button" id="remix-publish-btn">Publish as remixable</button>
				<div class="remix-status" id="remix-publish-status" role="status" aria-live="polite"></div>
			</div>
			<p class="remix-hint" id="remix-publish-note">Generate or iterate on a model above to publish it here.</p>

			<div class="remix-feed">
				<h4>Browse the bazaar</h4>
				<div class="remix-grid" id="remix-feed-grid"></div>
				<p class="remix-empty" id="remix-feed-empty" hidden>No remixable models published yet — be the first above.</p>
				<div class="remix-feed-status" id="remix-feed-status" role="status" aria-live="polite"></div>
				<button class="btn btn-ghost" type="button" id="remix-feed-more" hidden>Load more</button>
			</div>
		`;
		// After Iterate, before the mesh-cleanup tools (Stylize/Optimize/Refine) —
		// the economy layer sits with the conversational layer, above polish tools.
		const anchor = document.getElementById('iterate-panel') || document.getElementById('stylize-panel');
		if (anchor && anchor.parentElement === resultPanel) anchor.after(el);
		else resultPanel.appendChild(el);
		return {
			panel: el,
			publishSection: el.querySelector('#remix-publish-section'),
			publishNote: el.querySelector('#remix-publish-note'),
			publishLicense: el.querySelector('#remix-license'),
			publishLicenseHint: el.querySelector('#remix-license-hint'),
			publishRoyaltyRow: el.querySelector('#remix-royalty-row'),
			publishRoyalty: el.querySelector('#remix-royalty'),
			publishRoyaltyOut: el.querySelector('#remix-royalty-out'),
			publishWallet: el.querySelector('#remix-wallet'),
			publishBtn: el.querySelector('#remix-publish-btn'),
			publishStatus: el.querySelector('#remix-publish-status'),
			feedGrid: el.querySelector('#remix-feed-grid'),
			feedEmpty: el.querySelector('#remix-feed-empty'),
			feedStatus: el.querySelector('#remix-feed-status'),
			feedMore: el.querySelector('#remix-feed-more'),
		};
	}

	function injectStyles() {
		if (document.getElementById('remix-panel-styles')) return;
		const style = document.createElement('style');
		style.id = 'remix-panel-styles';
		style.textContent = `
			.remix-panel { margin-top: var(--space-lg, 24px); padding-top: var(--space-md, 16px); border-top: 1px solid var(--stroke, rgba(255,255,255,.08)); }
			.remix-head h3 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:0 0 4px; font-family: var(--font-display, inherit); font-size: var(--text-lg, 1.1rem); color: var(--ink, #fff); }
			.remix-badge { font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing:.04em; text-transform:uppercase; color: var(--accent, #7c9cff); background: var(--accent-soft, rgba(124,156,255,.12)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: 999px; padding: 2px 8px; }
			.remix-sub { margin:0 0 var(--space-md,16px); font-size: var(--text-sm, .85rem); color: var(--ink-dim, #9aa); line-height: var(--leading-normal, 1.5); max-width: 64ch; }
			.remix-publish { display:flex; flex-direction:column; gap: var(--space-sm, 10px); padding: var(--space-md,14px); background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-md, 10px); max-width: 480px; }
			.remix-field { display:flex; flex-direction:column; gap: 4px; }
			.remix-field label { font-size: var(--text-xs,.72rem); color: var(--ink-dim,#9aa); display:flex; align-items:center; justify-content:space-between; }
			.remix-select, .remix-input { padding: 8px 10px; background: var(--surface-2, rgba(255,255,255,.05)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-sm, 8px); color: var(--ink,#fff); font-size: var(--text-sm,.85rem); }
			.remix-field input[type=range] { accent-color: var(--accent, #7c9cff); }
			.remix-hint { margin: 0; font-size: var(--text-xs,.7rem); color: var(--ink-dim,#8a8a95); }
			.remix-status { font-size: var(--text-xs,.72rem); min-height: 1.2em; color: var(--ink-dim,#9aa); }
			.remix-status[data-kind="busy"] { color: var(--accent, #7c9cff); }
			.remix-status[data-kind="done"] { color: var(--success, #5fd38a); }
			.remix-status[data-kind="error"] { color: var(--danger, #ff6b6b); }
			.remix-feed { margin-top: var(--space-lg, 20px); }
			.remix-feed h4 { margin: 0 0 var(--space-sm,10px); font-size: var(--text-sm, .95rem); color: var(--ink, #fff); }
			.remix-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-sm, 12px); }
			.remix-card { display:flex; flex-direction:column; gap:6px; padding: var(--space-sm,10px); background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-md, 10px); }
			.remix-thumb { position:relative; aspect-ratio: 4/3; border-radius: var(--radius-sm, 8px); }
			.remix-derived-badge { position:absolute; top:6px; left:6px; font-size:10px; text-transform:uppercase; letter-spacing:.04em; background: rgba(0,0,0,.45); color:#fff; padding: 2px 6px; border-radius: 999px; }
			.remix-prompt { margin:0; font-size: var(--text-xs, .78rem); color: var(--ink, #fff); line-height:1.4; min-height: 2.6em; }
			.remix-terms { display:flex; gap:6px; flex-wrap:wrap; }
			.remix-term { font-size: 10px; padding: 2px 7px; border-radius: 999px; border:1px solid var(--stroke, rgba(255,255,255,.1)); color: var(--ink-dim,#9aa); }
			.remix-term.is-payable { color: var(--success, #5fd38a); border-color: rgba(95,211,138,.3); }
			.remix-term.is-unpayable { color: var(--ink-dim, #8a8a95); }
			.remix-actions { display:flex; gap:6px; }
			.btn-sm { padding: 6px 10px; font-size: var(--text-xs,.78rem); }
			.remix-inline { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
			.remix-inline.is-hidden { display:none; }
			.remix-inline-input { padding: 6px 8px; font-size: var(--text-xs,.78rem); background: var(--surface-2, rgba(255,255,255,.05)); border:1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-sm, 6px); color: var(--ink,#fff); }
			.remix-inline-status { font-size: 10px; color: var(--ink-dim,#9aa); min-height: 1.2em; }
			.remix-inline-status[data-kind="busy"] { color: var(--accent, #7c9cff); }
			.remix-inline-status[data-kind="done"] { color: var(--success, #5fd38a); }
			.remix-inline-status[data-kind="error"] { color: var(--danger, #ff6b6b); }
			.remix-empty { font-size: var(--text-sm,.85rem); color: var(--ink-dim,#9aa); }
			.remix-feed-status { font-size: var(--text-xs,.72rem); color: var(--ink-dim,#9aa); min-height: 1.2em; }
			.remix-feed-status[data-kind="error"] { color: var(--danger, #ff6b6b); }
			.receipt-detail, .receipt-sig { color: var(--accent, #7c9cff); }
			.receipt-note { color: var(--ink-dim, #9aa); }
		`;
		document.head.appendChild(style);
	}
}
