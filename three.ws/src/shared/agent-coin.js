/**
 * Single source of truth for the agent "$coin" affordance.
 *
 * Every agent on three.ws can have exactly one pump.fun coin. This module
 * surfaces that one fact consistently wherever an agent is drawn — a card, a
 * profile, a dashboard row — so the launchpad stops living only inside /studio
 * and becomes a first-class, one-tap action next to the agent itself.
 *
 * Two states, one chip:
 *   - has a coin   → a gold "$SYMBOL" pill linking straight to pump.fun (anyone).
 *   - no coin yet  → an understated "Launch coin" pill, shown only to the owner,
 *                    that opens the existing launch flow (src/pump/launch-token-modal.js).
 *
 * The launch pill is deliberately low-emphasis (muted until hover): present
 * everywhere, but never shouting — visible enough to discover, quiet enough not
 * to clutter a wall of agents. The coin detail/launch logic lives here once;
 * callers just drop in `coinChipHTML(agent)` (string sites) or `coinChipEl(agent)`
 * (element sites), exactly like the on-chain badge.
 *
 * Detection piggybacks on getOnchainStatus() (the on-chain badge normalizer) and
 * additionally accepts the dashboard's `meta.pumpfun.mint` shape.
 */

import { getOnchainStatus } from './onchain-badge.js';

const STYLE_ID = 'tws-agent-coin-styles';

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function pumpfunUrl(mint, cluster) {
	if (!mint) return null;
	if (cluster === 'devnet') return `https://explorer.solana.com/address/${mint}?cluster=devnet`;
	return `https://pump.fun/coin/${mint}`;
}

/**
 * Normalize any agent record into a coin descriptor, or null when it has no coin.
 * @returns {null | { mint: string, symbol: string|null, cluster: 'mainnet'|'devnet', url: string|null }}
 */
export function getCoinStatus(agent) {
	if (!agent || typeof agent !== 'object') return null;

	// Prefer the canonical on-chain normalizer — it already resolves the pump.fun
	// token across every surfaced shape (onchain block, token block, meta.token).
	const status = getOnchainStatus(agent);
	if (status && status.isToken && status.address) {
		const cluster = status.cluster === 'devnet' ? 'devnet' : 'mainnet';
		return {
			mint: status.address,
			symbol: status.tokenSymbol || null,
			cluster,
			// The canonical rich coin page (conviction + live market + trades) on
			// mainnet; devnet has no such page.
			pageUrl: cluster === 'mainnet' ? oraclePageUrl(status.address) : null,
			// Prefer the pump.fun coin page on mainnet — this is a launchpad, not a
			// block explorer. Fall back to the explorer only when there's no better link.
			url: status.pumpfunUrl || pumpfunUrl(status.address, cluster) || status.explorerUrl,
		};
	}

	// Dashboard / older shapes the badge normalizer doesn't reach: meta.pumpfun.
	const token = agent.token || agent.meta?.token || agent.meta?.pumpfun || null;
	const mint = token?.mint || token?.contract_address || token?.ca || null;
	if (mint) {
		const cluster = token.cluster === 'devnet' ? 'devnet' : 'mainnet';
		return {
			mint,
			symbol: token.symbol || token.name || null,
			cluster,
			pageUrl: cluster === 'mainnet' ? oraclePageUrl(mint) : null,
			url: token.pumpfun_url || pumpfunUrl(mint, cluster),
		};
	}

	return null;
}

// The canonical three.ws rich coin page for a mint.
function oraclePageUrl(mint) {
	return mint ? `/oracle/coin/${mint}` : null;
}

/** True when the agent already has a coin. */
export function hasCoin(agent) {
	return getCoinStatus(agent) != null;
}

/**
 * True when the viewer can launch this agent's coin: it has no coin yet and the
 * viewer owns it. Ownership is read from the record (`is_owner`/`isOwner`) or
 * forced by the caller via `opts.owner` on surfaces that only ever render the
 * owner's own agents (e.g. the dashboard).
 */
export function canLaunchCoin(agent, opts = {}) {
	if (!agent || getCoinStatus(agent)) return false;
	if (opts.owner === true) return true;
	return agent.is_owner === true || agent.isOwner === true;
}

// ── Single launch entry point ───────────────────────────────────────────────
// One place builds the launch context (image, needsDeploy, deploy fields) and
// opens the existing modal. Card chips and the agent-detail panel both call it,
// so the launchpad behaves identically no matter where it's triggered from.

/**
 * Open the pump.fun launch flow for an agent record (any surfaced shape).
 * @param {object} agent
 */
export async function openCoinLaunch(agent) {
	if (!agent) return;
	const rec = agent.rawMetadata || agent;
	const id = agent.id || rec.id || agent.agent_id || rec.agent_id;
	if (!id) return;

	// First-timers crossing the on-chain threshold get the plain-language
	// explainer + wallet setup before the launch modal. Returning/ready users
	// pass straight through (the primer resolves instantly). Loaded lazily so a
	// wall of coin chips never pays for the wizard's deps until one is clicked.
	const { ensureOnchainPrimer } = await import('./onchain-primer.js');
	if (!(await ensureOnchainPrimer({ action: 'launch-token' }))) return;

	const onchain = rec.onchain || rec.meta?.onchain || agent.onchain || null;
	const needsDeploy = !onchain || onchain.family !== 'solana';
	const name = rec.name || agent.name || 'Agent';
	const imageUrl =
		rec.avatar_thumbnail_url ||
		rec.meta?.thumbnail_url ||
		agent.thumbnail_url ||
		agent.avatar ||
		agent.image ||
		'';

	const { openLaunchTokenModal } = await import('/src/pump/launch-token-modal.js');
	openLaunchTokenModal({
		agentId: id,
		agentName: name,
		imageUrl,
		needsDeploy,
		agentForDeploy: needsDeploy
			? {
					id,
					name,
					description: rec.description || agent.description || '',
					avatar_id: rec.avatar_id || agent.avatar_id || null,
					skills: rec.skills || agent.skills || undefined,
				}
			: null,
	});
}

// ── Delegated launch handler ────────────────────────────────────────────────
// String-render sites (innerHTML) can't attach listeners, so the launch pill is
// a plain `[data-tws-coin-launch]` button and one capture-phase document listener
// drives it. Capture phase + stopPropagation means clicking the pill never
// triggers the surrounding card's navigation.

const _launchCtx = new Map();
let _delegated = false;

function _ensureDelegate() {
	if (_delegated || typeof document === 'undefined') return;
	_delegated = true;
	document.addEventListener(
		'click',
		(e) => {
			const btn = e.target?.closest?.('[data-tws-coin-launch]');
			if (!btn) return;
			e.preventDefault();
			e.stopPropagation();
			if (btn.disabled) return;
			const id = btn.getAttribute('data-tws-coin-launch');
			const agent = _launchCtx.get(String(id)) || { id };
			btn.disabled = true;
			Promise.resolve(openCoinLaunch(agent)).finally(() => {
				btn.disabled = false;
			});
		},
		true,
	);
}

function _registerLaunchCtx(id, agent) {
	if (!id) return;
	_launchCtx.set(String(id), agent);
	_ensureDelegate();
}

/** Inject the shared coin stylesheet once. Idempotent and SSR-safe. */
export function ensureCoinStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.tws-coin{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;
	font:600 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.01em;
	white-space:nowrap;vertical-align:middle;text-decoration:none;cursor:pointer;
	border:1px solid transparent;background:transparent;font-family:inherit;
	transition:background .15s ease,border-color .15s ease,transform .15s ease,color .15s ease;}
.tws-coin-glyph{flex:none;font-size:12px;line-height:1;}
.tws-coin-label{overflow:hidden;text-overflow:ellipsis;}
.tws-coin--md{padding:4px 11px;font-size:12px;gap:7px;}
.tws-coin--md .tws-coin-glyph{font-size:13px;}
/* Live coin — a real, tradable thing: gold, confident, links to pump.fun. */
.tws-coin--live{color:#eab308;background:rgba(234,179,8,.12);border-color:rgba(234,179,8,.34);}
a.tws-coin--live:hover{background:rgba(234,179,8,.2);border-color:rgba(234,179,8,.6);transform:translateY(-1px);}
a.tws-coin--live:active{transform:translateY(0);}
.tws-coin--live:focus-visible{outline:2px solid rgba(234,179,8,.7);outline-offset:2px;}
/* Launch action — understated by default so a wall of agents never reads as a
   wall of buttons. Reveals its gold identity only on hover/focus. */
.tws-coin--launch{color:rgba(235,236,240,.5);background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.13);}
.tws-coin--launch .tws-coin-glyph{font-weight:700;}
.tws-coin--launch:hover{color:#eab308;background:rgba(234,179,8,.12);border-color:rgba(234,179,8,.42);transform:translateY(-1px);}
.tws-coin--launch:active{transform:translateY(0);}
.tws-coin--launch:focus-visible{outline:2px solid rgba(234,179,8,.6);outline-offset:2px;}
.tws-coin--launch:disabled{opacity:.55;cursor:progress;transform:none;}
@media (prefers-reduced-motion: reduce){.tws-coin{transition:none;}}
`;
	(document.head || document.documentElement).appendChild(style);
}

/**
 * Render the coin chip as an HTML string. Returns '' when there's nothing to show
 * (no coin and the viewer can't launch one).
 *
 * @param {object} agent
 * @param {object} [opts]
 * @param {'sm'|'md'} [opts.size='sm']
 * @param {boolean} [opts.owner=false]  Force owner context (owner-only surfaces).
 * @param {boolean} [opts.link=true]   Link the live coin to pump.fun. Pass false
 *   inside a fully-clickable card so the chip is a plain (non-anchor) indicator.
 * @param {boolean} [opts.launchable=true]  Render the owner "Launch coin" pill.
 *   Pass false on a surface that already has its own launch control, so the chip
 *   stays a pure coin indicator and never duplicates the launch entry point.
 * @param {string} [opts.launchLabel='Launch coin']
 */
export function coinChipHTML(agent, opts = {}) {
	const { size = 'sm', owner = false, link = true, launchable = true, launchLabel = 'Launch coin' } = opts;
	const sz = size === 'md' ? ' tws-coin--md' : '';
	const coin = getCoinStatus(agent);

	if (coin) {
		ensureCoinStyles();
		const sym = coin.symbol ? `$${esc(coin.symbol)}` : 'Coin';
		const inner = `<span class="tws-coin-glyph" aria-hidden="true">◎</span><span class="tws-coin-label">${sym}</span>`;
		// Prefer the internal rich coin page (conviction + market + live trades) —
		// it links out to pump.fun to trade. Fall back to the external link (devnet).
		const href = coin.pageUrl || coin.url;
		const internal = Boolean(coin.pageUrl);
		const aria = internal
			? `View ${coin.symbol ? coin.symbol + ' ' : ''}coin — conviction, market & live trades`
			: `Trade ${coin.symbol ? coin.symbol + ' ' : ''}coin on pump.fun`;
		if (link && href) {
			const tgt = internal ? '' : ' target="_blank" rel="noopener noreferrer"';
			return `<a class="tws-coin tws-coin--live${sz}" href="${esc(href)}"${tgt} title="${esc(aria)}" aria-label="${esc(aria)}">${inner}</a>`;
		}
		return `<span class="tws-coin tws-coin--live${sz}" role="img" aria-label="${esc(aria)}">${inner}</span>`;
	}

	if (!launchable || !canLaunchCoin(agent, { owner })) return '';
	ensureCoinStyles();
	const id = agent?.id || agent?.rawMetadata?.id || '';
	if (!id) return '';
	_registerLaunchCtx(id, agent);
	return `<button type="button" class="tws-coin tws-coin--launch${sz}" data-tws-coin-launch="${esc(id)}" title="Launch this agent's coin on pump.fun" aria-label="Launch this agent's coin on pump.fun"><span class="tws-coin-glyph" aria-hidden="true">＋</span><span class="tws-coin-label">${esc(launchLabel)}</span></button>`;
}

/**
 * Render the coin chip as a DOM node, or null when there's nothing to show.
 * Launch buttons are driven by the shared delegated listener; coin links get a
 * local stopPropagation so they don't trigger an enclosing clickable card.
 */
export function coinChipEl(agent, opts = {}) {
	const html = coinChipHTML(agent, opts);
	if (!html) return null;
	const tpl = document.createElement('template');
	tpl.innerHTML = html.trim();
	const node = tpl.content.firstElementChild;
	if (node && node.tagName === 'A') {
		node.addEventListener('click', (e) => e.stopPropagation());
	}
	return node;
}

if (typeof window !== 'undefined') {
	window.twsAgentCoin = {
		getCoinStatus,
		hasCoin,
		canLaunchCoin,
		openCoinLaunch,
		coinChipHTML,
		coinChipEl,
		ensureCoinStyles,
	};
}
