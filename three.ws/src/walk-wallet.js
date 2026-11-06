/**
 * In-world wallet reveal for the walk / play 3D world.
 *
 * The wallet is the agent's identity, so it must follow the agent's face even
 * here, in a live multiplayer render loop. Walk up to another player who is
 * piloting a real agent and that agent's wallet rises beside its nameplate — its
 * vanity-aware address, live value, lifetime tips, and a one-tap Tip. Meeting an
 * agent in the world and paying it on the spot is the moment; this is the part of
 * the wallet layer that only three.ws can do, because only here is a funded,
 * self-custodial wallet welded to a walking, ownable avatar.
 *
 * Performance is the whole game in a render loop, so this is deliberately frugal:
 *   • Only ONE wallet is ever revealed — the single nearest in-range agent — so
 *     a crowded plaza never triggers N balance reads.
 *   • Proximity is scanned on a throttle (not every frame); only the active
 *     card's screen anchor updates per frame, and that is a single read of the
 *     nameplate the renderer already positions.
 *   • Embed cards are fetched once per agent from the public CORS:* endpoint and
 *     cached, so re-approaching someone you already met costs nothing.
 *   • Hysteresis (reveal near, release a little farther) stops the card from
 *     flickering when you hover at the edge of range.
 *
 * Everything shown is real: the card is the same public wallet-embed the chip,
 * the IRL card, and the off-site embed all read, so a number never disagrees
 * across surfaces. It is the visitor view by construction (Tip + open on
 * three.ws) — no owner control is reachable from another player's wallet.
 */

import { mountPortableWallet } from './shared/portable-wallet.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Metres in world space. Reveal when you get close; only release once you step
// meaningfully away so the card is stable while you stand and read/tip.
const REVEAL_RANGE = 5;
const RELEASE_RANGE = 7.5;
const SCAN_MS = 220; // proximity re-scan cadence (not per-frame)

const STYLE_ID = 'walk-wallet-reveal-styles';

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.walk-wallet-reveal{position:fixed;top:0;left:0;z-index:5;transform:translate(-50%,0);
	pointer-events:auto;will-change:transform;filter:drop-shadow(0 10px 30px rgba(0,0,0,.5));
	opacity:0;transition:opacity .18s ease;}
.walk-wallet-reveal[data-show="1"]{opacity:1;}
.walk-wallet-reveal[hidden]{display:none;}
.walk-remote-label.is-wallet{border-color:var(--wallet-stroke-strong,rgba(139,92,246,.55));
	box-shadow:0 0 0 1px rgba(139,92,246,.35),0 4px 18px rgba(139,92,246,.25);color:#fff;}
body.is-zen .walk-wallet-reveal{display:none !important;}
@media (prefers-reduced-motion: reduce){.walk-wallet-reveal{transition:none;}}
`;
	document.head.appendChild(s);
}

/** Horizontal (ground-plane) distance between two THREE vectors. */
function groundDist(a, b) {
	const dx = a.x - b.x;
	const dz = a.z - b.z;
	return Math.hypot(dx, dz);
}

/**
 * @param {object} cfg
 * @param {() => {x:number,y:number,z:number}} cfg.getLocalPosition  Local avatar world position.
 * @param {Map<string, any>} cfg.remotePlayers  sessionId → RemotePlayer (has .rig, .agent, .label).
 * @param {'mainnet'|'devnet'} [cfg.network]
 * @returns {{ update: (nowMs:number) => void, destroy: () => void }}
 */
export function createWalkWalletProximity({ getLocalPosition, remotePlayers, network = 'mainnet' }) {
	ensureStyles();

	const overlay = document.createElement('div');
	overlay.className = 'walk-wallet-reveal';
	overlay.hidden = true;
	document.body.appendChild(overlay);

	const cardCache = new Map(); // agentId → Promise<card|null>  (dedupes + caches reads)
	let mount = null; // active mountPortableWallet handle
	let activeAgentId = null;
	let activePlayer = null; // RemotePlayer we are anchored to
	let swapToken = 0;
	let lastScan = 0;
	let destroyed = false;

	function fetchCard(agentId) {
		if (cardCache.has(agentId)) return cardCache.get(agentId);
		const p = fetch(`/api/agents/wallet-embed?id=${encodeURIComponent(agentId)}&network=${encodeURIComponent(network)}`, {
			headers: { accept: 'application/json' },
		})
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => j?.data || null)
			.catch(() => null);
		cardCache.set(agentId, p);
		return p;
	}

	function agentOf(player) {
		const a = player?.agent;
		return a && UUID_RE.test(String(a)) ? String(a) : null;
	}

	function teardown() {
		if (mount) {
			try { mount.destroy(); } catch { /* already gone */ }
			mount = null;
		}
		if (activePlayer?.label) activePlayer.label.classList.remove('is-wallet');
		activePlayer = null;
		activeAgentId = null;
		overlay.hidden = true;
		overlay.removeAttribute('data-show');
		overlay.innerHTML = '';
	}

	async function revealFor(player, agentId) {
		const token = ++swapToken;
		// Tear down the previous card immediately so two never overlap mid-swap.
		if (mount) { try { mount.destroy(); } catch { /* gone */ } mount = null; }
		if (activePlayer?.label) activePlayer.label.classList.remove('is-wallet');
		overlay.innerHTML = '';
		activePlayer = player;
		activeAgentId = agentId;
		player.label?.classList.add('is-wallet');
		overlay.hidden = false;

		const card = await fetchCard(agentId);
		// Player may have moved out of range (or another won the slot) while the
		// card loaded — honor the latest decision.
		if (destroyed || token !== swapToken) return;
		mount = mountPortableWallet(overlay, {
			agentId,
			network,
			variant: 'card', // open by construction — an inviting in-world card
			tip: true,
			qr: true,
			share: true,
			seedCard: card || undefined,
			name: card?.name || player.label?.textContent || undefined,
		});
		overlay.setAttribute('data-show', '1');
	}

	function pickNearest(local) {
		let best = null;
		let bestD = Infinity;
		for (const p of remotePlayers.values()) {
			if (!p?.rig) continue;
			if (!agentOf(p)) continue;
			const d = groundDist(local, p.rig.position);
			if (d < bestD) { bestD = d; best = p; }
		}
		return { best, bestD };
	}

	function position() {
		if (!activePlayer || overlay.hidden) return;
		const label = activePlayer.label;
		// Anchor under the nameplate the renderer already places. If the player is
		// off-screen (label hidden) or hidden by zen mode, hide the card too.
		if (!label || label.style.display === 'none') {
			overlay.removeAttribute('data-show');
			return;
		}
		const r = label.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) {
			overlay.removeAttribute('data-show');
			return;
		}
		let left = r.left + r.width / 2;
		let top = r.bottom + 8;
		const ow = overlay.offsetWidth || 264;
		const oh = overlay.offsetHeight || 120;
		// Keep the card on screen on small viewports / near edges.
		const half = ow / 2;
		if (left - half < 8) left = half + 8;
		if (left + half > window.innerWidth - 8) left = window.innerWidth - half - 8;
		if (top + oh > window.innerHeight - 8) top = Math.max(8, r.top - oh - 8);
		overlay.style.transform = `translate(-50%,0) translate(${Math.round(left)}px,${Math.round(top)}px)`;
		overlay.setAttribute('data-show', '1');
	}

	function update(now) {
		if (destroyed) return;
		const local = getLocalPosition?.();
		if (!local) { if (activePlayer) teardown(); return; }

		if (now - lastScan >= SCAN_MS) {
			lastScan = now;

			// The active player left the world or stopped piloting an agent.
			if (activePlayer && (!remotePlayers.has(activePlayer.sessionId) || !agentOf(activePlayer) || !activePlayer.rig)) {
				teardown();
			}

			const { best, bestD } = pickNearest(local);

			if (activePlayer) {
				// Keep the current card until the player steps past the release ring,
				// unless they vanished above.
				const stillActive = remotePlayers.has(activePlayer.sessionId) && activePlayer.rig;
				const d = stillActive ? groundDist(local, activePlayer.rig.position) : Infinity;
				if (d > RELEASE_RANGE) {
					teardown();
					if (best && bestD <= REVEAL_RANGE) revealFor(best, agentOf(best));
				} else if (best && best !== activePlayer && bestD <= REVEAL_RANGE && bestD < d - 1.5) {
					// A clearly-closer agent supersedes the current one (1.5m margin
					// avoids thrashing between two near-equidistant players).
					revealFor(best, agentOf(best));
				}
			} else if (best && bestD <= REVEAL_RANGE) {
				revealFor(best, agentOf(best));
			}
		}

		// Cheap per-frame anchor update for the one active card.
		position();
	}

	return {
		update,
		destroy() {
			destroyed = true;
			teardown();
			overlay.remove();
		},
	};
}
