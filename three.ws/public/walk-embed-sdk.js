// walk-embed-sdk.js — host-side wrapper for the three.ws walking-avatar embed.
//
// Two ways to use it:
//
// 1) One-tag floating avatar (auto-mount). Drop a <script> with data-* attrs and
//    the SDK injects a fixed-position <iframe> for you:
//
//      <script src="https://three.ws/walk-embed-sdk.js"
//              data-avatar="<id>" data-position="bottom-right"
//              data-width="220" data-height="320" data-env="studio"></script>
//
// 2) Programmatic control of any iframe you already rendered (React/Vue/vanilla):
//
//      const a = ThreeWalkAvatar.embed('#avatar');   // or an HTMLIFrameElement
//      a.on('ready', ({ avatarId, env }) => …);
//      a.on('position', ({ x, z, heading }) => …);
//      a.goto(2, -1);  a.gesture('wave');  a.say('hi', 'aria');
//      a.setEnv('beach');  a.setAvatar('<id>');  a.config({ speed: 1.5 });
//      a.off('position', fn);  a.destroy();
//
// Both paths speak the same typed postMessage contract as the iframe runtime
// (src/walk-embed-events.js): a `{ channel:'three-walk', v:1, type, …payload }`
// envelope. Outbound events: ready · position · gesture · speak · env · error.
// Inbound commands: goto · gesture · say · env · avatar · config · move · reset.
//
// Standalone — no runtime deps. Safe to embed on any origin; the iframe page
// ships `content-security-policy: frame-ancestors *`.

(function () {
	'use strict';

	// ── Wire contract (mirror of src/walk-embed-events.js) ────────────────────
	// Kept in lock-step with the module by hand because this file ships as a
	// plain <script> to third-party pages and can't import the ESM contract.
	var CHANNEL = 'three-walk';
	var PROTOCOL_VERSION = 1;
	// Public outbound event names (what hosts subscribe to).
	var OUT = {
		ready: 'walk:ready',
		position: 'walk:position',
		gesture: 'walk:gesture',
		speak: 'walk:speak',
		env: 'walk:env',
		avatarChanged: 'walk:avatarChanged',
		error: 'walk:error',
	};
	var OUT_NAMES = Object.keys(OUT);
	var ENV_IDS = ['studio', 'void', 'beach', 'sunset', 'night', 'grid'];
	var GESTURE_IDS = ['idle', 'walk', 'run', 'wave', 'jump'];
	var CONTROL_MODES = ['joystick', 'keyboard', 'none'];

	function envelope(type, payload) {
		var msg = { channel: CHANNEL, v: PROTOCOL_VERSION, type: type };
		if (payload) for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
		return msg;
	}

	// ── Locate self ───────────────────────────────────────────────────────
	// document.currentScript only works while the script is initially
	// executing; once we go async we need a stable handle.
	var SCRIPT = document.currentScript;
	if (!SCRIPT) {
		// Fall back to "the last <script> with our src in the DOM" — covers
		// the case where this file is dynamically inserted.
		var all = document.getElementsByTagName('script');
		for (var i = all.length - 1; i >= 0; i--) {
			var s = all[i];
			if (s.src && /walk-embed-sdk(\.min)?\.js/.test(s.src)) {
				SCRIPT = s;
				break;
			}
		}
	}

	// Derive the embed origin from the SDK script URL so the SDK and the
	// iframe page can be hosted on the same domain (e.g. three.ws), even
	// when the host page is on a totally different one.
	function originFromScript() {
		if (SCRIPT && SCRIPT.src) {
			try { return new URL(SCRIPT.src).origin; } catch (e) {}
		}
		return 'https://three.ws';
	}
	var EMBED_ORIGIN = originFromScript();

	// ── Defaults + script-attribute overrides ─────────────────────────────
	function attr(name, fallback) {
		if (!SCRIPT) return fallback;
		var v = SCRIPT.getAttribute(name);
		return v == null || v === '' ? fallback : v;
	}

	function attrBool(name, fallback) {
		var v = attr(name, null);
		if (v == null) return fallback;
		v = String(v).toLowerCase();
		return v !== 'false' && v !== '0' && v !== 'no';
	}

	// Floating-corner embeds default to no ground disc and no orbit drag —
	// hosts that mount into a full-size container can opt back in with
	// `data-ground="true"` / `data-orbit="true"`.
	function attrNum(name, fallback, lo, hi) {
		var n = Number(attr(name, null));
		if (!isFinite(n)) return fallback;
		return Math.min(hi, Math.max(lo, n));
	}

	var defaults = {
		avatar: attr('data-avatar', ''),
		position: attr('data-position', 'bottom-right'),
		width: parseInt(attr('data-width', '220'), 10) || 220,
		height: parseInt(attr('data-height', '320'), 10) || 320,
		controls: attr('data-controls', 'none'),
		env: attr('data-env', 'studio'),
		autoplay: attrBool('data-autoplay', true),
		ground: attrBool('data-ground', false),
		orbit: attrBool('data-orbit', false),
		bg: attr('data-bg', 'transparent'),
		speed: attrNum('data-speed', 1, 0.3, 3),
		gestures: attrBool('data-gestures', false),
		badge: attrBool('data-badge', true),
		zIndex: parseInt(attr('data-z-index', '2147483640'), 10) || 2147483640,
	};

	// ── DOM helpers ───────────────────────────────────────────────────────
	function setPositionStyles(el, pos) {
		// Clear any previous corner-anchor.
		el.style.top = el.style.bottom = el.style.left = el.style.right = '';
		var margin = '16px';
		switch (pos) {
			case 'top-left':     el.style.top = margin; el.style.left = margin; break;
			case 'top-right':    el.style.top = margin; el.style.right = margin; break;
			case 'bottom-left':  el.style.bottom = margin; el.style.left = margin; break;
			case 'bottom-right': // fallthrough
			default:             el.style.bottom = margin; el.style.right = margin; break;
		}
	}

	function buildSrc(opts) {
		var p = new URLSearchParams();
		if (opts.avatar) p.set('avatar', opts.avatar);
		p.set('controls', opts.controls);
		if (opts.autoplay) p.set('autoplay', 'true');
		if (opts.ground === false) p.set('ground', 'false');
		if (opts.orbit === false) p.set('orbit', 'false');
		if (opts.bg && opts.bg !== 'transparent') p.set('bg', opts.bg);
		if (opts.env && opts.env !== 'studio') p.set('env', opts.env);
		if (opts.speed && opts.speed !== 1) p.set('speed', String(opts.speed));
		if (opts.gestures) p.set('gestures', 'true');
		if (opts.badge === false) p.set('badge', 'false');
		return EMBED_ORIGIN + '/walk-embed?' + p.toString();
	}

	// ── State ─────────────────────────────────────────────────────────────
	var state = {
		iframe: null,
		container: null,
		options: Object.assign({}, defaults),
		listeners: {}, // event-name → array of host callbacks
	};

	// ── Event bridge ──────────────────────────────────────────────────────
	function emit(name, detail) {
		// Document-level CustomEvent so host code can listen with a one-liner.
		try {
			document.dispatchEvent(new CustomEvent(name, { detail: detail }));
		} catch (e) {}
		// Also fire any callbacks the host registered through the API.
		var arr = state.listeners[name];
		if (arr) {
			for (var i = 0; i < arr.length; i++) {
				try { arr[i](detail); } catch (e) {}
			}
		}
	}

	function onWindowMessage(e) {
		if (!state.iframe || e.source !== state.iframe.contentWindow) return;
		var msg = e.data;
		if (!msg || typeof msg !== 'object' || !msg.type) return;
		if (msg.type.indexOf('walk:') !== 0) return;
		emit(msg.type, msg);
	}

	function postToFrame(payload) {
		if (!state.iframe || !state.iframe.contentWindow) return;
		try {
			state.iframe.contentWindow.postMessage(payload, EMBED_ORIGIN);
		} catch (e) {}
	}

	// ── Mount / unmount ───────────────────────────────────────────────────
	function mount(target) {
		if (state.container) return state.container; // idempotent

		var host = document.body || document.documentElement;
		var container = document.createElement('div');
		container.className = 'three-walk-avatar-embed';
		container.style.position = 'fixed';
		container.style.width = state.options.width + 'px';
		container.style.height = state.options.height + 'px';
		container.style.zIndex = String(state.options.zIndex);
		container.style.pointerEvents = 'none'; // host page stays clickable
		container.style.background = 'transparent';
		setPositionStyles(container, state.options.position);

		var iframe = document.createElement('iframe');
		iframe.src = buildSrc(state.options);
		iframe.title = 'three.ws walking avatar';
		iframe.allow = 'accelerometer; gyroscope; xr-spatial-tracking';
		iframe.setAttribute('frameborder', '0');
		iframe.setAttribute('scrolling', 'no');
		iframe.style.width = '100%';
		iframe.style.height = '100%';
		iframe.style.border = '0';
		iframe.style.background = 'transparent';
		// Restore pointer events on the iframe itself so users can still
		// interact with the avatar if controls are enabled — only the
		// container's empty padding ignores clicks.
		iframe.style.pointerEvents = state.options.controls === 'none' ? 'none' : 'auto';

		container.appendChild(iframe);

		var mountTarget = target || host;
		if (typeof mountTarget === 'string') mountTarget = document.querySelector(mountTarget) || host;
		mountTarget.appendChild(container);

		state.iframe = iframe;
		state.container = container;

		window.addEventListener('message', onWindowMessage);
		return container;
	}

	function unmount() {
		window.removeEventListener('message', onWindowMessage);
		if (state.container && state.container.parentNode) {
			state.container.parentNode.removeChild(state.container);
		}
		state.iframe = null;
		state.container = null;
	}

	// ── Programmatic controller: ThreeWalkAvatar.embed(iframeOrSelector) ──────
	// Wraps an existing <iframe> (one the host rendered, or one mount() made) in
	// the full typed command/event API. Each controller is independent — you can
	// drive several embeds on one page. Listeners are scoped to the controller,
	// not the document, so they never collide with the auto-mount CustomEvents.
	function resolveIframe(target) {
		if (!target) return null;
		if (typeof target === 'string') {
			var el = document.querySelector(target);
			return el && el.tagName === 'IFRAME' ? el : null;
		}
		if (target.tagName === 'IFRAME') return target;
		// A wrapper element — find the iframe inside it (covers mount()'s container).
		if (target.querySelector) return target.querySelector('iframe');
		return null;
	}

	// Derive the origin we post commands to from the iframe's own src, so a
	// security-conscious controller never targets '*'. Falls back to the SDK's
	// own origin (same domain that served this script) when src is relative.
	function originForIframe(iframe) {
		try {
			var u = new URL(iframe.getAttribute('src') || iframe.src, location.href);
			return u.origin;
		} catch (e) {
			return EMBED_ORIGIN;
		}
	}

	function embed(target) {
		var iframe = resolveIframe(target);
		if (!iframe) {
			throw new Error('ThreeWalkAvatar.embed(): no <iframe> found for ' + target);
		}
		var origin = originForIframe(iframe);
		var listeners = {};   // event-name → [cb]
		var ready = null;     // last { avatarId, env } from walk:ready
		var destroyed = false;

		function fire(name, detail) {
			var arr = listeners[name];
			if (arr) for (var i = 0; i < arr.slice().length; i++) {
				try { arr[i](detail); } catch (e) {}
			}
		}

		function onMessage(e) {
			if (destroyed) return;
			// Source check is the real authentication: only this iframe's window.
			if (e.source !== iframe.contentWindow) return;
			var msg = e.data;
			if (!msg || typeof msg !== 'object') return;
			// Accept the typed envelope or the flat legacy shape.
			if (msg.channel != null && msg.channel !== CHANNEL) return;
			var type = msg.type;
			if (typeof type !== 'string' || type.indexOf('walk:') !== 0) return;
			if (type === OUT.ready) ready = { avatarId: msg.avatarId, env: msg.env };
			// Re-key to the short event name (ready/position/…); pass payload only.
			for (var name in OUT) {
				if (OUT[name] === type) { fire(name, msg); break; }
			}
		}
		window.addEventListener('message', onMessage);

		function send(type, payload) {
			if (destroyed || !iframe.contentWindow) return ctl;
			try { iframe.contentWindow.postMessage(envelope(type, payload), origin); } catch (e) {}
			return ctl;
		}

		var ctl = {
			iframe: iframe,
			// Lifecycle / events --------------------------------------------------
			on: function (name, cb) {
				(listeners[name] = listeners[name] || []).push(cb);
				// If we already saw ready, replay it to a late 'ready' subscriber.
				if (name === 'ready' && ready) { try { cb(ready); } catch (e) {} }
				return ctl;
			},
			off: function (name, cb) {
				var arr = listeners[name];
				if (!arr) return ctl;
				if (!cb) { listeners[name] = []; return ctl; }
				var i = arr.indexOf(cb);
				if (i >= 0) arr.splice(i, 1);
				return ctl;
			},
			// Re-request the ready handshake (useful if you attached after load).
			ping: function () { return send('walk:ping'); },
			isReady: function () { return !!ready; },
			getReady: function () { return ready ? Object.assign({}, ready) : null; },
			// Commands ------------------------------------------------------------
			goto: function (x, z) { return send('walk:goto', { x: Number(x) || 0, z: Number(z) || 0 }); },
			move: function (x, y, run) {
				return send('walk:move', { x: Number(x) || 0, y: Number(y) || 0, run: !!run });
			},
			gesture: function (g) { return send('walk:gesture', { gesture: g }); },
			say: function (text, voice, durationMs) {
				return send('walk:say', { text: String(text == null ? '' : text), voice: voice, durationMs: durationMs });
			},
			setEnv: function (env) { return send('walk:env', { env: env }); },
			setAvatar: function (avatarId) { return send('walk:avatar', { avatarId: avatarId }); },
			config: function (opts) { return send('walk:config', opts || {}); },
			reset: function () { return send('walk:reset'); },
			// Teardown ------------------------------------------------------------
			destroy: function () {
				if (destroyed) return;
				destroyed = true;
				window.removeEventListener('message', onMessage);
				listeners = {};
			},
		};

		// Kick the handshake in case the iframe finished loading before we
		// attached our message listener (mounting an already-loaded iframe).
		ctl.ping();
		return ctl;
	}

	// ── Public API ────────────────────────────────────────────────────────
	var API = {
		// Programmatic controller (preferred for app integrations).
		embed: embed,
		// Vocabulary — lets hosts feature-detect / build pickers.
		protocol: Object.freeze({
			channel: CHANNEL,
			version: PROTOCOL_VERSION,
			outboundEvents: OUT_NAMES.slice(),
			environments: ENV_IDS.slice(),
			gestures: GESTURE_IDS.slice(),
			controls: CONTROL_MODES.slice(),
		}),
		// One-tag floating-avatar API (auto-mount path).
		mount: mount,
		unmount: unmount,
		setAvatar: function (id) {
			state.options.avatar = id || '';
			postToFrame(envelope('walk:avatar', { avatarId: id }));
		},
		setMotion: function (motion) {
			postToFrame(envelope('walk:gesture', { gesture: motion }));
		},
		gesture: function (g) {
			postToFrame(envelope('walk:gesture', { gesture: g }));
		},
		goto: function (x, z) {
			postToFrame(envelope('walk:goto', { x: Number(x) || 0, z: Number(z) || 0 }));
		},
		say: function (text, voice, durationMs) {
			postToFrame(envelope('walk:say', { text: String(text == null ? '' : text), voice: voice, durationMs: durationMs }));
		},
		config: function (opts) {
			postToFrame(envelope('walk:config', opts || {}));
		},
		setSize: function (w, h) {
			state.options.width = w;
			state.options.height = h;
			if (state.container) {
				state.container.style.width = w + 'px';
				state.container.style.height = h + 'px';
			}
		},
		setPosition: function (pos) {
			state.options.position = pos;
			if (state.container) setPositionStyles(state.container, pos);
		},
		resetPose: function () {
			postToFrame(envelope('walk:reset'));
		},
		setEnv: function (env) {
			state.options.env = env || 'studio';
			postToFrame(envelope('walk:env', { env: env }));
		},
		on: function (name, cb) {
			(state.listeners[name] = state.listeners[name] || []).push(cb);
		},
		off: function (name, cb) {
			var arr = state.listeners[name];
			if (!arr) return;
			var i = arr.indexOf(cb);
			if (i >= 0) arr.splice(i, 1);
		},
		// Read-only snapshot — useful for hosts that want to reconfigure
		// before re-mounting under a different container.
		getOptions: function () { return Object.assign({}, state.options); },
	};

	// Expose globally. Don't clobber if some other copy of the SDK already
	// loaded (e.g. inline script tag race) — keep the first one in charge.
	if (!window.ThreeWalkAvatar) {
		window.ThreeWalkAvatar = API;
	}

	// ── Auto-mount ────────────────────────────────────────────────────────
	// Default behavior: if the script tag carries any of the embed's data-*
	// attributes, auto-mount a floating avatar on DOM ready. A bare
	// `<script src=…>` (e.g. a page that only wants the embed() controller for an
	// iframe it rendered itself) mounts nothing. `data-auto="false"` opts out
	// explicitly even when data-* attributes are present.
	function hasEmbedDataAttr() {
		if (!SCRIPT) return false;
		var keys = ['data-avatar', 'data-position', 'data-width', 'data-height',
			'data-controls', 'data-env', 'data-autoplay', 'data-ground', 'data-orbit',
			'data-bg', 'data-speed', 'data-gestures', 'data-badge', 'data-z-index'];
		for (var i = 0; i < keys.length; i++) {
			if (SCRIPT.getAttribute(keys[i]) != null) return true;
		}
		return false;
	}
	var autoMount = attr('data-auto', null) === 'true' || (attr('data-auto', null) !== 'false' && hasEmbedDataAttr());
	if (autoMount) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', function () { mount(); });
		} else {
			mount();
		}
	}
})();
