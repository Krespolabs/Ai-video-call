// Mood embodiment — the bridge from the mood engine to the body.
//
// Subscribes to `mood:changed` (and a couple of real micro-signals) and
// re-expresses every live surface of the active agent:
//   • each <agent-3d> for the active agent → sustained setMood() (resting face +
//     posture) plus a one-shot expressEmotion() beat on a real spike;
//   • the site-wide walk companion → a mood-coloured presence aura + a
//     breathing-rate shift, and a celebratory wave on a strong positive beat.
//
// It owns no mood logic — it only maps the engine's state onto the existing
// animation/morph API. Importing it boots the mood engine (side-effect) so any
// page that wants a living body just imports this one module.

import { moodEngine } from './mood-engine.js';
import { agentBus, EVENTS } from './agent-bus.js';

const REDUCE_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const STYLE_ID = 'mood-embodiment-style';

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const css = `
		.walk-companion-host[data-mood], [data-walk-companion][data-mood] {
			transition: filter 1.2s ease, box-shadow 1.2s ease;
		}
		.mood-aura {
			position: absolute; inset: 0; pointer-events: none; border-radius: 50%;
			opacity: var(--mood-strength, 0); transition: opacity 1.2s ease, background 1.2s ease;
			background: radial-gradient(closest-side, var(--mood-color, transparent) 0%, transparent 72%);
			mix-blend-mode: screen;
			animation: mood-breathe var(--mood-breathe, 6s) ease-in-out infinite;
		}
		@keyframes mood-breathe {
			0%, 100% { transform: scale(0.92); }
			50% { transform: scale(1.06); }
		}
		@media (prefers-reduced-motion: reduce) {
			.mood-aura { animation: none; }
		}
	`;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = css;
	document.head.appendChild(el);
}

// Resolve the <agent-3d> elements that represent the agent this mood belongs to.
// We only drive avatars explicitly bound to that agent — never impose one agent's
// mood on an unrelated embed.
function avatarsFor(agentId) {
	if (typeof document === 'undefined') return [];
	const all = Array.from(document.querySelectorAll('agent-3d'));
	return all.filter((el) => {
		const bound = el.getAttribute('agent-id') || el.getAttribute('agent_id');
		return bound && agentId && bound === agentId;
	});
}

function applyToAvatars(payload) {
	const els = avatarsFor(payload.agentId);
	for (const el of els) {
		try {
			el.setMood?.(payload.valence, payload.arousal, { reducedMotion: REDUCE_MOTION });
			// A real spike (a strong, signal-driven transition) plays a one-shot
			// emotional beat on top of the new resting expression.
			if (payload.beat && payload.mood?.trigger) {
				el.expressEmotion?.(payload.mood.trigger, payload.mood.intensity ?? 0.6);
			}
		} catch { /* element not ready — it'll pick up the next emit */ }
	}
}

// ── Walk companion presence ──────────────────────────────────────────────────

function companionRoot() {
	if (typeof document === 'undefined') return null;
	const host =
		(typeof window !== 'undefined' && window.__walkCompanion?.instance?.host) ||
		document.querySelector('.walk-companion-host, [data-walk-companion]');
	return host || null;
}

function applyToCompanion(payload) {
	const host = companionRoot();
	if (!host) return;
	const color = payload.mood?.color || '#7c93b3';
	// Strength scales with how far the mood is from the neutral resting point:
	// a calm agent glows faintly, an elated/agitated one clearly.
	const intensity = Math.min(1, Math.abs(payload.valence) * 0.9 + Math.abs(payload.arousal - 0.35) * 0.8);
	const strength = (0.12 + intensity * 0.5).toFixed(3);
	// Arousal drives the breathing rate — calm breathes slow, alert breathes fast.
	const breathe = REDUCE_MOTION ? '0s' : `${(7.5 - payload.arousal * 4).toFixed(2)}s`;

	host.dataset.mood = payload.mood?.key || 'calm';
	host.style.position = host.style.position || 'relative';
	host.style.setProperty('--mood-color', color);
	host.style.filter = REDUCE_MOTION ? '' : `drop-shadow(0 0 ${(intensity * 14).toFixed(1)}px ${color})`;

	let aura = host.querySelector(':scope > .mood-aura');
	if (!aura) {
		aura = document.createElement('div');
		aura.className = 'mood-aura';
		aura.setAttribute('aria-hidden', 'true');
		host.appendChild(aura);
	}
	aura.style.setProperty('--mood-color', color);
	aura.style.setProperty('--mood-strength', strength);
	aura.style.setProperty('--mood-breathe', breathe);

	// A strong positive spike makes the companion wave — a real celebratory beat.
	if (payload.beat && payload.valence > 0.3) {
		try { window.__walkCompanion?.instance?.controller?.playWave?.(); } catch { /* no controller */ }
	}
}

let _started = false;

export function startMoodEmbodiment() {
	if (_started || typeof window === 'undefined') return;
	_started = true;
	injectStyle();

	const onMood = (payload) => {
		if (!payload?.agentId) return;
		applyToAvatars(payload);
		applyToCompanion(payload);
	};
	// `replay: true` re-expresses the current mood the instant a surface mounts.
	agentBus.on(EVENTS.MOOD_CHANGED, onMood, { replay: true });

	// Involuntary micro-expression: a brief flicker of recognition when the agent
	// recalls a memory mid-conversation — grounded in the real recall event, not a
	// timer. Independent of mood magnitude so it reads even on a stoic agent.
	agentBus.on(EVENTS.MEMORY_RECALLED, (p) => {
		if (REDUCE_MOTION) return;
		for (const el of avatarsFor(p?.agentId)) {
			try { el.expressEmotion?.('curiosity', 0.22); } catch { /* not ready */ }
		}
	});
}

// Boot the engine + the binder on import.
moodEngine.start();
startMoodEmbodiment();

export default startMoodEmbodiment;
