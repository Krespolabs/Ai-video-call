// Click-to-walk navigation for the corner companion (Task 35).
// ============================================================
// Point at an empty patch of the page and the companion avatar walks there —
// gliding along a smooth, obstacle-aware path, easing into its arrival, and
// turning to face the direction it travels. A faint dotted route and a ripple
// at the destination make the intent legible; a footprint trail fades behind.
//
// WHY this shape (and not "rooted corner avatar"):
// The SDK companion (walk-sdk/src/companion.js) is a fixed-corner WebGL canvas
// whose avatar walks *in place* and only rotates to follow the cursor — it never
// translates across the document. We never edit the SDK (same rule the trails &
// transitions siblings follow). So "walk to a point" is realised by translating
// the companion's *host element* across the viewport with a CSS transform, while
// driving the live controller's walk/idle state and yaw so the rig animates and
// faces its heading. When the avatar arrives it settles back to idle; the host
// keeps its new spot until the next destination or a viewport resize re-anchors.
//
// ACTIVATION RULE (deliberately non-hijacking — see report):
//   · Fine pointer (mouse/trackpad): a plain primary-button click on *empty
//     space* — i.e. the event target is not, and is not inside, an interactive
//     or blocking element — with no modifier keys. Clicks on links, buttons,
//     inputs, [role=button], [contenteditable], labels, summaries, scrollbars,
//     the companion itself, or any [data-walk-block] are left 100% to the page.
//   · Coarse pointer (touch): a *long-press* (≥550ms, finger held still) on
//     empty space. Taps, scrolls and flings are never disturbed.
// We listen in the capture phase but NEVER call preventDefault on an eligible
// real interaction — empty-space clicks have no default to suppress, so normal
// link/button behaviour is provably untouched.
//
// SETTING: a toggle persisted to localStorage under the companion's own key
// convention (`${prefix}:companion:clicktowalk`), surfaced as a pill slotted
// into the companion chrome alongside the trails/transitions toggles. Default
// ON. Under prefers-reduced-motion the avatar still goes to the point, but
// instantly (no glide, no path animation) per the motion contract.
//
// This module is owned by src/walk-companion.js, which calls
// installClickToWalk() once on load. Side-effect free on import.

import { prefersReducedMotion, isCoarsePointer } from '../walk-sdk/src/internal/storage.js';

// ── Tunables ──────────────────────────────────────────────────────────────────
const WALK_SPEED = 520; // px / second the host glides across the page
const ARRIVAL_MS = 260; // easing window as it settles onto the target
const MIN_TRAVEL = 8; // ignore micro-moves (px) — reads as a mis-click
const LONG_PRESS_MS = 550; // touch: hold this long (still) to direct the avatar
const TOUCH_SLOP = 12; // px of finger drift that cancels a long-press
const BLOCK_INFLATE = 14; // px each obstacle box is grown by for clearance
const MAX_DETOUR_DEPTH = 4; // recursion cap for the corner-routing pathfinder
const RIPPLE_MS = 620;
const FOOTPRINT_FADE_MS = 2000; // spec: footprint trail fades after ~2s
const Z_FX = 2147482998; // just under the trail layer (…999) & companion (…000)

// ── Persistence (mirrors the companion's `${prefix}:companion:*` convention) ───
let PREF_KEY = 'walk:companion:clicktowalk';

function isEnabledPref() {
	try {
		// Default ON: an absent key means the visitor never opted out.
		return localStorage.getItem(PREF_KEY) !== '0';
	} catch {
		return true;
	}
}
function setEnabledPref(on) {
	try {
		localStorage.setItem(PREF_KEY, on ? '1' : '0');
	} catch {
		/* private mode / disabled storage — non-fatal */
	}
}

// ── Interactive-target detection ───────────────────────────────────────────────
// An "empty space" click is one whose target neither IS nor sits INSIDE anything
// the visitor could plausibly be interacting with. Anything matched here is left
// entirely to the page — we never intercept it.
const INTERACTIVE_SELECTOR = [
	'a[href]',
	'button',
	'input',
	'select',
	'textarea',
	'label',
	'summary',
	'details',
	'option',
	'[role="button"]',
	'[role="link"]',
	'[role="menuitem"]',
	'[role="tab"]',
	'[role="checkbox"]',
	'[role="switch"]',
	'[contenteditable]',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
	'[onclick]',
	'.walk-companion', // the companion itself (canvas + its chrome)
	'[data-walk-block]', // explicit no-walk zones double as no-hijack zones
].join(',');

function isInteractiveTarget(el) {
	if (!el || typeof el.closest !== 'function') return true; // be conservative
	if (el.closest(INTERACTIVE_SELECTOR)) return true;
	// Text the visitor may be selecting — don't steal a selection-drag's mouseup.
	const sel = (typeof getSelection === 'function' && getSelection()) || null;
	if (sel && !sel.isCollapsed && String(sel).trim()) return true;
	return false;
}

// ── Obstacle model ─────────────────────────────────────────────────────────────
// Each [data-walk-block] becomes an axis-aligned rectangle in viewport coords,
// inflated for clearance. Recomputed at the start of every walk so it reflects
// the live layout (scroll, responsive reflow, lazy content).
function collectObstacles() {
	const rects = [];
	const blocks = document.querySelectorAll('[data-walk-block]');
	for (const el of blocks) {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		rects.push({
			left: r.left - BLOCK_INFLATE,
			top: r.top - BLOCK_INFLATE,
			right: r.right + BLOCK_INFLATE,
			bottom: r.bottom + BLOCK_INFLATE,
		});
	}
	return rects;
}

function pointInRect(x, y, r) {
	return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Liang–Barsky segment/rect intersection — true if [a,b] crosses rect interior.
function segmentHitsRect(ax, ay, bx, by, r) {
	if (pointInRect(ax, ay, r) || pointInRect(bx, by, r)) return true;
	const dx = bx - ax;
	const dy = by - ay;
	let t0 = 0;
	let t1 = 1;
	const edges = [
		[-dx, ax - r.left],
		[dx, r.right - ax],
		[-dy, ay - r.top],
		[dy, r.bottom - ay],
	];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return false; // parallel and outside this slab
		} else {
			const t = q / p;
			if (p < 0) {
				if (t > t1) return false;
				if (t > t0) t0 = t;
			} else {
				if (t < t0) return false;
				if (t < t1) t1 = t;
			}
		}
	}
	return t0 <= t1;
}

function firstBlocking(ax, ay, bx, by, obstacles) {
	let best = null;
	let bestDist = Infinity;
	for (const r of obstacles) {
		if (!segmentHitsRect(ax, ay, bx, by, r)) continue;
		const cx = (r.left + r.right) / 2;
		const cy = (r.top + r.bottom) / 2;
		const d = (cx - ax) ** 2 + (cy - ay) ** 2;
		if (d < bestDist) {
			bestDist = d;
			best = r;
		}
	}
	return best;
}

// Route from (ax,ay) to (bx,by) around obstacles by detouring through the
// blocking box's corners. For each blocker we try its four (slightly outset)
// corners, recurse on the two legs, and keep the shortest collision-free path.
// Depth-capped so pathological layouts still terminate; on cap we accept the
// straight line (the host simply glides through, which is benign).
function planPath(ax, ay, bx, by, obstacles, depth = 0) {
	const blocker = firstBlocking(ax, ay, bx, by, obstacles);
	if (!blocker || depth >= MAX_DETOUR_DEPTH) return [{ x: bx, y: by }];

	const pad = 2;
	const corners = [
		{ x: blocker.left - pad, y: blocker.top - pad },
		{ x: blocker.right + pad, y: blocker.top - pad },
		{ x: blocker.right + pad, y: blocker.bottom + pad },
		{ x: blocker.left - pad, y: blocker.bottom + pad },
	];

	let best = null;
	let bestLen = Infinity;
	for (const c of corners) {
		// Skip corners that are themselves buried inside another obstacle.
		if (obstacles.some((r) => r !== blocker && pointInRect(c.x, c.y, r))) continue;
		const legA = planPath(ax, ay, c.x, c.y, obstacles, depth + 1);
		const legB = planPath(c.x, c.y, bx, by, obstacles, depth + 1);
		const path = [...legA, ...legB];
		const len = pathLength(ax, ay, path);
		if (len < bestLen) {
			bestLen = len;
			best = path;
		}
	}
	return best || [{ x: bx, y: by }];
}

function pathLength(sx, sy, pts) {
	let len = 0;
	let px = sx;
	let py = sy;
	for (const p of pts) {
		len += Math.hypot(p.x - px, p.y - py);
		px = p.x;
		py = p.y;
	}
	return len;
}

// ── Visual feedback layer (route, ripple, footprints) ──────────────────────────
function makeFxLayer() {
	const layer = document.createElement('div');
	layer.className = 'walk-c2w-fx';
	layer.setAttribute('aria-hidden', 'true');
	layer.style.cssText = [
		'position:fixed',
		'inset:0',
		`z-index:${Z_FX}`,
		'pointer-events:none',
		'overflow:visible',
		'contain:layout style',
	].join(';');
	const svgNS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(svgNS, 'svg');
	svg.setAttribute('width', '100%');
	svg.setAttribute('height', '100%');
	svg.style.cssText = 'position:absolute;inset:0;overflow:visible';
	const route = document.createElementNS(svgNS, 'polyline');
	route.setAttribute('fill', 'none');
	route.setAttribute('stroke-width', '2');
	route.setAttribute('stroke-linecap', 'round');
	route.setAttribute('stroke-linejoin', 'round');
	route.setAttribute('stroke-dasharray', '2 8');
	route.setAttribute('opacity', '0');
	svg.appendChild(route);
	layer.appendChild(svg);
	document.body.appendChild(layer);
	return { layer, route };
}

function accentColor() {
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
		if (v) return v;
	} catch {
		/* SSR / no DOM */
	}
	return '#7aa2ff';
}

let _fxStyleInjected = false;
function ensureFxStyles() {
	if (_fxStyleInjected) return;
	_fxStyleInjected = true;
	const s = document.createElement('style');
	s.id = 'walk-c2w-style';
	s.textContent = `
@keyframes walk-c2w-ripple{from{transform:translate(-50%,-50%) scale(.2);opacity:.8}to{transform:translate(-50%,-50%) scale(1);opacity:0}}
@keyframes walk-c2w-foot-out{to{opacity:0;transform:translate(-50%,-50%) rotate(var(--c2w-rot)) scale(.7)}}
.walk-c2w-ripple{position:absolute;width:46px;height:46px;border-radius:50%;border:2px solid var(--accent,#7aa2ff);will-change:transform,opacity;animation:walk-c2w-ripple ${RIPPLE_MS}ms cubic-bezier(0,0,0.2,1) forwards}
.walk-c2w-foot{position:absolute;width:9px;height:14px;border-radius:50% 50% 45% 45%;will-change:transform,opacity;opacity:.7}
.walk-c2w-cursor,.walk-c2w-cursor *{cursor:none}
@media (prefers-reduced-motion:reduce){.walk-c2w-ripple{animation-duration:1ms}}
`;
	document.head.appendChild(s);
}

function spawnRipple(layer, x, y) {
	const r = document.createElement('div');
	r.className = 'walk-c2w-ripple';
	r.style.left = `${x}px`;
	r.style.top = `${y}px`;
	r.style.borderColor = accentColor();
	layer.appendChild(r);
	setTimeout(() => r.remove(), RIPPLE_MS + 60);
}

// Drop one footprint glyph along the travelled path, alternating L/R, fading
// over ~2s (spec). `side` flips per call; `ang` is the travel heading (rad).
function spawnFootprint(layer, x, y, ang, side, color) {
	const nx = Math.cos(ang + Math.PI / 2) * 6 * side;
	const ny = Math.sin(ang + Math.PI / 2) * 6 * side;
	const f = document.createElement('div');
	f.className = 'walk-c2w-foot';
	const deg = (ang * 180) / Math.PI + 90;
	f.style.left = `${x + nx}px`;
	f.style.top = `${y + ny}px`;
	f.style.background = color;
	f.style.setProperty('--c2w-rot', `${deg}deg`);
	f.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
	f.style.animation = `walk-c2w-foot-out ${FOOTPRINT_FADE_MS}ms linear forwards`;
	layer.appendChild(f);
	setTimeout(() => f.remove(), FOOTPRINT_FADE_MS + 60);
}

// ── The walker ─────────────────────────────────────────────────────────────────
// Owns one animation at a time. `getInstance` returns the live companion
// instance (re-resolved every walk so avatar swaps / playground round-trips just
// work). We translate instance.host via a transform offset from its resting
// fixed-corner position, drive the controller's walk state, and steer the rig
// yaw toward the travel heading.
function createWalker(getInstance, fx) {
	let raf = 0;
	let footSide = 1;

	function stop() {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}

	// The host's resting anchor (its untranslated screen rect). We translate from
	// there, so the avatar's *feet* — near the host's bottom-centre — land on the
	// target point.
	function anchorOf(host) {
		const prev = host.style.transform;
		host.style.transform = 'none';
		const r = host.getBoundingClientRect();
		host.style.transform = prev;
		return { footX: r.left + r.width / 2, footY: r.top + r.height * 0.86 };
	}

	function applyOffset(host, dx, dy) {
		host.style.transform = `translate(${dx}px, ${dy}px)`;
	}

	function currentOffset(host) {
		const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(host.style.transform || '');
		return m ? { dx: parseFloat(m[1]), dy: parseFloat(m[2]) } : { dx: 0, dy: 0 };
	}

	// Walk to a viewport point. Returns a promise that resolves on arrival (or
	// immediately if there's nothing to do), so link/button delegation can chain.
	function walkTo(targetX, targetY) {
		const inst = getInstance();
		const host = inst?.host;
		if (!host || !inst.mounted) return Promise.resolve(false);

		const anchor = anchorOf(host);
		const start = currentOffset(host);
		// Where the feet currently are (anchor + current offset).
		const fromX = anchor.footX + start.dx;
		const fromY = anchor.footY + start.dy;

		const dist = Math.hypot(targetX - fromX, targetY - fromY);
		spawnRipple(fx.layer, targetX, targetY);
		if (dist < MIN_TRAVEL) return Promise.resolve(false);

		const obstacles = collectObstacles();
		const path = planPath(fromX, fromY, targetX, targetY, obstacles);
		// Prepend the live start so the route polyline & segment walk are complete.
		const pts = [{ x: fromX, y: fromY }, ...path];

		drawRoute(pts);

		const reduced = prefersReducedMotion();
		if (reduced) {
			// Instant move — honour the motion contract; no glide, no per-frame walk.
			const last = pts[pts.length - 1];
			applyOffset(host, last.x - anchor.footX, last.y - anchor.footY);
			faceHeading(inst, pts[pts.length - 2] || pts[0], last);
			clearRoute();
			return Promise.resolve(true);
		}

		return animateAlong(inst, host, anchor, pts);
	}

	function faceHeading(inst, from, to) {
		// Map screen travel direction → a yaw the SDK rig understands. The SDK
		// clamps cursor-follow yaw to ±0.7 around centre; we reuse that range so a
		// leftward walk turns the avatar left, rightward turns right.
		const dx = to.x - from.x;
		const sign = Math.abs(dx) < 1 ? 0 : Math.sign(dx);
		const yaw = sign * 0.55;
		// Steer via the SDK's own target so its smoothing eases the turn, and lock
		// out cursor-follow for the duration by parking the "last cursor" time.
		if (typeof inst._targetYaw === 'number') inst._targetYaw = yaw;
	}

	function animateAlong(inst, host, anchor, pts) {
		stop();
		return new Promise((resolve) => {
			// Precompute cumulative segment lengths for constant-speed traversal.
			const segs = [];
			let total = 0;
			for (let i = 1; i < pts.length; i++) {
				const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
				segs.push({ a: pts[i - 1], b: pts[i], len, start: total });
				total += len;
			}
			if (total < 1) {
				clearRoute();
				resolve(true);
				return;
			}
			const travelMs = (total / WALK_SPEED) * 1000;
			const t0 = performance.now();
			let footAcc = 0;
			let lastX = pts[0].x;
			let lastY = pts[0].y;
			const color = accentColor();

			inst.controller?.setState('walk');

			const step = (now) => {
				const live = getInstance();
				if (!live || live !== inst || !inst.mounted) {
					// Companion vanished mid-walk (disable / swap / playground). Bail
					// cleanly — the new instance starts fresh at its corner.
					clearRoute();
					resolve(false);
					return;
				}
				const elapsed = now - t0;
				const linear = Math.min(1, elapsed / travelMs);
				// Ease only the final ARRIVAL_MS so most of the trip is steady pace.
				let eased = linear;
				const arriveFrac = Math.min(0.5, ARRIVAL_MS / travelMs);
				if (linear > 1 - arriveFrac) {
					const local = (linear - (1 - arriveFrac)) / arriveFrac;
					eased = 1 - arriveFrac + arriveFrac * (1 - (1 - local) ** 3);
				}
				const along = eased * total;

				// Find the active segment and interpolate the foot position.
				let seg = segs[segs.length - 1];
				for (const s of segs) {
					if (along <= s.start + s.len) {
						seg = s;
						break;
					}
				}
				const local = seg.len > 0 ? (along - seg.start) / seg.len : 1;
				const fx2 = seg.a.x + (seg.b.x - seg.a.x) * local;
				const fy2 = seg.a.y + (seg.b.y - seg.a.y) * local;
				applyOffset(host, fx2 - anchor.footX, fy2 - anchor.footY);
				faceHeading(inst, seg.a, seg.b);

				// Drop footprints at a steady stride along the real travelled path.
				footAcc += Math.hypot(fx2 - lastX, fy2 - lastY);
				const ang = Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x);
				while (footAcc >= 30) {
					footAcc -= 30;
					spawnFootprint(fx.layer, lastX, lastY, ang, footSide, color);
					footSide *= -1;
				}
				lastX = fx2;
				lastY = fy2;

				if (linear >= 1) {
					inst.controller?.setState('idle');
					clearRoute();
					resolve(true);
					return;
				}
				raf = requestAnimationFrame(step);
			};
			raf = requestAnimationFrame(step);
		});
	}

	function drawRoute(pts) {
		if (prefersReducedMotion()) return;
		fx.route.setAttribute('points', pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
		fx.route.setAttribute('stroke', accentColor());
		fx.route.setAttribute('opacity', '0.55');
	}
	function clearRoute() {
		fx.route.animate?.([{ opacity: 0.55 }, { opacity: 0 }], { duration: 240, fill: 'forwards' });
		fx.route.setAttribute('opacity', '0');
	}

	return { walkTo, stop };
}

// ── Settings toggle (slotted into the companion chrome) ────────────────────────
// Matches the trails/transitions sibling buttons: a small round control in the
// host's top-right cluster, revealed on hover/focus, persisted on click.
function injectToggle(host) {
	if (!host || host.querySelector('.walk-companion-c2w')) return;
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'walk-companion-c2w';
	btn.setAttribute('aria-label', 'Toggle click-to-walk navigation');
	btn.setAttribute('aria-pressed', isEnabledPref() ? 'true' : 'false');
	btn.title = isEnabledPref() ? 'Click-to-walk: on' : 'Click-to-walk: off';
	btn.textContent = '➜';
	btn.style.cssText = [
		'position:absolute',
		'top:2px',
		'right:80px', // left of close(2)/swap(28)/trail(54)
		'z-index:3',
		'width:22px',
		'height:22px',
		'border:none',
		'border-radius:50%',
		'background:rgba(12,14,20,.55)',
		'color:#fff',
		'font-size:12px',
		'line-height:1',
		'cursor:pointer',
		'pointer-events:auto',
		'opacity:0',
		'transition:opacity .2s ease,background .2s ease',
		'display:grid',
		'place-items:center',
		'padding:0',
	].join(';');
	syncToggleVisual(btn);

	const styleId = 'walk-companion-c2w-toggle-style';
	if (!document.getElementById(styleId)) {
		const s = document.createElement('style');
		s.id = styleId;
		s.textContent =
			'.walk-companion:hover .walk-companion-c2w,.walk-companion:focus-within .walk-companion-c2w{opacity:1}' +
			'.walk-companion-c2w:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;opacity:1}' +
			'@media (pointer:coarse){.walk-companion-c2w{opacity:1;right:88px}}';
		document.head.appendChild(s);
	}

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		setEnabledPref(!isEnabledPref());
		syncToggleVisual(btn);
	});
	host.appendChild(btn);
}

function syncToggleVisual(btn) {
	const on = isEnabledPref();
	btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	btn.title = on ? 'Click-to-walk: on' : 'Click-to-walk: off';
	btn.style.background = on ? 'rgba(122,162,255,.45)' : 'rgba(12,14,20,.55)';
	btn.style.color = on ? '#fff' : 'rgba(255,255,255,.5)';
}

// ── Public install ─────────────────────────────────────────────────────────────
/**
 * Wire click-to-walk navigation to the companion.
 * @param {object} opts
 * @param {() => (object|null)} opts.getInstance returns the live WalkCompanion
 *        instance (with .host, .mounted, .controller, ._targetYaw).
 * @param {() => (HTMLElement|null)} [opts.getHostEl] returns the companion host
 *        for injecting the settings toggle (defaults to getInstance().host).
 * @param {string} [opts.storageKey] localStorage key for the on/off pref.
 * @returns {() => void} uninstall function.
 */
export function installClickToWalk({ getInstance, getHostEl, storageKey } = {}) {
	if (typeof document === 'undefined') return () => {};
	if (storageKey) PREF_KEY = storageKey;
	const resolveInst = typeof getInstance === 'function' ? getInstance : () => null;

	ensureFxStyles();
	const fx = makeFxLayer();
	const walker = createWalker(resolveInst, fx);

	const ready = () => {
		const inst = (() => {
			try {
				return resolveInst();
			} catch {
				return null;
			}
		})();
		return isEnabledPref() && inst && inst.mounted && inst.host;
	};

	// ── Fine-pointer: plain empty-space click ────────────────────────────────────
	function onClickCapture(e) {
		if (e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
		if (e.pointerType === 'touch') return; // touch handled by long-press below
		if (!ready()) return;
		if (isInteractiveTarget(e.target)) return; // never hijack real controls
		// Empty-space clicks have no default action, so we don't preventDefault —
		// normal link/button navigation is provably untouched.
		walker.walkTo(e.clientX, e.clientY);
	}

	// ── Coarse-pointer: long-press on empty space ────────────────────────────────
	let pressTimer = 0;
	let pressX = 0;
	let pressY = 0;
	let pressTarget = null;

	function clearPress() {
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = 0;
		pressTarget = null;
	}
	function onTouchStart(e) {
		if (!isCoarsePointer()) return;
		if (e.touches && e.touches.length > 1) return clearPress();
		if (!ready()) return;
		const t = e.touches ? e.touches[0] : e;
		if (!t) return;
		if (isInteractiveTarget(t.target)) return; // leave taps on controls alone
		pressX = t.clientX;
		pressY = t.clientY;
		pressTarget = t.target;
		clearTimeout(pressTimer);
		pressTimer = setTimeout(() => {
			pressTimer = 0;
			// Fire only if the finger is still on empty space — a long stationary
			// press, not a tap or a scroll.
			if (pressTarget && !isInteractiveTarget(pressTarget)) {
				walker.walkTo(pressX, pressY);
			}
		}, LONG_PRESS_MS);
	}
	function onTouchMove(e) {
		if (!pressTimer) return;
		const t = e.touches ? e.touches[0] : e;
		if (!t) return;
		if (Math.hypot(t.clientX - pressX, t.clientY - pressY) > TOUCH_SLOP) clearPress();
	}

	document.addEventListener('click', onClickCapture, { capture: true });
	document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
	document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
	document.addEventListener('touchend', clearPress, { capture: true });
	document.addEventListener('touchcancel', clearPress, { capture: true });
	// A resize re-anchors the host: snap any in-progress glide offset away so the
	// avatar returns to its corner rather than floating at a stale coordinate.
	const onResize = () => {
		walker.stop();
		const inst = resolveInst();
		if (inst?.host) inst.host.style.transform = '';
	};
	window.addEventListener('resize', onResize, { passive: true });

	// Inject the settings toggle once the host exists (poll briefly after mount),
	// and re-inject after avatar swaps / playground round-trips replace the host.
	let tries = 0;
	let wireTimer = null;
	const tryInject = () => {
		const host = (() => {
			try {
				return (typeof getHostEl === 'function' ? getHostEl() : resolveInst()?.host) || null;
			} catch {
				return null;
			}
		})();
		if (host) injectToggle(host);
		if (tries++ < 600) wireTimer = setTimeout(tryInject, 500); // keep re-asserting on swaps
	};
	tryInject();

	return function uninstall() {
		clearTimeout(wireTimer);
		document.removeEventListener('click', onClickCapture, { capture: true });
		document.removeEventListener('touchstart', onTouchStart, { capture: true });
		document.removeEventListener('touchmove', onTouchMove, { capture: true });
		document.removeEventListener('touchend', clearPress, { capture: true });
		document.removeEventListener('touchcancel', clearPress, { capture: true });
		window.removeEventListener('resize', onResize);
		walker.stop();
		fx.layer.remove();
	};
}
