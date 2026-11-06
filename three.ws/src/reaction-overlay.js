// Floating-emoji reaction overlay — the canvas layer that paints viewers' live
// reactions rising over a stream. Split into a pure simulation core (testable
// with no DOM) and a thin canvas mount that both the live wall and the agent
// screen reuse.
//
// Design goals:
//   • Performant: one <canvas> per surface, capped particle count, and the RAF
//     loop self-pauses the instant the field empties (idle cards cost nothing).
//   • Batched bursts: a flood of reactions can't spawn unbounded particles — each
//     burst is clamped, and the field as a whole is capped (oldest evicted).
//   • Deterministic core: spawn jitter derives from a caller-supplied seed, so the
//     simulation is unit-testable without Math.random.

// The emoji the bar offers, in display order. Mirrors the server allowlist in
// api/_lib/reaction-rules.js — the server is the authority; this copy is what the
// viewer can tap. Keep the two in sync.
export const REACTION_EMOJI = Object.freeze(['🔥', '❤️', '👏', '🚀', '😂']);

const DEFAULT_MAX = 64;        // hard ceiling on concurrent particles
const DEFAULT_PER_BURST = 12;  // most particles a single burst may spawn
const PARTICLE_TTL_MS = 2200;  // lifetime of one floating emoji
const FADE_IN = 0.12;          // fraction of life spent fading in
const FADE_OUT = 0.36;         // trailing fraction spent fading out

// Deterministic pseudo-jitter in [0,1) from an integer seed — a cheap hash so two
// particles from one burst don't stack exactly, without pulling in Math.random
// (which would make the core untestable).
function jitter(seed) {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

/**
 * Create one particle. Coordinates are normalized: x ∈ [0,1] across the width,
 * y ∈ [0,1] rising from the bottom (0) to the top (1). The mount maps these to
 * pixels, so the same particle reads correctly at any canvas size.
 *
 * @param {string} emoji
 * @param {number} seed   integer seed for deterministic jitter
 */
export function spawnParticle(emoji, seed = 0) {
	const j1 = jitter(seed);
	const j2 = jitter(seed * 2 + 1);
	const j3 = jitter(seed * 3 + 7);
	return {
		emoji,
		// Cluster the launch point around the lower centre with a little spread.
		x0: 0.28 + j1 * 0.44,
		x: 0.28 + j1 * 0.44,
		y: 0,
		// Horizontal sway amplitude + phase so emojis weave as they rise.
		sway: (j2 - 0.5) * 0.16,
		phase: j3 * Math.PI * 2,
		age: 0,
		ttl: PARTICLE_TTL_MS * (0.85 + j2 * 0.3),
		size: 0.6,
		opacity: 0,
	};
}

/**
 * Advance one particle by dtMs. Mutates and returns it. Returns the particle so
 * callers can map; check `alive(p)` for liveness.
 */
export function advanceParticle(p, dtMs) {
	p.age += dtMs;
	const t = Math.min(1, p.age / p.ttl);
	// Rise with a gentle ease-out so it slows near the top.
	p.y = 1 - (1 - t) * (1 - t);
	// Weave horizontally around the launch column.
	p.x = p.x0 + p.sway * Math.sin(p.phase + t * Math.PI * 3);
	// Pop in scale over the first fifth of life, then hold.
	p.size = 0.6 + 0.4 * Math.min(1, t / 0.2);
	p.opacity = particleOpacity(t);
	return p;
}

/** Opacity envelope for a normalized life position t ∈ [0,1]. */
export function particleOpacity(t) {
	if (t <= 0) return 0;
	if (t >= 1) return 0;
	if (t < FADE_IN) return t / FADE_IN;
	if (t > 1 - FADE_OUT) return (1 - t) / FADE_OUT;
	return 1;
}

/** Whether a particle is still within its lifetime. */
export function alive(p) {
	return p.age < p.ttl;
}

/** How many particles a burst of `requested` reactions should actually spawn. */
export function burstCount(requested, perBurst = DEFAULT_PER_BURST) {
	const n = Math.max(1, Math.floor(Number(requested) || 1));
	return Math.min(n, perBurst);
}

/**
 * Trim a particle list to `max`, evicting the OLDEST (front) first. Mutates and
 * returns the same array.
 */
export function capParticles(list, max = DEFAULT_MAX) {
	if (list.length > max) list.splice(0, list.length - max);
	return list;
}

/**
 * The pure simulation field. Holds particles, spawns bursts (clamped + capped),
 * and steps them forward. No DOM — drive it from a render loop or a test.
 */
export class ReactionField {
	constructor({ max = DEFAULT_MAX, perBurst = DEFAULT_PER_BURST } = {}) {
		this.max = max;
		this.perBurst = perBurst;
		this.particles = [];
		this._seed = 1;
	}

	/** Spawn a clamped burst of one emoji. Returns the number actually spawned. */
	add(emoji, count = 1) {
		if (!emoji) return 0;
		const n = burstCount(count, this.perBurst);
		for (let i = 0; i < n; i++) this.particles.push(spawnParticle(emoji, this._seed++));
		capParticles(this.particles, this.max);
		return n;
	}

	/** Advance the whole field by dtMs, dropping dead particles. */
	step(dtMs) {
		const next = [];
		for (const p of this.particles) {
			advanceParticle(p, dtMs);
			if (alive(p)) next.push(p);
		}
		this.particles = next;
		return this.particles.length;
	}

	get count() {
		return this.particles.length;
	}

	clear() {
		this.particles = [];
	}
}

/**
 * Mount a canvas overlay inside `container`. The container must be positioned
 * (relative/absolute); the canvas fills it and never intercepts pointer events.
 * The RAF loop runs only while particles exist, so an idle overlay is free.
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {number} [opts.max]       particle ceiling
 * @param {number} [opts.perBurst]  per-burst spawn cap
 * @param {number} [opts.baseFontPx] emoji size at scale 1.0 for a 360px-tall canvas
 * @returns {{ burst(emoji:string, count?:number):void, count():number, destroy():void }}
 */
export function mountReactionOverlay(container, opts = {}) {
	if (typeof document === 'undefined' || !container) {
		// Headless / missing host: hand back a no-op so callers stay simple.
		return { burst() {}, count: () => 0, destroy() {} };
	}
	const field = new ReactionField(opts);
	const baseFont = opts.baseFontPx || 30;

	const canvas = document.createElement('canvas');
	canvas.className = 'rx-overlay';
	canvas.style.cssText =
		'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;';
	canvas.setAttribute('aria-hidden', 'true');
	container.appendChild(canvas);
	const ctx = canvas.getContext('2d');

	let raf = null;
	let last = 0;
	let destroyed = false;
	const reduceMotion =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	function resize() {
		const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
		const w = container.clientWidth || 320;
		const h = container.clientHeight || 180;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}
	resize();
	const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
	ro?.observe(container);

	function frame(now) {
		if (destroyed) return;
		const dt = last ? Math.min(now - last, 64) : 16;
		last = now;
		field.step(dt);

		const w = canvas.width / (ctx.getTransform().a || 1);
		const h = canvas.height / (ctx.getTransform().d || 1);
		ctx.clearRect(0, 0, w, h);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		const fontFor = (h / 360) * baseFont;
		for (const p of field.particles) {
			const px = p.x * w;
			const py = (1 - p.y) * h; // y=0 bottom → bottom of canvas
			ctx.globalAlpha = p.opacity;
			ctx.font = `${Math.max(12, fontFor * p.size)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
			ctx.fillText(p.emoji, px, py);
		}
		ctx.globalAlpha = 1;

		if (field.count > 0) {
			raf = requestAnimationFrame(frame);
		} else {
			raf = null;
			last = 0;
			ctx.clearRect(0, 0, w, h);
		}
	}

	function ensureLoop() {
		if (raf == null && !destroyed) raf = requestAnimationFrame(frame);
	}

	return {
		burst(emoji, count = 1) {
			if (destroyed || !emoji) return;
			// Honour reduced-motion: still acknowledge, but a single calm particle.
			field.add(emoji, reduceMotion ? 1 : count);
			ensureLoop();
		},
		count: () => field.count,
		destroy() {
			destroyed = true;
			if (raf != null) cancelAnimationFrame(raf);
			raf = null;
			ro?.disconnect();
			field.clear();
			canvas.remove();
		},
	};
}
