// Homepage "Pose it here" demo — a lite, fully-interactive slice of /pose.
// Runs the exact MannequinRig the full studio runs on, so every interaction is
// real: orbit the camera, GRAB a limb and move it (CCD inverse kinematics on
// hands & feet, world-space trackball rotation on every other joint), drag the
// X/Y/Z sliders for precision, or tap a preset to morph the whole figure. The
// figure idles with a faint breathing sway and slowly auto-orbits until you
// touch it, so the section is never a dead grey statue. Snapshot the pose to a
// PNG, or carry the exact pose into the full studio via a shareable link.
//
// The render loop is gated on visibility (IntersectionObserver): the WebGL
// context idles whenever the section scrolls off-screen, keeping the homepage
// smooth.

import {
	AmbientLight,
	CircleGeometry,
	Color,
	DirectionalLight,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	PCFShadowMap,
	PerspectiveCamera,
	Plane,
	Quaternion,
	Raycaster,
	Scene,
	ShadowMaterial,
	SphereGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { MannequinRig } from './pose-rig.js';
import { JOINT_LABELS, JOINT_AXIS_LABELS } from './pose-mannequin.js';
import { getPresetById } from './pose-presets.js';
import { encodePose } from './pose-share.js';
import { log } from './shared/log.js';

// Curated spread of presets for the lite demo — one or two from each group so
// the chip row reads like a tour without overwhelming the homepage.
const DEMO_PRESET_IDS = [
	'relaxed', 'tpose', 'wave', 'hands-on-hips', 'run', 'jump',
	'superhero-landing', 'sit-chair', 'thinker', 'warrior2', 'flex', 'meditate',
];

// Mannequin joints that drive a CCD IK chain when grabbed — drag the hand/foot
// and the limb reaches for the cursor. Everything else trackball-rotates.
const IK_EFFECTOR = {
	wristL: 'LeftHand', wristR: 'RightHand',
	ankleL: 'LeftFoot', ankleR: 'RightFoot',
};

// Joints that breathe when idle, and the per-axis sway amplitude (radians).
// Kept tiny — this should read as "alive," not "wobbling."
const BREATH = [
	{ joint: 'chest', axis: 'x', amp: 0.018, freq: 1.1, phase: 0 },
	{ joint: 'spine', axis: 'x', amp: 0.010, freq: 1.1, phase: 0 },
	{ joint: 'head', axis: 'y', amp: 0.013, freq: 0.5, phase: 0.4 },
	{ joint: 'head', axis: 'x', amp: 0.009, freq: 0.9, phase: 1.2 },
	{ joint: 'shoulderL', axis: 'z', amp: 0.012, freq: 1.1, phase: 0 },
	{ joint: 'shoulderR', axis: 'z', amp: -0.012, freq: 1.1, phase: 0 },
];

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const prefersReducedMotion =
	typeof matchMedia === 'function' &&
	matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = (tag, attrs = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) node.setAttribute(k, v);
	}
	for (const child of [].concat(children)) {
		if (child == null) continue;
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
};

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function initHomePose(root) {
	const stage = root.querySelector('[data-pose-stage]');
	const chipRow = root.querySelector('[data-pose-chips]');
	const sliderHost = root.querySelector('[data-pose-sliders]');
	const selLabel = root.querySelector('[data-pose-selected]');
	const hint = root.querySelector('[data-pose-hint]');
	const resetBtn = root.querySelector('[data-pose-reset]');
	const copyBtn = root.querySelector('[data-pose-copy]');
	const snapBtn = root.querySelector('[data-pose-snap]');
	const studioLink = root.querySelector('[data-pose-studio]');
	const toastEl = root.querySelector('[data-pose-toast]');
	if (!stage || !chipRow || !sliderHost) return;

	// ── Scene ───────────────────────────────────────────────────────────
	const canvas = el('canvas', { class: 'hp-canvas' });
	stage.appendChild(canvas);

	// WebGL can be unavailable (GPU blocklist, context budget exhausted,
	// software rendering disabled) — surface a hint instead of crashing.
	let renderer;
	try {
		renderer = new WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			// Required so the snapshot can read the drawing buffer back as a PNG.
			preserveDrawingBuffer: true,
			powerPreference: 'high-performance',
		});
	} catch (err) {
		log.warn('[home-pose] WebGL unavailable, skipping pose demo:', err?.message);
		canvas.remove();
		if (hint) hint.textContent = 'Interactive 3D posing isn’t available on this device.';
		return;
	}
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFShadowMap;

	const scene = new Scene();
	const camera = new PerspectiveCamera(42, 1, 0.05, 100);
	camera.position.set(1.7, 1.45, 3.1);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.target.set(0, 0.95, 0);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.enablePan = false;
	controls.minDistance = 2.0;
	controls.maxDistance = 5.5;
	controls.minPolarAngle = 0.35;
	controls.maxPolarAngle = Math.PI * 0.52;
	controls.rotateSpeed = 0.85;
	controls.autoRotate = !prefersReducedMotion;
	controls.autoRotateSpeed = 0.55;

	// ── Lighting ────────────────────────────────────────────────────────
	scene.add(new AmbientLight(0xffffff, 0.55));
	scene.add(new HemisphereLight(0xffffff, 0x202024, 0.6));
	const key = new DirectionalLight(0xffffff, 1.5);
	key.position.set(2.6, 4.2, 2.4);
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	key.shadow.camera.near = 0.5;
	key.shadow.camera.far = 14;
	key.shadow.camera.left = -3;
	key.shadow.camera.right = 3;
	key.shadow.camera.top = 4;
	key.shadow.camera.bottom = -2;
	key.shadow.bias = -0.0006;
	key.shadow.radius = 4;
	scene.add(key);
	const rim = new DirectionalLight(0xffffff, 0.35);
	rim.position.set(-3, 2, -2.5);
	scene.add(rim);

	// ── Ground (faint disc + shadow catcher) ────────────────────────────
	const disc = new Mesh(new CircleGeometry(3.4, 64), new MeshBasicMaterial({ color: 0x0c0c0d }));
	disc.rotation.x = -Math.PI / 2;
	disc.position.y = -0.001;
	scene.add(disc);
	const shadowCatcher = new Mesh(new CircleGeometry(3.4, 64), new ShadowMaterial({ opacity: 0.42 }));
	shadowCatcher.rotation.x = -Math.PI / 2;
	shadowCatcher.receiveShadow = true;
	scene.add(shadowCatcher);

	// ── Rig (the real MannequinRig — same as the full studio) ────────────
	const rig = new MannequinRig({ build: 'male', color: '#e6e6ea' });
	rig.setConstraintsEnabled(true);
	const man = rig.mannequin;
	scene.add(rig.root);

	// Selection marker — a soft glowing orb pinned to the active joint. (The
	// mannequin shares materials across the body, so a per-joint emissive tint
	// is impossible; an overlay marker selects without side effects.)
	const marker = new Mesh(
		new SphereGeometry(0.05, 20, 16),
		new MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.9 }),
	);
	marker.visible = false;
	scene.add(marker);
	const markerHalo = new Mesh(
		new SphereGeometry(0.085, 20, 16),
		new MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.18 }),
	);
	marker.add(markerHalo);

	// ── State ───────────────────────────────────────────────────────────
	let selected = null;
	const raycaster = new Raycaster();
	const pointer = new Vector2();
	const tmpVec = new Vector3();

	// committed = the user's "real" pose (euler per joint + root); breathing is
	// layered on top each frame without corrupting it.
	const committed = {};
	function captureCommitted() {
		for (const name of Object.keys(man.joints)) {
			const r = man.joints[name].rotation;
			committed[name] = { x: r.x, y: r.y, z: r.z };
		}
		committed.rootY = man.root.position.y;
		committed.rootX = man.root.position.x;
		committed.rootZ = man.root.position.z;
		updateStudioHref();
	}

	// ── Preset morph (eased tween over the euler pose) ──────────────────
	let tween = null;
	function targetFromPreset(preset) {
		const target = {};
		for (const name of Object.keys(man.joints)) {
			const r = preset.pose[name];
			target[name] = { x: r?.x || 0, y: r?.y || 0, z: r?.z || 0 };
		}
		const rp = preset.pose.rootPosition;
		target.root = { x: rp?.x || 0, y: rp?.y || 0, z: rp?.z || 0 };
		return target;
	}
	function applyEuler(target) {
		for (const name of Object.keys(man.joints)) {
			const r = target[name];
			if (r) man.joints[name].rotation.set(r.x, r.y, r.z);
		}
		if (target.root) man.root.position.set(target.root.x, target.root.y, target.root.z);
	}
	function snapshotEuler() {
		const from = {};
		for (const name of Object.keys(man.joints)) {
			const r = man.joints[name].rotation;
			from[name] = { x: r.x, y: r.y, z: r.z };
		}
		from.root = { x: man.root.position.x, y: man.root.position.y, z: man.root.position.z };
		return from;
	}
	function morphToPreset(preset) {
		const target = targetFromPreset(preset);
		if (prefersReducedMotion) {
			applyEuler(target);
			captureCommitted();
			refreshSliders();
			return;
		}
		tween = { from: snapshotEuler(), to: target, t: 0, dur: 0.55 };
	}
	function advanceTween(dt) {
		if (!tween) return;
		tween.t = Math.min(1, tween.t + dt / tween.dur);
		const k = easeInOutCubic(tween.t);
		const { from, to } = tween;
		for (const name of Object.keys(man.joints)) {
			const a = from[name];
			const b = to[name];
			if (!a || !b) continue;
			man.joints[name].rotation.set(
				a.x + (b.x - a.x) * k,
				a.y + (b.y - a.y) * k,
				a.z + (b.z - a.z) * k,
			);
		}
		man.root.position.set(
			from.root.x + (to.root.x - from.root.x) * k,
			from.root.y + (to.root.y - from.root.y) * k,
			from.root.z + (to.root.z - from.root.z) * k,
		);
		if (tween.t >= 1) {
			tween = null;
			captureCommitted();
			refreshSliders();
		}
	}

	// ── Idle breathing ──────────────────────────────────────────────────
	function applyBreathing(t) {
		for (const name of Object.keys(man.joints)) {
			const c = committed[name];
			if (c) man.joints[name].rotation.set(c.x, c.y, c.z);
		}
		for (const b of BREATH) {
			const j = man.joints[b.joint];
			const c = committed[b.joint];
			if (!j || !c) continue;
			j.rotation[b.axis] = c[b.axis] + Math.sin(t * b.freq + b.phase) * b.amp;
		}
		man.root.position.y = (committed.rootY || 0) + Math.sin(t * 1.1) * 0.004;
	}

	// ── Direct manipulation (grab-to-pose) ──────────────────────────────
	let drag = null; // { mode:'ik'|'fk', joint, effectorKey, plane, lastX, lastY }
	const camDir = new Vector3();
	const camRight = new Vector3();
	const camUp = new Vector3();
	const dragPlane = new Plane();
	const ikTarget = new Vector3();
	const qWorld = new Quaternion();
	const qParent = new Quaternion();
	const qDelta = new Quaternion();
	const qAxis = new Quaternion();

	function setPointer(e) {
		const rect = canvas.getBoundingClientRect();
		pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
	}

	function hitJoint(e) {
		setPointer(e);
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(man.selectableMeshes, false);
		if (!hits.length) return null;
		return man.jointFromHit(hits[0].object);
	}

	// Capture phase so we can veto OrbitControls before it engages: grabbing a
	// body part poses it; grabbing empty space orbits the camera.
	function onDown(e) {
		const joint = hitJoint(e);
		if (!joint) return; // let OrbitControls handle the orbit
		stopAutoOrbit();
		controls.enabled = false;
		selectJoint(joint);
		const effectorKey = IK_EFFECTOR[joint];
		if (effectorKey && rig.getNode(effectorKey)) {
			rig.getNode(effectorKey).getWorldPosition(tmpVec);
			camera.getWorldDirection(camDir);
			dragPlane.setFromNormalAndCoplanarPoint(camDir, tmpVec);
			drag = { mode: 'ik', joint, effectorKey };
		} else {
			drag = { mode: 'fk', joint, lastX: e.clientX, lastY: e.clientY };
		}
		canvas.setPointerCapture?.(e.pointerId);
	}

	function onMove(e) {
		if (!drag) return;
		if (drag.mode === 'ik') {
			setPointer(e);
			raycaster.setFromCamera(pointer, camera);
			if (raycaster.ray.intersectPlane(dragPlane, ikTarget)) {
				rig.solveIK(drag.effectorKey, ikTarget);
			}
		} else {
			const j = man.joints[drag.joint];
			if (!j || !j.parent) return;
			const dx = e.clientX - drag.lastX;
			const dy = e.clientY - drag.lastY;
			drag.lastX = e.clientX;
			drag.lastY = e.clientY;
			camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
			camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
			const k = 0.011;
			qDelta
				.setFromAxisAngle(camUp, dx * k)
				.multiply(qAxis.setFromAxisAngle(camRight, dy * k));
			// Apply the screen-space delta in world space, then convert back to
			// the joint's local frame (its parent's world rotation is fixed here).
			j.getWorldQuaternion(qWorld);
			j.parent.getWorldQuaternion(qParent);
			qWorld.premultiply(qDelta);
			j.quaternion.copy(qParent.invert().multiply(qWorld));
		}
		refreshSliders();
	}

	function endDrag(e) {
		if (!drag) return;
		canvas.releasePointerCapture?.(e.pointerId);
		drag = null;
		controls.enabled = true;
		captureCommitted();
	}

	canvas.addEventListener('pointerdown', onDown, true);
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', endDrag);
	window.addEventListener('pointercancel', endDrag);

	// ── Selection + sliders ─────────────────────────────────────────────
	function selectJoint(name) {
		selected = name;
		if (selLabel) selLabel.textContent = name ? JOINT_LABELS[name] || name : '—';
		if (hint) hint.hidden = !!name;
		marker.visible = !!name;
		buildSliders(name);
	}

	const sliderRefs = {};
	function buildSliders(name) {
		sliderHost.replaceChildren();
		for (const k of Object.keys(sliderRefs)) delete sliderRefs[k];
		if (!name) {
			sliderHost.appendChild(el('p', {
				class: 'hp-sliders-empty',
				text: 'Grab the figure to pose a joint — or pick one here.',
			}));
			return;
		}
		const axisLabels = JOINT_AXIS_LABELS[name] || JOINT_AXIS_LABELS.default;
		for (const axis of ['x', 'y', 'z']) {
			const value = el('span', { class: 'hp-slider-val' });
			const input = el('input', {
				type: 'range', min: '-180', max: '180', step: '1', class: 'hp-slider',
				'aria-label': `${JOINT_LABELS[name] || name} ${axisLabels[axis]}`,
				oninput: () => {
					stopAutoOrbit();
					man.setJointRotation(name, axis, Number(input.value) * RAD);
					committed[name] = { ...man.getJointRotation(name) };
					value.textContent = `${Math.round(man.getJointRotation(name)[axis] * DEG)}°`;
					updateStudioHref();
				},
			});
			sliderRefs[axis] = { input, value };
			sliderHost.appendChild(el('div', { class: 'hp-slider-row' }, [
				el('div', { class: 'hp-slider-head' }, [
					el('span', { class: 'hp-slider-axis', text: axisLabels[axis] }),
					value,
				]),
				input,
			]));
		}
		refreshSliders();
	}

	function refreshSliders() {
		if (!selected) return;
		const rot = man.getJointRotation(selected);
		for (const axis of ['x', 'y', 'z']) {
			const ref = sliderRefs[axis];
			if (!ref) continue;
			ref.input.value = String(Math.round(rot[axis] * DEG));
			ref.value.textContent = `${Math.round(rot[axis] * DEG)}°`;
		}
	}

	// ── Preset chips ────────────────────────────────────────────────────
	let activeChip = null;
	for (const id of DEMO_PRESET_IDS) {
		const preset = getPresetById(id);
		if (!preset) continue;
		const chip = el('button', {
			type: 'button', class: 'hp-chip', text: preset.label,
			onclick: () => {
				stopAutoOrbit();
				morphToPreset(preset);
				if (activeChip) activeChip.classList.remove('is-active');
				chip.classList.add('is-active');
				activeChip = chip;
			},
		});
		chipRow.appendChild(chip);
	}

	// ── Actions: reset / copy link / snapshot ───────────────────────────
	function clearActiveChip() {
		if (activeChip) { activeChip.classList.remove('is-active'); activeChip = null; }
	}
	resetBtn?.addEventListener('click', () => {
		const relaxed = getPresetById('relaxed');
		if (relaxed) morphToPreset(relaxed);
		clearActiveChip();
	});

	let toastTimer = 0;
	function toast(msg) {
		if (!toastEl) return;
		toastEl.textContent = msg;
		toastEl.classList.add('is-show');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toastEl.classList.remove('is-show'), 2000);
	}

	function poseUrl() {
		return `${window.location.origin}/pose#p=${encodePose(rig.getPose())}`;
	}
	function updateStudioHref() {
		if (studioLink) studioLink.href = poseUrl();
	}
	copyBtn?.addEventListener('click', async () => {
		const url = poseUrl();
		try {
			await navigator.clipboard.writeText(url);
			toast('Pose link copied');
		} catch {
			// Clipboard blocked (no permission / insecure context) — fall back to
			// navigating the user to their pose in the full studio.
			window.open(url, '_blank', 'noopener');
		}
	});

	snapBtn?.addEventListener('click', () => {
		const W = 1600, H = 1200;
		const prevW = stage.clientWidth, prevH = stage.clientHeight;
		const hadBg = scene.background;
		const markerWasVisible = marker.visible;
		marker.visible = false;
		scene.background = new Color(0x0a0a0b);
		renderer.setSize(W, H, false);
		camera.aspect = W / H;
		camera.updateProjectionMatrix();
		renderer.render(scene, camera);
		const dataUrl = canvas.toDataURL('image/png');
		// Restore the live view.
		scene.background = hadBg;
		marker.visible = markerWasVisible;
		renderer.setSize(prevW, prevH, false);
		camera.aspect = (prevW || 1) / (prevH || 1);
		camera.updateProjectionMatrix();
		const a = el('a', { href: dataUrl, download: 'three-ws-pose.png' });
		document.body.appendChild(a);
		a.click();
		a.remove();
		toast('Pose saved as PNG');
	});

	// ── Auto-orbit (stops on first interaction) ─────────────────────────
	function stopAutoOrbit() {
		if (controls.autoRotate) controls.autoRotate = false;
	}
	controls.addEventListener('start', stopAutoOrbit);

	// ── Render loop (visibility-gated) ──────────────────────────────────
	let running = false;
	let last = 0;
	let rafId = 0;

	function resize() {
		const w = stage.clientWidth;
		const h = stage.clientHeight;
		if (!w || !h) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	function frame(now) {
		if (!running) return;
		rafId = requestAnimationFrame(frame);
		const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
		last = now;
		if (tween) advanceTween(dt);
		else if (!drag && !prefersReducedMotion) applyBreathing(now / 1000);
		if (selected && man.joints[selected]) {
			man.joints[selected].getWorldPosition(tmpVec);
			marker.position.copy(tmpVec);
		}
		markerHalo.scale.setScalar(0.9 + Math.sin(now / 320) * 0.12);
		controls.update();
		renderer.render(scene, camera);
	}

	function start() {
		if (running) return;
		running = true;
		last = 0;
		resize();
		rafId = requestAnimationFrame(frame);
	}
	function stop() {
		running = false;
		if (rafId) cancelAnimationFrame(rafId);
		rafId = 0;
	}

	new ResizeObserver(resize).observe(stage);
	new IntersectionObserver((entries) => {
		for (const entry of entries) entry.isIntersecting ? start() : stop();
	}, { threshold: 0.08 }).observe(stage);

	// ── First pose ──────────────────────────────────────────────────────
	const initial = getPresetById('relaxed');
	if (initial) applyEuler(targetFromPreset(initial));
	captureCommitted();
	buildSliders(null);
	resize();
}

function boot() {
	const root = document.getElementById('home-pose');
	if (root) initHomePose(root);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
	boot();
}
