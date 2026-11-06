// WorldHudSystem — the W10 layer composed into one object the /play client owns.
//
// It bundles the unified HUD (cash/health/wanted/objective/minimap/speedo), the
// camera rig (follow/vehicle/aim/first-person + collision + shake), the radial
// interaction menu ("M") and weapon/emote wheels, and the game-feel layer
// (vignette/money pops/flourish/SFX/haptics) — and wires the menus to real host
// actions. Sibling briefs push data through `system.hud`; the host drives the
// camera + minimap each frame and routes input through the open-menu guards.

import { WorldHud } from './world-hud.js';
import { CameraRig } from './camera-rig.js';
import { GameFeel } from './game-feel.js';
import { RadialMenu } from './radial-menu.js';

export class WorldHudSystem {
	/**
	 * @param {import('three').PerspectiveCamera} camera
	 * @param {object} opts
	 * @param {object} opts.actions   host action callbacks (only wired items appear)
	 * @param {() => Array} [opts.getEmotes]  () => [{ name, icon, label }]
	 * @param {() => Array} [opts.getHotbar]  () => [{ slot, glyph, name, qty, active, empty }]
	 */
	constructor(camera, { actions = {}, getEmotes, getHotbar } = {}) {
		this.actions = actions;
		this.getEmotes = getEmotes || (() => []);
		this.getHotbar = getHotbar || (() => []);

		this.feel = new GameFeel();
		this.hud = new WorldHud();
		this.camera = new CameraRig(camera, { baseFov: camera.fov });

		// One radial component per role. They share chrome but differ in open style.
		this.interaction = new RadialMenu({
			id: 'wh-interaction', title: 'Interaction', mode: 'toggle',
			onSelect: (it) => { this.feel.sfx('confirm'); it.action?.(); },
			onClose: () => this.feel.sfx('back'),
		});
		this.weaponWheel = new RadialMenu({
			id: 'wh-weapon', title: 'Weapons', mode: 'hold',
			onSelect: (it) => { this.feel.sfx('confirm'); it.action?.(); },
		});
		this.emoteWheel = new RadialMenu({
			id: 'wh-emotes', title: 'Emotes', mode: 'hold',
			onSelect: (it) => { this.feel.sfx('confirm'); it.action?.(); },
		});

		// Tick a soft SFX as focus moves across any wheel.
		for (const menu of [this.interaction, this.weaponWheel, this.emoteWheel]) {
			const orig = menu._setFocus.bind(menu);
			menu._setFocus = (i) => { if (i !== menu.focus && i >= 0) this.feel.sfx('tick'); orig(i); };
		}

		// On-screen entry to the radial menu — the touch path to everything inside it
		// (emotes, camera, sound, leave), and a discoverability hint on desktop.
		this.menuBtn = document.createElement('button');
		this.menuBtn.type = 'button';
		this.menuBtn.className = 'wh-menu-btn';
		this.menuBtn.title = 'Interaction menu (M)';
		this.menuBtn.setAttribute('aria-label', 'Open interaction menu');
		this.menuBtn.textContent = '☰';
		this.menuBtn.addEventListener('click', () => this.toggleInteraction());
		this.hud.root.appendChild(this.menuBtn);
	}

	// --------------------------------------------------------------- menu state
	isInteractionOpen() { return this.interaction.isOpen; }
	isWheelOpen() { return this.weaponWheel.isOpen || this.emoteWheel.isOpen; }
	isMenuOpen() { return this.isInteractionOpen() || this.isWheelOpen(); }

	closeMenus() { this.interaction.close(); this.weaponWheel.close(); this.emoteWheel.close(); }

	// ------------------------------------------------------------ interaction M
	toggleInteraction() {
		if (this.interaction.isOpen) { this.interaction.close(); return; }
		this.weaponWheel.close(); this.emoteWheel.close();
		this.feel.sfx('open');
		this.feel.haptic(10);
		this.interaction.open(this._interactionItems());
	}

	_interactionItems() {
		const a = this.actions;
		const items = [];
		if (a.openCharacter) items.push({ id: 'character', icon: '🧍', label: 'Character', short: 'Character', action: a.openCharacter });
		if (a.openMissions) items.push({ id: 'missions', icon: '🎯', label: 'Missions', short: 'Missions', action: a.openMissions });
		if (a.openCrew) items.push({ id: 'crew', icon: '👥', label: 'Crew', short: 'Crew', action: a.openCrew });
		if (this.getEmotes().length) items.push({ id: 'emotes', icon: '😄', label: 'Emotes', short: 'Emotes', action: () => this.openEmoteWheel() });
		items.push({
			id: 'camera', icon: '🎥',
			label: this.camera.isFirstPerson() ? 'Camera: First-person' : 'Camera: Third-person',
			short: 'Camera', action: () => { this.camera.toggleFirstPerson(); this.feel.sfx('select'); },
		});
		items.push({
			id: 'sound', icon: this.feel.isMuted() ? '🔇' : '🔊',
			label: this.feel.isMuted() ? 'Sound: Off' : 'Sound: On',
			short: 'Sound', action: () => { this.feel.setMuted(!this.feel.isMuted()); if (!this.feel.isMuted()) this.feel.sfx('select'); },
		});
		if (a.openSettings) items.push({ id: 'settings', icon: '⚙️', label: 'Settings', short: 'Settings', action: a.openSettings });
		if (a.leave) items.push({ id: 'leave', icon: '🚪', label: 'Leave world', short: 'Leave', color: '#ff7a7a', action: a.leave });
		return items;
	}

	// ----------------------------------------------------------- weapon wheel Q
	openWeaponWheel() {
		if (this.isMenuOpen()) return;
		const items = this._hotbarItems();
		if (!items.length) return;          // nothing to quick-select — stay silent
		this.feel.sfx('open');
		this.weaponWheel.open(items);
	}
	releaseWeaponWheel() { this.weaponWheel.release(); }

	_hotbarItems() {
		const hb = this.getHotbar() || [];
		return hb.map((s, i) => ({
			id: 'slot' + i, icon: s.empty ? '·' : (s.glyph || '▢'),
			label: s.empty ? 'Empty' : (s.name || 'Item'),
			short: s.empty ? '—' : (s.name || ''),
			hint: s.qty > 1 ? `×${s.qty}` : '',
			disabled: s.empty,
			action: () => this.actions.equipSlot?.(i),
		}));
	}

	// ------------------------------------------------------------- emote wheel
	openEmoteWheel() {
		const emotes = this.getEmotes() || [];
		if (!emotes.length) return;
		this.interaction.close();
		this.feel.sfx('open');
		this.emoteWheel.open(emotes.slice(0, 8).map((e) => ({
			id: 'emote-' + e.name, icon: e.icon || '🙂', label: e.label || e.name, short: e.label || e.name,
			action: () => this.actions.emote?.(e.name),
		})));
	}
	releaseEmoteWheel() { this.emoteWheel.release(); }

	dispose() {
		this.interaction.dispose();
		this.weaponWheel.dispose();
		this.emoteWheel.dispose();
		this.hud.dispose();
		this.feel.dispose();
	}
}
