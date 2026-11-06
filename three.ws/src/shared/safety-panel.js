/**
 * Safety panel — the reusable, accessible pre-trade firewall verdict.
 *
 * Renders the rug/honeypot firewall's verdict for a coin (allow / warn / block),
 * a 0–100 safety score, and each on-chain check with a pass/warn/fail dot and a
 * plain-language explanation. Shown BEFORE the buy button everywhere a buy can
 * start. The host disables its buy on a `block` verdict and may allow an explicit
 * override only on `warn`.
 *
 * Two ways to use it:
 *   const panel = createSafetyPanel({ onVerdict });  // a controller
 *   panel.el                                          // the root element to mount
 *   panel.loadForMint({ mint, network, amountSol });  // fetch + render the verdict
 *   panel.setState('idle' | 'loading');               // explicit empty/loading
 *   panel.applyVerdict(verdictObject);                // render a verdict you already have
 *
 * Every state is designed: idle (no coin yet), loading (skeleton), error
 * (actionable retry), and populated (allow/warn/block). Uses the platform design
 * tokens (CSS vars) with sane fallbacks, so it themes correctly inside the wallet
 * hub and the in-world coin-buy modal alike.
 *
 * $THREE is the only coin three.ws promotes — this panel assesses whatever runtime
 * mint the host hands it and never names or recommends any token.
 */

const STYLE_ID = 'tw-safety-style';
const STYLE = `
.tw-safety { border: 1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-md, 10px); background: var(--surface-1, rgba(255,255,255,.03)); padding: 12px 13px; display: flex; flex-direction: column; gap: 10px; font-size: var(--text-sm, .8125rem); animation: tw-safety-in var(--duration-base, 220ms) var(--ease-out, ease); }
@keyframes tw-safety-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .tw-safety, .tw-safety-skel { animation: none !important; } }
.tw-safety-head { display: flex; align-items: center; gap: 9px; }
.tw-safety-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 0 transparent; }
.tw-safety--allow .tw-safety-dot { background: var(--success, #4ade80); box-shadow: 0 0 7px color-mix(in srgb, var(--success,#4ade80) 60%, transparent); }
.tw-safety--warn .tw-safety-dot { background: var(--warn, #fbbf24); box-shadow: 0 0 7px color-mix(in srgb, var(--warn,#fbbf24) 60%, transparent); }
.tw-safety--block .tw-safety-dot { background: var(--danger, #f87171); box-shadow: 0 0 7px color-mix(in srgb, var(--danger,#f87171) 60%, transparent); }
.tw-safety--allow { border-color: color-mix(in srgb, var(--success,#4ade80) 32%, transparent); }
.tw-safety--warn { border-color: color-mix(in srgb, var(--warn,#fbbf24) 36%, transparent); }
.tw-safety--block { border-color: color-mix(in srgb, var(--danger,#f87171) 42%, transparent); background: color-mix(in srgb, var(--danger,#f87171) 7%, transparent); }
.tw-safety-title { font-weight: 600; color: var(--ink-bright, #fff); }
.tw-safety--allow .tw-safety-title { color: var(--success, #4ade80); }
.tw-safety--warn .tw-safety-title { color: var(--warn, #fbbf24); }
.tw-safety--block .tw-safety-title { color: var(--danger, #f87171); }
.tw-safety-score { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink, #e8e8e8); }
.tw-safety-score small { color: var(--ink-dim, #888); font-weight: 400; }
.tw-safety-info { appearance: none; border: none; background: none; cursor: help; color: var(--ink-dim, #888); padding: 0 2px; font-size: .85em; line-height: 1; }
.tw-safety-info:hover, .tw-safety-info:focus-visible { color: var(--ink, #e8e8e8); }
.tw-safety-reasons { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.tw-safety-reasons li { color: var(--ink, #e8e8e8); line-height: 1.4; display: flex; gap: 7px; }
.tw-safety-reasons li::before { content: ""; flex: none; margin-top: .5em; width: 4px; height: 4px; border-radius: 50%; background: var(--ink-dim, #888); }
.tw-safety-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.tw-safety-check { display: flex; align-items: center; gap: 8px; color: var(--ink-dim, #999); font-size: var(--text-2xs, .72rem); }
.tw-safety-check b { font-weight: 600; color: var(--ink, #e8e8e8); }
.tw-safety-cdot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.tw-safety-cdot--pass { background: var(--success, #4ade80); }
.tw-safety-cdot--warn { background: var(--warn, #fbbf24); }
.tw-safety-cdot--fail { background: var(--danger, #f87171); }
.tw-safety-cdot--skip { background: var(--ink-faint, #555); }
.tw-safety-toggle { appearance: none; border: none; background: none; color: var(--ink-dim, #888); cursor: pointer; font: inherit; font-size: var(--text-2xs, .72rem); padding: 2px 0; text-align: left; text-decoration: underline; text-underline-offset: 2px; }
.tw-safety-toggle:hover, .tw-safety-toggle:focus-visible { color: var(--ink, #e8e8e8); }
.tw-safety-degraded { font-size: var(--text-2xs, .72rem); color: var(--warn, #fbbf24); }
.tw-safety-skel { height: 12px; border-radius: 5px; background: var(--surface-2, rgba(255,255,255,.06)); animation: tw-safety-skel 1.3s ease-in-out infinite; }
.tw-safety-skel:nth-child(2) { width: 80%; } .tw-safety-skel:nth-child(3) { width: 60%; }
@keyframes tw-safety-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
.tw-safety-err { color: var(--danger, #f87171); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tw-safety-err button { appearance: none; border: 1px solid currentColor; background: none; color: inherit; font: inherit; font-size: var(--text-2xs,.72rem); border-radius: var(--radius-sm,6px); padding: 2px 9px; cursor: pointer; }
.tw-safety-idle { color: var(--ink-dim, #888); font-size: var(--text-sm, .8125rem); }
`;

const CHECK_LABEL = {
	mint_authority: 'Mint & freeze authority',
	venue: 'Tradable market',
	round_trip: 'Buy→sell round-trip',
	concentration: 'Holder concentration',
	price_impact: 'Price impact',
	input: 'Coin address',
};

const CHECK_TEXT = {
	authorities_renounced: 'Mint & freeze authority are renounced — supply is fixed and your tokens can’t be frozen.',
	mint_authority_active: 'The mint authority is still active — the creator can inflate supply.',
	freeze_authority_active: 'The freeze authority is set — the creator could freeze your tokens so you can’t sell.',
	live_bonding_curve: 'Live on the pump.fun bonding curve with real reserves.',
	live_amm_pool: 'Live on the PumpSwap AMM pool with real liquidity.',
	no_tradable_venue: 'No bonding curve or AMM pool with real liquidity — there’s nowhere to sell.',
	curve_reserves_empty: 'The bonding curve has no real reserves.',
	pool_reserves_empty: 'The AMM pool has no real liquidity.',
	roundtrip_simulated_ok: 'A simulated buy→sell round-trip succeeded — you can sell back out.',
	roundtrip_reverted: 'A simulated buy→sell round-trip reverted — this behaves like a honeypot.',
	sell_returns_nothing: 'The simulated sell returns nothing — there’s no working exit.',
	buy_yields_nothing: 'This amount buys zero tokens — too small or reserves exhausted.',
	simulation_unavailable: 'The round-trip simulation couldn’t run (RPC unavailable) — not fully verified.',
	simulation_not_applicable: 'Round-trip simulation doesn’t apply to this coin’s stage.',
	no_payer_for_simulation: 'A round-trip simulation needs a connected wallet to model — authority & venue still checked.',
	no_quote_amount: 'Enter an amount to run the round-trip simulation.',
	structure_clean: 'Holder structure looks healthy — no extreme concentration or dev dump.',
	impact_ok: 'Price impact is within a normal range for this size.',
	high_price_impact: 'Price impact is high for this size — you may receive far less than market.',
	impact_unknown: 'Price impact could not be computed for this size.',
	no_intel_yet: 'Structural intel is still being gathered for this new coin.',
	intel_unavailable: 'Structural intel is unavailable right now.',
};

const WHAT_THIS_MEANS =
	'Before you buy, three.ws runs a real on-chain check: it audits the coin’s mint and freeze authorities and simulates an actual buy→sell round-trip to confirm you could sell back out. “Block” means a critical check failed (you likely can’t sell). “Caution” means something is risky but tradable. “Clear” means the checks passed.';

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

function checkText(c) {
	return CHECK_TEXT[c.reason] || c.reason;
}
function checkLabel(c) {
	return CHECK_LABEL[c.name] || c.name;
}

/**
 * Create a Safety panel controller.
 * @param {object} [opts]
 * @param {(verdict: {verdict:string,score:number,reasons:string[],checks:any[],simulated:boolean}|null) => void} [opts.onVerdict]
 *   Called whenever the verdict changes (or null when reset) so the host can
 *   enable/disable its buy button.
 * @param {boolean} [opts.startExpanded] show the per-check breakdown by default.
 */
export function createSafetyPanel({ onVerdict = () => {}, startExpanded = false } = {}) {
	injectStyle();
	const root = document.createElement('div');
	root.className = 'tw-safety';
	root.setAttribute('role', 'region');
	root.setAttribute('aria-label', 'Trade safety check');

	let expanded = startExpanded;
	let lastReq = 0;
	let current = null; // last verdict object
	let lastArgs = null; // { mint, network, amountSol } for retry

	function setIdle(message) {
		current = null;
		root.className = 'tw-safety';
		root.innerHTML = `<div class="tw-safety-idle">${escapeHtml(message || 'Enter a coin to run the safety check.')}</div>`;
		onVerdict(null);
	}

	function setLoading() {
		root.className = 'tw-safety';
		root.setAttribute('aria-busy', 'true');
		root.innerHTML = `
			<div class="tw-safety-head"><span class="tw-safety-dot" style="background:var(--ink-faint,#555)"></span><span class="tw-safety-title">Running safety check…</span></div>
			<div class="tw-safety-skel"></div><div class="tw-safety-skel"></div><div class="tw-safety-skel"></div>`;
	}

	function setError(retryFn) {
		root.removeAttribute('aria-busy');
		root.className = 'tw-safety';
		root.innerHTML = '';
		const wrap = document.createElement('div');
		wrap.className = 'tw-safety-err';
		wrap.setAttribute('role', 'alert');
		wrap.append(document.createTextNode('Couldn’t run the safety check.'));
		if (retryFn) {
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = 'Retry';
			b.addEventListener('click', retryFn);
			wrap.appendChild(b);
		}
		root.appendChild(wrap);
		onVerdict(null);
	}

	function applyVerdict(v) {
		if (!v || typeof v.verdict !== 'string') { setIdle(); return; }
		current = v;
		root.removeAttribute('aria-busy');
		const verdict = v.verdict === 'block' ? 'block' : v.verdict === 'warn' ? 'warn' : 'allow';
		root.className = `tw-safety tw-safety--${verdict}`;
		const title = verdict === 'block' ? 'Blocked — likely unsafe to buy'
			: verdict === 'warn' ? 'Caution — tradable but risky'
				: 'Clear — safe to trade';
		const score = Number.isFinite(Number(v.score)) ? Math.round(Number(v.score)) : null;
		const reasons = Array.isArray(v.reasons) ? v.reasons : [];
		const checks = Array.isArray(v.checks) ? v.checks.filter((c) => c && c.name !== 'input') : [];
		const degraded = !v.simulated && checks.some((c) => c.reason === 'simulation_unavailable');

		root.innerHTML = `
			<div class="tw-safety-head">
				<span class="tw-safety-dot" aria-hidden="true"></span>
				<span class="tw-safety-title">${escapeHtml(title)}</span>
				<button type="button" class="tw-safety-info" aria-label="What this means" title="${escapeHtml(WHAT_THIS_MEANS)}">ⓘ</button>
				${score != null ? `<span class="tw-safety-score">${score}<small>/100</small></span>` : ''}
			</div>
			${reasons.length ? `<ul class="tw-safety-reasons">${reasons.slice(0, 4).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
			${degraded ? `<div class="tw-safety-degraded">⚠ Some checks couldn’t complete — verify on-chain before a large buy.</div>` : ''}
			${checks.length ? `<button type="button" class="tw-safety-toggle" aria-expanded="${expanded}">${expanded ? 'Hide' : 'Show'} ${checks.length} checks</button>` : ''}
			<ul class="tw-safety-checks" ${expanded ? '' : 'hidden'}>
				${checks.map((c) => {
					const st = c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : c.status === 'warn' ? 'warn' : 'skip';
					return `<li class="tw-safety-check"><span class="tw-safety-cdot tw-safety-cdot--${st}" aria-hidden="true"></span><b>${escapeHtml(checkLabel(c))}:</b> ${escapeHtml(checkText(c))}</li>`;
				}).join('')}
			</ul>`;

		const toggle = root.querySelector('.tw-safety-toggle');
		if (toggle) {
			toggle.addEventListener('click', () => {
				expanded = !expanded;
				const list = root.querySelector('.tw-safety-checks');
				if (list) list.hidden = !expanded;
				toggle.textContent = `${expanded ? 'Hide' : 'Show'} ${checks.length} checks`;
				toggle.setAttribute('aria-expanded', String(expanded));
			});
		}
		onVerdict(v);
	}

	/**
	 * Fetch the verdict for a mint from the public firewall API and render it.
	 * @param {{ mint: string, network?: string, amountSol?: number }} args
	 */
	async function loadForMint(args) {
		lastArgs = args;
		const mint = args?.mint;
		if (!mint) { setIdle(); return; }
		const seq = ++lastReq;
		setLoading();
		try {
			const u = new URLSearchParams({ mint, network: args.network || 'mainnet' });
			if (args.amountSol > 0) u.set('amount', String(args.amountSol));
			const r = await fetch(`/api/pump/safety?${u.toString()}`, { headers: { accept: 'application/json' } });
			if (seq !== lastReq) return;
			if (!r.ok) { setError(() => loadForMint(lastArgs)); return; }
			const data = await r.json();
			if (seq !== lastReq) return;
			applyVerdict(data);
		} catch {
			if (seq !== lastReq) return;
			setError(() => loadForMint(lastArgs));
		}
	}

	function setState(s) {
		if (s === 'idle') setIdle();
		else if (s === 'loading') setLoading();
	}

	setIdle();

	return {
		el: root,
		loadForMint,
		applyVerdict,
		setState,
		getVerdict: () => current,
		destroy() { lastReq = -1; root.remove(); },
	};
}

// Minimal HTML escape — the panel never injects untrusted markup.
function escapeHtml(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
