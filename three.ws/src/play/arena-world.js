// arena-world.js — the live 3D trading floor.
//
// A single shared Three.js scene (one WebGL context, not N web components) that
// renders the leaderboard's agents as animated 3D avatars standing on a glowing
// arena floor, lets a spectator pick an avatar and walk through it in third
// person, and turns live trade events into emotes + particle FX.
//
// Reuses the platform's animation system: AnimationManager retargets the
// canonical Avaturn clip library onto any humanoid rig, so every avatar GLB —
// Ready Player Me, Mixamo, CharacterStudio — performs the same emotes.

import {
	Scene, PerspectiveCamera, WebGLRenderer, Group,
	AmbientLight, DirectionalLight, PointLight, HemisphereLight,
	PMREMGenerator, Color, Fog, Vector3, Box3,
	CircleGeometry, RingGeometry, TorusGeometry, CylinderGeometry, BoxGeometry, PlaneGeometry,
	MeshStandardMaterial, MeshBasicMaterial, Mesh, DoubleSide,
	BufferGeometry, BufferAttribute, Points, PointsMaterial, AdditiveBlending,
	Sprite, SpriteMaterial, CanvasTexture, MathUtils, LoopOnce, LoopRepeat,
	SRGBColorSpace, ACESFilmicToneMapping,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationManager } from '../animation-manager.js';
import { gltfLoader } from '../loaders/gltf.js';
import { normalizeFloor } from '../shared/mm-render.js';

const MANIFEST_URL = '/animations/manifest.json';

// The lean, expressive clip set. Loaded once into a shared library and injected
// into every avatar so each clip is fetched + parsed a single time. Sizes were
// chosen for fast first paint (idle/walk/buy/win/loss all < 1.1 MB).
const CLIPS = {
	idle: 'idle',             // full-body resting idle (arms down — NOT the torso-only breath)
	walk: 'walk',             // spectator locomotion
	buy: 'wave',              // a wave when an agent opens a position
	win: 'celebrate',         // fist-pump on a profitable close
	bigWin: 'av-back-flip',   // reserved for monster wins (lazy-loaded)
	loss: 'defeated',         // a slump on a losing close
	dance: 'dance',           // ambient flair for the leader
};
const CORE_CLIPS = ['idle', 'walk', 'buy', 'win', 'loss', 'dance'].map((k) => CLIPS[k]);

const PALETTE = {
	bg: 0x06070d,
	fog: 0x06070d,
	floor: 0x0a0c15,
	cyan: 0x6ee7ff,
	violet: 0x9a7bff,
	gold: 0xfbbf24,
	up: 0x34d399,
	down: 0xf87171,
};

// Coin World Tour waypoints — the fixed loop the guide agent walks (driven by the
// Playwright caster via window.__tour, see src/play/arena.js + src/tour-commentary.js).
// Each is a floor position inside the arena radius (<15) plus the heading to face
// on arrival. Names are the canonical keys shared with TOUR_WAYPOINTS; geometry
// lives here because it's a 3D concern.
const TOUR_STOPS = {
	lobby:    { x: 0,    z: 6.8,  face: Math.PI },          // entrance, looking into the arena
	approach: { x: -3.4, z: 2.6,  face: Math.PI * 0.86 },   // crossing the open floor
	arena:    { x: 0,    z: -0.6, face: 0 },                // centre, among the agents
	leader:   { x: 0,    z: -3.4, face: 0 },                // up at the #1 leader pad
	eastwing: { x: 5.6,  z: -0.2, face: -Math.PI / 2 },     // along the east ring, then loop back
};

export class ArenaWorld {
	constructor(canvas, { onAgentClick } = {}) {
		this.canvas = canvas;
		this.onAgentClick = onAgentClick || (() => {});
		this.agents = new Map();   // id -> ArenaAvatar
		this.player = null;        // ArenaAvatar (spectator)
		this._fx = [];             // transient effects with .tick(dt) -> done
		this._templates = new Map(); // glbUrl -> Promise<gltf>
		this._lib = null;          // AnimationManager holding shared canonical clips
		this._loopByName = new Map();
		this._defs = [];
		this._clock = { last: 0 };
		this._running = false;
		this._raf = 0;
		this._labels = new Set();  // ArenaAvatar with DOM labels to project
		this._floors = new Map();  // agentId -> market-maker floor-defense viz
		this._focus = null;        // { x, z, dist, until } cinematic agent focus
		this._tour = null;         // active Coin World Tour goal { name, x, z, face, resolve, deadline }
		this._tourLoc = 'lobby';   // last waypoint the guide reached

		this._initRenderer();
		this._initScene();
		this._initControls();
		this._onResize = this._onResize.bind(this);
		window.addEventListener('resize', this._onResize);
	}

	// ── Renderer / scene ──────────────────────────────────────────────────────

	_initRenderer() {
		const r = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
		r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		r.setSize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight, false);
		r.shadowMap.enabled = true;
		r.outputColorSpace = SRGBColorSpace;
		r.toneMapping = ACESFilmicToneMapping;
		r.toneMappingExposure = 1.05;
		this.renderer = r;
		this.loader = gltfLoader(r);
	}

	_initScene() {
		const scene = new Scene();
		scene.background = new Color(PALETTE.bg);
		scene.fog = new Fog(PALETTE.fog, 16, 46);
		const pmrem = new PMREMGenerator(this.renderer);
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
		this.scene = scene;

		const cam = new PerspectiveCamera(46, this._aspect(), 0.1, 200);
		cam.position.set(0, 4.4, 12.5);
		cam.lookAt(0, 1.4, -2);
		this.camera = cam;

		// Lighting — soft fill + a warm key that casts shadows + cyan/violet rims.
		scene.add(new HemisphereLight(0xbcd2ff, 0x0a0a12, 0.55));
		scene.add(new AmbientLight(0xffffff, 0.25));
		const key = new DirectionalLight(0xfff3e0, 1.15);
		key.position.set(6, 14, 8);
		key.castShadow = true;
		key.shadow.mapSize.set(2048, 2048);
		key.shadow.camera.near = 1; key.shadow.camera.far = 60;
		key.shadow.camera.left = -18; key.shadow.camera.right = 18;
		key.shadow.camera.top = 18; key.shadow.camera.bottom = -18;
		key.shadow.bias = -0.0004;
		scene.add(key);
		const rimA = new PointLight(PALETTE.cyan, 22, 40, 2.0); rimA.position.set(-11, 5, -6); scene.add(rimA);
		const rimB = new PointLight(PALETTE.violet, 22, 40, 2.0); rimB.position.set(11, 5, -6); scene.add(rimB);

		this._buildArena();
		this._buildAtmosphere();
	}

	_buildArena() {
		const g = new Group();
		// Main disc.
		const disc = new Mesh(
			new CircleGeometry(16, 96),
			new MeshStandardMaterial({ color: PALETTE.floor, roughness: 0.55, metalness: 0.7 }),
		);
		disc.rotation.x = -Math.PI / 2;
		disc.receiveShadow = true;
		g.add(disc);

		// Concentric glowing rings.
		const ringColors = [PALETTE.cyan, PALETTE.violet, PALETTE.cyan];
		[6.2, 10.4, 14.6].forEach((rad, i) => {
			const ring = new Mesh(
				new TorusGeometry(rad, 0.022, 8, 160),
				new MeshBasicMaterial({ color: ringColors[i % ringColors.length] }),
			);
			ring.rotation.x = -Math.PI / 2;
			ring.position.y = 0.012;
			ring.material.transparent = true;
			ring.material.opacity = 0.5 - i * 0.08;
			g.add(ring);
			this._pulseRings = this._pulseRings || [];
			this._pulseRings.push({ mesh: ring, base: ring.material.opacity, phase: i * 1.3 });
		});

		// Radial spokes (faint).
		const spokes = new Group();
		for (let i = 0; i < 24; i++) {
			const a = (i / 24) * Math.PI * 2;
			const bar = new Mesh(
				new CylinderGeometry(0.006, 0.006, 9.6, 4),
				new MeshBasicMaterial({ color: PALETTE.cyan, transparent: true, opacity: 0.06 }),
			);
			bar.rotation.z = Math.PI / 2;
			bar.position.set(Math.cos(a) * 9.6, 0.011, Math.sin(a) * 9.6);
			bar.rotation.y = -a;
			spokes.add(bar);
		}
		g.add(spokes);
		this.scene.add(g);
		this.arena = g;
	}

	_buildAtmosphere() {
		// Drifting embers for depth.
		const COUNT = 240;
		const pos = new Float32Array(COUNT * 3);
		this._emberSeed = [];
		for (let i = 0; i < COUNT; i++) {
			const r = 4 + Math.random() * 16;
			const a = Math.random() * Math.PI * 2;
			pos[i * 3] = Math.cos(a) * r;
			pos[i * 3 + 1] = Math.random() * 9;
			pos[i * 3 + 2] = Math.sin(a) * r;
			this._emberSeed.push({ speed: 0.1 + Math.random() * 0.25, sway: Math.random() * Math.PI * 2 });
		}
		const geo = new BufferGeometry();
		geo.setAttribute('position', new BufferAttribute(pos, 3));
		const mat = new PointsMaterial({ color: 0x8fbfff, size: 0.05, transparent: true, opacity: 0.5, depthWrite: false, blending: AdditiveBlending });
		const pts = new Points(geo, mat);
		this.scene.add(pts);
		this.embers = pts;
	}

	// A glowing pad an avatar stands on. #1 gets a gold, taller pad.
	_buildPad(color, leader = false) {
		const grp = new Group();
		const h = leader ? 0.34 : 0.12;
		const base = new Mesh(
			new CylinderGeometry(leader ? 1.5 : 1.25, leader ? 1.65 : 1.32, h, 48),
			new MeshStandardMaterial({ color: 0x10131f, roughness: 0.4, metalness: 0.85, emissive: new Color(color), emissiveIntensity: 0.12 }),
		);
		base.position.y = h / 2;
		base.receiveShadow = true;
		base.castShadow = true;
		grp.add(base);
		const halo = new Mesh(
			new RingGeometry(leader ? 1.5 : 1.26, leader ? 1.72 : 1.42, 64),
			new MeshBasicMaterial({ color, transparent: true, opacity: leader ? 0.9 : 0.6, side: DoubleSide }),
		);
		halo.rotation.x = -Math.PI / 2;
		halo.position.y = h + 0.005;
		grp.add(halo);
		grp.userData.halo = halo;
		grp.userData.padHeight = h;
		return grp;
	}

	// ── Animation library ─────────────────────────────────────────────────────

	async loadAnimations() {
		const defs = await fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
		this._defs = Array.isArray(defs) ? defs : [];
		for (const d of this._defs) this._loopByName.set(d.name, d.loop !== false);

		const lib = new AnimationManager();
		lib.setAnimationDefs(this._defs);
		// Preload the core set once (no model attached → clips cached, no actions).
		await Promise.all(CORE_CLIPS.map((name) => {
			const def = this._defs.find((d) => d.name === name);
			return def ? lib.loadAnimation(def.name, def.url, { loop: this._loopByName.get(name) }).catch(() => {}) : null;
		}));
		this._lib = lib;
	}

	// Lazy-load an extra clip into the shared library (e.g. the big-win backflip).
	async ensureLibClip(name) {
		if (!this._lib) return false;
		if (this._lib.clips.has(name)) return true;
		const def = this._defs.find((d) => d.name === name);
		if (!def) return false;
		try { await this._lib.loadAnimation(def.name, def.url, { loop: this._loopByName.get(name) }); return true; }
		catch { return false; }
	}

	// ── Avatar templates ──────────────────────────────────────────────────────

	_loadTemplate(url) {
		if (this._templates.has(url)) return this._templates.get(url);
		const p = this.loader.loadAsync(url);
		this._templates.set(url, p);
		return p;
	}

	_loadTemplateTimed(url, ms) {
		return Promise.race([
			this._loadTemplate(url),
			new Promise((_, rej) => setTimeout(() => rej(new Error('glb timeout: ' + url)), ms)),
		]);
	}

	// Load a GLB, falling back to a light known-good rig if the chosen one fails
	// or stalls — so a crowd never ends up with a missing body.
	async _makeAvatar(glbUrl, { fallback = '/avatars/mannequin.glb', timeout = 20000 } = {}) {
		let gltf;
		let loadedUrl = glbUrl;
		try { gltf = await this._loadTemplateTimed(glbUrl, timeout); }
		catch { gltf = await this._loadTemplate(fallback); loadedUrl = fallback; }
		// Clone so multiple agents can share one downloaded GLB.
		const model = cloneSkeleton(gltf.scene);
		model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
		return new ArenaAvatar(model, this._lib, this._loopByName, CLIPS, loadedUrl);
	}

	// ── Spawning ──────────────────────────────────────────────────────────────

	async spawnAgent(cfg) {
		// cfg: { id, name, glbUrl, position:[x,z], facingY, leader, color, pnlText, pnlUp, thumbnail, rank }
		const avatar = await this._makeAvatar(cfg.glbUrl);
		const color = cfg.color ?? (cfg.leader ? PALETTE.gold : PALETTE.cyan);
		const pad = this._buildPad(color, !!cfg.leader);
		const root = new Group();
		root.position.set(cfg.position[0], 0, cfg.position[1]);
		root.rotation.y = cfg.facingY ?? 0;
		avatar.object.position.y = pad.userData.padHeight;
		root.add(pad);
		root.add(avatar.object);
		this.scene.add(root);

		avatar.root = root;
		avatar.pad = pad;
		avatar.id = cfg.id;
		avatar.name = cfg.name;
		avatar.leader = !!cfg.leader;
		avatar.color = color;
		avatar.idle();

		// DOM label data.
		avatar.label = { name: cfg.name, pnlText: cfg.pnlText, pnlUp: cfg.pnlUp, thumbnail: cfg.thumbnail, rank: cfg.rank };
		avatar.headHeight = avatar.measureHeadHeight() + pad.userData.padHeight;
		this.agents.set(cfg.id, avatar);
		this._labels.add(avatar);
		return avatar;
	}

	async spawnPlayer(glbUrl) {
		if (this.player) { this._removeAvatar(this.player); this.player = null; }
		const avatar = await this._makeAvatar(glbUrl);
		const root = new Group();
		root.position.set(0, 0, 5.6);  // just inside the entrance, facing the arena
		root.rotation.y = Math.PI;
		root.add(avatar.object);
		this.scene.add(root);
		avatar.root = root;
		avatar.isPlayer = true;
		avatar.idle();
		this.player = avatar;
		// Camera sits behind the spectator (+Z) looking into the arena (−Z).
		this._cam.targetYaw = 0;
		this._cam.yaw = 0;
		return avatar;
	}

	_removeAvatar(avatar) {
		if (!avatar) return;
		this._labels.delete(avatar);
		if (avatar.id) this._removeFloor(avatar.id);
		if (avatar.root) this.scene.remove(avatar.root);
		avatar.dispose();
		if (avatar.id) this.agents.delete(avatar.id);
	}

	clearAgents() {
		for (const a of [...this.agents.values()]) this._removeAvatar(a);
		this.agents.clear();
	}

	// ── Reactions / FX ────────────────────────────────────────────────────────

	reactBuy(agentId, { amountText } = {}) {
		const a = this.agents.get(agentId);
		if (a) a.emote('buy');
		const at = a ? a.worldHead() : new Vector3(0, 2, 0);
		this._spawnCoin(at, { text: amountText || 'BUY', color: PALETTE.cyan, dir: 1 });
		this._ringPulse(a?.root?.position, PALETTE.cyan);
	}

	async reactSell(agentId, { win, big, pnlText } = {}) {
		const a = this.agents.get(agentId);
		if (a) {
			if (win && big) { await this.ensureLibClip(CLIPS.bigWin); a.emote('bigWin'); }
			else a.emote(win ? 'win' : 'loss');
		}
		const at = a ? a.worldHead() : new Vector3(0, 2, 0);
		const color = win ? PALETTE.up : PALETTE.down;
		this._spawnCoin(at, { text: pnlText, color, dir: win ? 1 : -1 });
		if (win) this._confetti(at, big);
		this._ringPulse(a?.root?.position, color);
	}

	_spawnCoin(pos, { text, color, dir }) {
		const tex = makeLabelTexture(text, color);
		const spr = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
		spr.scale.set(1.6, 0.8, 1);
		spr.position.copy(pos).add(new Vector3((Math.random() - 0.5) * 0.4, 0.3, 0));
		spr.renderOrder = 10;
		this.scene.add(spr);
		const life = 1.6;
		let t = 0;
		this._fx.push({
			tick: (dt) => {
				t += dt;
				const k = t / life;
				spr.position.y += dt * 1.5 * dir + dt * 0.6;
				spr.material.opacity = 1 - k;
				const s = 1 + k * 0.5;
				spr.scale.set(1.6 * s, 0.8 * s, 1);
				if (t >= life) { this.scene.remove(spr); spr.material.map.dispose(); spr.material.dispose(); return true; }
				return false;
			},
		});
	}

	_confetti(pos, big = false) {
		const COUNT = big ? 220 : 110;
		const positions = new Float32Array(COUNT * 3);
		const vel = [];
		const colors = new Float32Array(COUNT * 3);
		const pick = [PALETTE.cyan, PALETTE.violet, PALETTE.gold, PALETTE.up, 0xffffff];
		for (let i = 0; i < COUNT; i++) {
			positions[i * 3] = pos.x; positions[i * 3 + 1] = pos.y; positions[i * 3 + 2] = pos.z;
			const a = Math.random() * Math.PI * 2;
			const up = (big ? 4.5 : 3.2) + Math.random() * 2.5;
			const spd = 1 + Math.random() * 3;
			vel.push(new Vector3(Math.cos(a) * spd, up, Math.sin(a) * spd));
			const c = new Color(pick[(Math.random() * pick.length) | 0]);
			colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
		}
		const geo = new BufferGeometry();
		geo.setAttribute('position', new BufferAttribute(positions, 3));
		geo.setAttribute('color', new BufferAttribute(colors, 3));
		const mat = new PointsMaterial({ size: big ? 0.14 : 0.1, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending });
		const pts = new Points(geo, mat);
		this.scene.add(pts);
		const life = 2.0; let t = 0;
		this._fx.push({
			tick: (dt) => {
				t += dt;
				const arr = geo.attributes.position.array;
				for (let i = 0; i < COUNT; i++) {
					const v = vel[i];
					v.y -= 9.8 * dt;
					arr[i * 3] += v.x * dt; arr[i * 3 + 1] += v.y * dt; arr[i * 3 + 2] += v.z * dt;
				}
				geo.attributes.position.needsUpdate = true;
				mat.opacity = Math.max(0, 1 - t / life);
				if (t >= life) { this.scene.remove(pts); geo.dispose(); mat.dispose(); return true; }
				return false;
			},
		});
	}

	_ringPulse(center, color) {
		const c = center || new Vector3();
		const ring = new Mesh(
			new RingGeometry(0.6, 0.78, 48),
			new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: DoubleSide, blending: AdditiveBlending, depthWrite: false }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.set(c.x, 0.02, c.z);
		this.scene.add(ring);
		const life = 0.9; let t = 0;
		this._fx.push({
			tick: (dt) => {
				t += dt; const k = t / life;
				const s = 1 + k * 6;
				ring.scale.set(s, s, s);
				ring.material.opacity = 0.85 * (1 - k);
				if (t >= life) { this.scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); return true; }
				return false;
			},
		});
	}

	// ── Market-Maker Floor Defense ────────────────────────────────────────────
	// A glowing horizontal line in front of an agent draws the coin's price floor;
	// a marker rides above it at a height set by price/floor and descends to touch
	// the line as the price approaches the floor. Driven entirely by mm events the
	// agent-mm worker publishes — the render layer never signs or moves funds.

	// Height (world Y) the price marker should sit at for a given floor/price. At
	// or below the floor it touches the line (LINE_Y); above it floats up.
	_markerHeight(floorSol, priceSol) {
		const LINE_Y = 0.07;
		if (!(floorSol > 0) || !(priceSol > 0)) return LINE_Y + 1.0; // unknown — hover mid
		const up = Math.max(0, priceSol / floorSol - 1); // 0 = exactly at the floor
		return LINE_Y + Math.min(2.2, up * 6);
	}

	_buildFloorViz(avatar, { floorSol, priceSol }, simulate) {
		const grp = new Group();
		const at = avatar.root.position;
		grp.position.set(at.x, 0, at.z + 1.7); // just in front of the avatar, toward the viewer

		// Soft glow pad beneath the line.
		const glow = new Mesh(
			new PlaneGeometry(3.4, 0.6),
			new MeshBasicMaterial({ color: PALETTE.cyan, transparent: true, opacity: 0.12, side: DoubleSide, blending: AdditiveBlending, depthWrite: false }),
		);
		glow.rotation.x = -Math.PI / 2;
		glow.position.y = 0.05;
		grp.add(glow);

		// The floor line itself — a thin emissive bar lying across the deck.
		const line = new Mesh(
			new BoxGeometry(3.0, 0.016, 0.06),
			new MeshBasicMaterial({ color: PALETTE.cyan, transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false }),
		);
		line.position.y = 0.07;
		grp.add(line);

		// The price marker — a glowing coin that dances above the line.
		const marker = new Sprite(new SpriteMaterial({ map: makeLabelTexture('◎', PALETTE.gold), transparent: true, depthTest: false, blending: AdditiveBlending }));
		marker.scale.set(0.5, 0.5, 1);
		marker.position.set(0, this._markerHeight(floorSol, priceSol), 0);
		marker.renderOrder = 11;
		grp.add(marker);

		// SIM badge — so a dry-run is never mistaken for a real fill.
		const simBadge = new Sprite(new SpriteMaterial({ map: makeLabelTexture('SIM', PALETTE.violet), transparent: true, depthTest: false }));
		simBadge.scale.set(0.7, 0.35, 1);
		simBadge.position.set(1.55, 0.2, 0);
		simBadge.visible = !!simulate;
		simBadge.renderOrder = 11;
		grp.add(simBadge);

		this.scene.add(grp);
		return {
			group: grp, glow, line, marker, simBadge,
			floorSol: floorSol || 0, priceSol: priceSol || 0, simulate: !!simulate,
			targetY: this._markerHeight(floorSol, priceSol), flash: 0, amber: 0,
		};
	}

	// Create or update an agent's floor line + price marker. Lazily builds the viz
	// the first time it's called for a spawned agent; later calls lerp the marker.
	setFloor(agentId, { floorSol, priceSol, simulate = false } = {}) {
		const a = this.agents.get(agentId);
		if (!a || !a.root) return;
		const norm = normalizeFloor({ floorSol, priceSol });
		let f = this._floors.get(agentId);
		if (!f) {
			f = this._buildFloorViz(a, norm, simulate);
			this._floors.set(agentId, f);
		}
		if (norm.floorSol > 0) f.floorSol = norm.floorSol;
		if (norm.priceSol > 0) f.priceSol = norm.priceSol;
		f.simulate = !!simulate;
		if (f.simBadge) f.simBadge.visible = !!simulate;
		f.targetY = this._markerHeight(f.floorSol, f.priceSol);
		// A fresh quote clears the "re-quoting" amber state.
		f.amber = 0;
		return f;
	}

	// Amber the floor line while a quote/RPC read is failing (the line holds the
	// last known price; the consumer calls this on a stream error and clears it on
	// the next good event via setFloor).
	markFloorReQuoting(agentId) {
		const f = this._floors.get(agentId);
		if (f) f.amber = 1;
	}

	// Route one MM event onto an agent: update the floor/marker, then play the
	// reaction — defend lunges into a buy + flashes the line, recycle sweeps both
	// sides, graduate celebrates with a big-win + LP burst.
	onMmEvent(agentId, ev = {}) {
		if (!ev) return;
		const type = ev.type || ev.actionType;
		const f = this.setFloor(agentId, { floorSol: ev.floorSol, priceSol: ev.priceSol, simulate: ev.simulate });
		const a = this.agents.get(agentId);
		const at = a ? a.worldHead() : new Vector3(0, 2, 0);
		switch (type) {
			case 'mm_defend':
				if (a) a.emote('buy');
				this._spawnCoin(at, { text: 'DEFEND', color: PALETTE.up, dir: 1 });
				this._ringPulse(a?.root?.position, PALETTE.up);
				if (f) f.flash = 0.7;
				break;
			case 'mm_recycle':
				this._spawnCoin(at, { text: 'RECYCLE', color: PALETTE.cyan, dir: 1 });
				this._spawnCoin(at, { text: '◎', color: PALETTE.violet, dir: -1 });
				if (f) f.flash = 0.4;
				break;
			case 'mm_rebalance':
				this._spawnCoin(at, { text: 'TRIM', color: PALETTE.violet, dir: -1 });
				break;
			case 'mm_seed':
				this._spawnCoin(at, { text: 'SEED', color: PALETTE.cyan, dir: 1 });
				if (f) f.flash = 0.4;
				break;
			case 'mm_graduate':
				this.reactGraduate(agentId, at);
				if (f) f.flash = 0.9;
				break;
			default:
				break; // mm_quote — floor/marker already updated, no emote
		}
	}

	// Graduation celebration: the big-win backflip (lazy-loaded) + an LP-deposit burst.
	async reactGraduate(agentId, at) {
		const a = this.agents.get(agentId);
		const pos = at || (a ? a.worldHead() : new Vector3(0, 2, 0));
		if (a) { await this.ensureLibClip(CLIPS.bigWin); a.emote('bigWin'); }
		this._confetti(pos, true);
		this._spawnCoin(pos, { text: 'LP', color: PALETTE.gold, dir: 1 });
		this._ringPulse(a?.root?.position, PALETTE.gold);
	}

	// Advance every floor's marker lerp + line shimmer. Called from _tick.
	_tickFloors(dt, t) {
		for (const f of this._floors.values()) {
			f.marker.position.y += (f.targetY - f.marker.position.y) * Math.min(1, 4 * dt);
			f.marker.position.x = Math.sin(t * 1.5 + f.group.position.x) * 0.06;
			const touching = f.floorSol > 0 && f.priceSol > 0 && f.priceSol <= f.floorSol * 1.02;
			const pulse = 0.65 + 0.35 * Math.sin(t * 3 + f.group.position.x);
			const col = f.amber > 0 ? PALETTE.gold : (touching ? PALETTE.up : PALETTE.cyan);
			f.line.material.color.set(col);
			f.glow.material.color.set(col);
			const base = (touching ? 0.95 : 0.6);
			f.line.material.opacity = Math.min(1, base * pulse + (f.flash > 0 ? f.flash : 0));
			f.glow.material.opacity = 0.1 + (f.flash > 0 ? f.flash * 0.4 : 0) + (touching ? 0.08 : 0);
			if (f.flash > 0) f.flash = Math.max(0, f.flash - dt * 1.6);
		}
	}

	_removeFloor(agentId) {
		const f = this._floors.get(agentId);
		if (!f) return;
		this.scene.remove(f.group);
		f.group.traverse?.((o) => {
			if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
			if (o.isSprite) { o.material?.map?.dispose?.(); o.material?.dispose?.(); }
		});
		this._floors.delete(agentId);
	}

	// ── Controls (third-person follow) ────────────────────────────────────────

	_initControls() {
		this._cam = { yaw: 0, targetYaw: 0, pitch: 0.30, dist: 11, targetDist: 11 };
		this._keys = new Set();
		this._drag = null;
		this._move = { x: 0, y: 0 }; // joystick vector

		const el = this.canvas;
		this._onKeyDown = (e) => {
			const k = e.key.toLowerCase();
			if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { this._keys.add(k); }
		};
		this._onKeyUp = (e) => this._keys.delete(e.key.toLowerCase());
		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup', this._onKeyUp);

		el.addEventListener('pointerdown', (e) => {
			if (e.target.closest && e.target.closest('.no-orbit')) return;
			this._drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
			el.setPointerCapture?.(e.pointerId);
		});
		el.addEventListener('pointermove', (e) => {
			if (!this._drag || this._drag.id !== e.pointerId) return;
			const dx = e.clientX - this._drag.x;
			const dy = e.clientY - this._drag.y;
			this._drag.x = e.clientX; this._drag.y = e.clientY;
			this._cam.targetYaw -= dx * 0.005;
			this._cam.pitch = MathUtils.clamp(this._cam.pitch + dy * 0.004, -0.15, 0.7);
		});
		const endDrag = (e) => { if (this._drag && this._drag.id === e.pointerId) this._drag = null; };
		el.addEventListener('pointerup', endDrag);
		el.addEventListener('pointercancel', endDrag);
		el.addEventListener('wheel', (e) => {
			this._cam.targetDist = MathUtils.clamp(this._cam.targetDist + Math.sign(e.deltaY) * 0.7, 4, 15);
		}, { passive: true });

		// Click-to-select an agent (raycast handled in arena.js via projected labels).
	}

	// External joystick hook (nipplejs) sets a normalized vector.
	setJoystick(x, y) { this._move.x = x; this._move.y = y; }

	_updatePlayer(dt) {
		const p = this.player;
		if (!p) return;
		// Desired move in camera space.
		let mx = 0, mz = 0;
		if (this._keys.has('w') || this._keys.has('arrowup')) mz -= 1;
		if (this._keys.has('s') || this._keys.has('arrowdown')) mz += 1;
		if (this._keys.has('a') || this._keys.has('arrowleft')) mx -= 1;
		if (this._keys.has('d') || this._keys.has('arrowright')) mx += 1;
		mx += this._move.x; mz -= this._move.y;
		const mag = Math.hypot(mx, mz);
		// Coin World Tour autopilot: with no human at the controls, the guide walks
		// the waypoint loop. Any real key/joystick input cancels it and takes over.
		if (mag > 0.08 && this._tour) this.stopTour();
		else if (this._tour && this._updateTour(dt)) return;
		const moving = mag > 0.08;
		if (moving && this._focus) this._focus = null; // walking breaks a focus lock
		if (moving) {
			const len = Math.max(mag, 1);
			mx /= len; mz /= len;
			// Rotate input by camera yaw so "up" is away from camera.
			const cos = Math.cos(this._cam.yaw), sin = Math.sin(this._cam.yaw);
			const wx = mx * cos - mz * sin;
			const wz = mx * sin + mz * cos;
			const speed = 3.4 * dt;
			const nx = p.root.position.x + wx * speed;
			const nz = p.root.position.z + wz * speed;
			const r = Math.hypot(nx, nz);
			if (r < 15.2) { p.root.position.x = nx; p.root.position.z = nz; }
			// Face travel direction (smoothly).
			const targetFace = Math.atan2(wx, wz);
			p.root.rotation.y = dampAngle(p.root.rotation.y, targetFace, 12 * dt);
		}
		p.setMoving(moving);
	}

	// Cinematically push the camera in on one agent for a few seconds (opening
	// their detail drawer). Cleared early if the spectator starts walking.
	focusOnAgent(agentId, ms = 5000) {
		const a = this.agents.get(agentId);
		if (!a) return;
		const p = a.root.position;
		this._focus = { x: p.x, z: p.z, dist: a.leader ? 6.5 : 5.2, until: performance.now() + ms };
		// Swing the orbit so the camera ends up looking at the agent from the
		// spectator's side of the floor (agents are at −Z, viewer at +Z).
		this._cam.targetYaw = Math.atan2(p.x, p.z + 9) * 0.6;
	}
	clearFocus() { this._focus = null; }

	// ── Coin World Tour autopilot ─────────────────────────────────────────────
	// The guide agent walks a deterministic waypoint loop. The Playwright caster
	// drives this through window.__tour (src/play/arena.js); a human spectator at a
	// keyboard never triggers it, and any manual input instantly yields control.

	tourStops() { return Object.keys(TOUR_STOPS); }
	tourLocation() { return this._tourLoc; }

	// Walk the spectator avatar to a named waypoint. Resolves when it arrives (or a
	// watchdog fires, so the caster never deadlocks on an unreachable stop). The
	// real camera + avatar move — no faked motion.
	tourGoTo(name) {
		const stop = TOUR_STOPS[name];
		if (!stop || !this.player) return Promise.resolve(false);
		// Supersede any in-flight goal (resolve it so its awaiter unblocks).
		if (this._tour?.resolve) this._tour.resolve(false);
		return new Promise((resolve) => {
			this._focus = null; // a moving guide can't hold a cinematic focus lock
			this._tour = { name, x: stop.x, z: stop.z, face: stop.face ?? 0, resolve, deadline: performance.now() + 9000 };
		});
	}

	stopTour() {
		if (this._tour?.resolve) this._tour.resolve(false);
		this._tour = null;
		this.player?.setMoving(false);
	}

	// Drive the avatar one step toward the active tour goal. Returns true if it
	// consumed this frame's movement (so manual control is skipped).
	_updateTour(dt) {
		const t = this._tour;
		const p = this.player;
		if (!t || !p) return false;
		let dx = t.x - p.root.position.x;
		let dz = t.z - p.root.position.z;
		const dist = Math.hypot(dx, dz);
		const arrived = dist < 0.25;
		const timedOut = performance.now() > t.deadline;
		if (arrived || timedOut) {
			this._tourLoc = t.name;
			p.root.rotation.y = dampAngle(p.root.rotation.y, t.face, 10 * dt);
			p.setMoving(false);
			this._tour = null;
			t.resolve?.(true);
			return true;
		}
		dx /= dist; dz /= dist;
		const speed = 2.7 * dt;
		p.root.position.x += dx * speed;
		p.root.position.z += dz * speed;
		p.root.rotation.y = dampAngle(p.root.rotation.y, Math.atan2(dx, dz), 9 * dt);
		p.setMoving(true);
		this._cam.bob = (this._cam.bob || 0) + dt * 8.5; // a gentle step-bob while walking
		return true;
	}

	_updateCamera(dt) {
		const c = this._cam;
		c.yaw = dampAngle(c.yaw, c.targetYaw, 8 * dt);
		const focusing = this._focus && performance.now() < this._focus.until;
		const p = this.player ? this.player.root.position : new Vector3(0, 0, 0);
		// Orbit the focused agent when one is selected, otherwise a point biased
		// from the spectator toward the arena centre (keeps the line-up framed).
		let tx, tz, ty, distTarget;
		if (focusing) {
			tx = this._focus.x; tz = this._focus.z; ty = 1.45; distTarget = this._focus.dist;
		} else {
			tx = p.x * 0.55; tz = p.z * 0.5 - 2.0; ty = 1.2; distTarget = c.targetDist;
		}
		c.dist += (distTarget - c.dist) * Math.min(1, (focusing ? 4 : 8) * dt);
		const cx = tx + Math.sin(c.yaw) * Math.cos(c.pitch) * c.dist;
		const cz = tz + Math.cos(c.yaw) * Math.cos(c.pitch) * c.dist;
		// Subtle step-bob while the guide is mid-tour — reads like a real walk.
		const bob = this._tour ? Math.sin(c.bob || 0) * 0.06 : 0;
		const cy = ty + Math.sin(c.pitch) * c.dist + 1.0 + bob;
		this.camera.position.lerp(_tmpVec.set(cx, cy, cz), Math.min(1, 6 * dt));
		this.camera.lookAt(tx, ty, tz);
	}

	// ── Loop ──────────────────────────────────────────────────────────────────

	start() {
		if (this._running) return;
		this._running = true;
		this._clock.last = performance.now();
		const loop = (now) => {
			if (!this._running) return;
			const dt = Math.min(0.05, (now - this._clock.last) / 1000);
			this._clock.last = now;
			this._tick(dt);
			this.renderer.render(this.scene, this.camera);
			this._raf = requestAnimationFrame(loop);
		};
		this._raf = requestAnimationFrame(loop);
	}

	_tick(dt) {
		for (const a of this.agents.values()) a.update(dt);
		this.player?.update(dt);
		this._updatePlayer(dt);
		this._updateCamera(dt);
		// FX
		for (let i = this._fx.length - 1; i >= 0; i--) { if (this._fx[i].tick(dt)) this._fx.splice(i, 1); }
		// Floor ring shimmer
		const t = this._clock.last / 1000;
		(this._pulseRings || []).forEach((r) => { r.mesh.material.opacity = r.base * (0.7 + 0.3 * Math.sin(t * 1.4 + r.phase)); });
		// Embers
		if (this.embers) {
			const arr = this.embers.geometry.attributes.position.array;
			for (let i = 0; i < this._emberSeed.length; i++) {
				const s = this._emberSeed[i];
				arr[i * 3 + 1] += s.speed * dt;
				arr[i * 3] += Math.sin(t * 0.4 + s.sway) * 0.002;
				if (arr[i * 3 + 1] > 9) arr[i * 3 + 1] = 0;
			}
			this.embers.geometry.attributes.position.needsUpdate = true;
		}
		// Pad halos breathe; leader gold rotates.
		for (const a of this.agents.values()) {
			const halo = a.pad?.userData?.halo;
			if (halo) halo.material.opacity = (a.leader ? 0.9 : 0.6) * (0.7 + 0.3 * Math.sin(t * 2 + (a.headHeight || 0)));
		}
		// Market-maker floor lines + price markers.
		if (this._floors.size) this._tickFloors(dt, t);
		if (this._onLabels) this._onLabels();
	}

	// Project an avatar's head to screen space (for DOM labels). Returns null if behind camera.
	projectHead(avatar, out) {
		const p = avatar.worldHead(_tmpVec);
		p.project(this.camera);
		if (p.z > 1) return null;
		const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
		out.x = (p.x * 0.5 + 0.5) * w;
		out.y = (-p.y * 0.5 + 0.5) * h;
		out.behind = p.z > 1;
		return out;
	}

	setLabelUpdater(fn) { this._onLabels = fn; }

	_aspect() { return (this.canvas.clientWidth || window.innerWidth) / (this.canvas.clientHeight || window.innerHeight); }

	_onResize() {
		const w = this.canvas.clientWidth || window.innerWidth;
		const h = this.canvas.clientHeight || window.innerHeight;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	dispose() {
		this._running = false;
		cancelAnimationFrame(this._raf);
		window.removeEventListener('resize', this._onResize);
		window.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('keyup', this._onKeyUp);
		this.clearAgents();
		if (this.player) this._removeAvatar(this.player);
		this.renderer.dispose();
	}
}

// ── One avatar (agent or spectator) ──────────────────────────────────────────

class ArenaAvatar {
	constructor(model, lib, loopByName, clipMap, avatarUrl = '') {
		this.object = model;
		this._clipMap = clipMap;
		this._loopByName = loopByName;
		this.anim = new AnimationManager();
		this.anim.setAnimationDefs(lib.getAnimationDefs());
		// Inject the shared canonical clips so attach() builds retargeted actions
		// without re-fetching or re-parsing them.
		for (const [name, clip] of lib.clips) this.anim.clips.set(name, clip);
		this.anim.attach(model, { avatarUrl });
		this._configureLoops();
		this._emoteTimer = 0;
		this._moving = false;
		this._busy = false; // mid one-shot emote
		this._box = new Box3().setFromObject(model);
	}

	_configureLoops() {
		for (const [name, action] of this.anim.actions) {
			const loop = this._loopByName.get(name) !== false;
			action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
			action.clampWhenFinished = !loop;
		}
	}

	idle() { this._busy = false; this.anim.crossfadeTo(this._clipMap.idle, 0.3); }

	setMoving(moving) {
		if (this._busy) return;
		if (moving === this._moving) return;
		this._moving = moving;
		this.anim.crossfadeTo(moving ? this._clipMap.walk : this._clipMap.idle, 0.18);
	}

	// A one-shot reaction that returns to idle/locomotion when done.
	emote(kind) {
		const name = this._clipMap[kind] || kind;
		this._busy = true;
		this.anim.crossfadeTo(name, 0.15);
		const clip = this.anim.clips.get(name);
		const dur = clip ? clip.duration : 1.6;
		this._emoteTimer = Math.max(0.6, dur);
	}

	update(dt) {
		this.anim.update(dt);
		if (this._busy) {
			this._emoteTimer -= dt;
			if (this._emoteTimer <= 0) {
				this._busy = false;
				this.anim.crossfadeTo(this._moving ? this._clipMap.walk : this._clipMap.idle, 0.25);
			}
		}
	}

	measureHeadHeight() {
		const box = new Box3().setFromObject(this.object);
		return Math.min(2.2, Math.max(1.2, box.max.y - box.min.y)) ;
	}

	worldHead(out = new Vector3()) {
		this.root.getWorldPosition(out);
		out.y += (this.headHeight || this.measureHeadHeight()) + 0.15;
		return out;
	}

	dispose() {
		this.anim.dispose();
		this.object.traverse((o) => {
			if (o.isMesh) {
				o.geometry?.dispose?.();
				const m = o.material;
				if (Array.isArray(m)) m.forEach((x) => x.dispose?.()); else m?.dispose?.();
			}
		});
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

const _tmpVec = new Vector3();

function dampAngle(current, target, lambda) {
	let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return current + diff * Math.min(1, lambda);
}

function makeLabelTexture(text, colorHex) {
	const c = document.createElement('canvas');
	c.width = 256; c.height = 128;
	const ctx = c.getContext('2d');
	const col = '#' + new Color(colorHex).getHexString();
	ctx.font = 'bold 64px ui-monospace, "JetBrains Mono", monospace';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.shadowColor = col; ctx.shadowBlur = 22;
	ctx.fillStyle = col;
	ctx.fillText(String(text ?? ''), 128, 66);
	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	return tex;
}

export { ArenaAvatar };
