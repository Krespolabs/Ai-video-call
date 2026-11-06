/**
 * Embodied Finance — the 3D (WebGL) aura for full Three.js scenes (IRL/AR, the
 * world). The 2D/CSS aura in wallet-aura.js wraps DOM avatars (<model-viewer>,
 * cards); this is its GPU-cheap sibling for scenes where the avatar is a real
 * mesh in a Three.js graph — so a well-funded agent you walk past in AR visibly
 * glows, reading at the SAME wealth tier it shows everywhere else.
 *
 * Craft + budget:
 *   - One additive, billboarded Sprite per avatar (a soft radial-gradient glow),
 *     sharing a single canvas texture across all instances — no per-avatar
 *     allocation, no per-frame garbage. A Sprite faces the camera for free, so
 *     there is no manual billboard math in the host's render loop.
 *   - The look is a pure function of the REAL wealth state (tier → base opacity +
 *     scale + accent; momentum → intensity tilt; streaming → a slow breath; a
 *     fresh tip → a one-shot pulse). A dormant wallet renders nothing (opacity 0),
 *     never a fake shimmer.
 *   - prefers-reduced-motion: the steady glow stays, animation (breath/pulse) is
 *     suppressed.
 *
 * The colour vocabulary (tier → accent) is shared with the 2D aura via
 * computeWalletVisual, so the galaxy star, the profile hero, the card, and the AR
 * body never disagree.
 */

import { Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending, Color, SRGBColorSpace } from 'three';
import { computeWalletVisual } from './wallet-networth.js';
import { computeWealthDynamics } from './agent-wealth-state.js';

const REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let _sharedTexture = null;

/** A soft white radial-gradient glow, built once and shared by every aura. */
function glowTexture() {
	if (_sharedTexture) return _sharedTexture;
	const size = 128;
	const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
	if (!c) return null;
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
	g.addColorStop(0.7, 'rgba(255,255,255,0.12)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	_sharedTexture = new CanvasTexture(c);
	_sharedTexture.colorSpace = SRGBColorSpace;
	return _sharedTexture;
}

/**
 * Create a 3D wealth aura. Add `object` to the avatar's group; call `update(dt)`
 * each frame, `applyState(wealthState)` whenever fresh real data arrives, and
 * `dispose()` on teardown.
 *
 * @param {object} [opts]
 * @param {number} [opts.height=1.7]  avatar height in world units (scales the glow)
 * @returns {{ object: import('three').Sprite, applyState, pulse, setHeight, update, dispose }}
 */
export function createWealthAura3D(opts = {}) {
	const material = new SpriteMaterial({
		map: glowTexture(),
		color: new Color('#c4b5fd'),
		blending: AdditiveBlending,
		depthWrite: false,
		depthTest: true,
		transparent: true,
		opacity: 0,
	});
	const sprite = new Sprite(material);
	sprite.name = 'wealth-aura-3d';
	sprite.renderOrder = -1; // behind the avatar mesh

	let height = Math.max(0.3, Number(opts.height) || 1.7);
	let baseOpacity = 0;
	let baseScale = 1;
	let level = 0;
	let streaming = false;
	let clockT = 0;
	let pulseT = 0; // 0..1, decays over ~1s
	let disposed = false;

	function position() {
		// Sit the glow at the avatar's centre of mass and a touch wider than it.
		sprite.position.set(0, height * 0.5, 0);
	}
	position();

	function applyState(state) {
		if (disposed || !state) return;
		const usd = Number(state.balanceUsd) || 0;
		const v = computeWalletVisual({ usdTotal: usd, mix: { sol: 1 }, hasThree: false });
		const dyn = computeWealthDynamics(state);
		level = v.level;
		// Dormant → invisible (honest). Otherwise a tasteful, capped glow that grows
		// with tier, nudged by real momentum.
		baseOpacity = v.dormant ? 0 : Math.min(0.6, 0.14 + level * 0.075 + dyn.intensityDelta * 0.2);
		baseScale = 1 + level * 0.16;
		streaming = dyn.streaming;
		// Accent in the wallet-violet family, warmed/cooled slightly by momentum.
		material.color.set(v.accent);
		if (dyn.recentTip) pulse();
	}

	function pulse() { if (!REDUCED_MOTION) pulseT = 1; }

	function setHeight(h) {
		height = Math.max(0.3, Number(h) || height);
		position();
	}

	function update(dt) {
		if (disposed) return;
		clockT += dt || 0;
		let op = baseOpacity;
		let sc = baseScale;
		// A live money stream breathes the glow gently (calm, ~0.3 Hz).
		if (streaming && !REDUCED_MOTION && baseOpacity > 0) {
			const b = 0.5 + 0.5 * Math.sin(clockT * 1.9);
			op *= 0.82 + b * 0.36;
		}
		// One-shot tip pulse: a quick bloom that decays back to baseline.
		if (pulseT > 0) {
			pulseT = Math.max(0, pulseT - (dt || 0) / 1.0);
			const e = pulseT;
			op = Math.min(1, op + e * 0.5);
			sc += e * 0.7;
		}
		material.opacity = op;
		const s = sc * height * 1.6;
		sprite.scale.set(s, s, 1);
	}

	function dispose() {
		disposed = true;
		sprite.removeFromParent?.();
		material.dispose();
		// The texture is shared — never disposed here.
	}

	return { object: sprite, applyState, pulse, setHeight, update, dispose };
}
