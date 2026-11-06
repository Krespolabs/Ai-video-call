// Articulated 3D mannequin for /pose — a hierarchical skeleton built from
// Three.js primitives. Each joint is a Group whose rotation drives the body
// part below it; meshes (limbs, head, hands, feet) are anchored to those
// groups so adjusting a joint's Euler rotation moves the whole chain.
//
// Convention: every limb mesh extends along the joint group's LOCAL -Y axis
// (downward from the joint origin). That way the rest pose (all rotations
// zero) puts the figure standing upright with arms at its sides — so user-
// facing rotations are interpreted relative to that intuitive resting frame.

import {
	BoxGeometry,
	CapsuleGeometry,
	Color,
	Group,
	Mesh,
	MeshStandardMaterial,
	SphereGeometry,
} from 'three';

// Joint names are stable identifiers used by presets, serialization, and the
// UI. Order matters for the panel rendering — head → spine → arms → legs.
export const JOINT_NAMES = [
	'pelvis',
	'spine',
	'chest',
	'neck',
	'head',
	'shoulderL', 'elbowL', 'wristL',
	'shoulderR', 'elbowR', 'wristR',
	'hipL', 'kneeL', 'ankleL',
	'hipR', 'kneeR', 'ankleR',
];

// Human-readable labels for the selection HUD.
export const JOINT_LABELS = {
	pelvis: 'Pelvis',
	spine: 'Spine (lower)',
	chest: 'Spine (upper)',
	neck: 'Neck',
	head: 'Head',
	shoulderL: 'Shoulder L',
	elbowL: 'Elbow L',
	wristL: 'Wrist L',
	shoulderR: 'Shoulder R',
	elbowR: 'Elbow R',
	wristR: 'Wrist R',
	hipL: 'Hip L',
	kneeL: 'Knee L',
	ankleL: 'Ankle L',
	hipR: 'Hip R',
	kneeR: 'Knee R',
	ankleR: 'Ankle R',
};

// Per-axis hints for the UI sliders — describes what each Euler axis does
// for a given joint so the controls panel can label them meaningfully.
export const JOINT_AXIS_LABELS = {
	default:   { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	pelvis:    { x: 'Pitch',  y: 'Yaw',     z: 'Roll' },
	spine:    { x: 'Bend',   y: 'Twist',   z: 'Side' },
	chest:    { x: 'Bend',   y: 'Twist',   z: 'Side' },
	neck:      { x: 'Bend',   y: 'Turn',    z: 'Tilt' },
	head:      { x: 'Nod',    y: 'Turn',    z: 'Tilt' },
	shoulderL: { x: 'Raise',  y: 'Twist',   z: 'Out/In' },
	shoulderR: { x: 'Raise',  y: 'Twist',   z: 'In/Out' },
	elbowL:    { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	elbowR:    { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	wristL:    { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	wristR:    { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	hipL:      { x: 'Raise',  y: 'Twist',   z: 'Out/In' },
	hipR:      { x: 'Raise',  y: 'Twist',   z: 'In/Out' },
	kneeL:     { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	kneeR:     { x: 'Bend',   y: 'Twist',   z: 'Tilt' },
	ankleL:    { x: 'Flex',   y: 'Twist',   z: 'Tilt' },
	ankleR:    { x: 'Flex',   y: 'Twist',   z: 'Tilt' },
};

// Body proportions. Lengths are in metres so the camera and grid in Three.js
// units roughly match a ~1.75 m tall figure.
const PROPORTIONS = {
	male: {
		scale: 1.0,
		shoulderHalf: 0.21,
		hipHalf: 0.13,
		neckLen: 0.10,
		headRadius: 0.115,
		spineLen: 0.22,
		chestLen: 0.26,
		upperArmLen: 0.30,
		forearmLen: 0.28,
		handLen: 0.18,
		thighLen: 0.44,
		shinLen: 0.42,
		footLen: 0.25,
		limbRadius: 0.058,
		torsoRadius: 0.115,
	},
	female: {
		scale: 0.95,
		shoulderHalf: 0.18,
		hipHalf: 0.14,
		neckLen: 0.09,
		headRadius: 0.110,
		spineLen: 0.21,
		chestLen: 0.25,
		upperArmLen: 0.28,
		forearmLen: 0.27,
		handLen: 0.17,
		thighLen: 0.43,
		shinLen: 0.41,
		footLen: 0.24,
		limbRadius: 0.052,
		torsoRadius: 0.105,
	},
};

// Biological constraints — soft limits applied when constraintsEnabled = true.
// Values are radians per Euler axis (x, y, z). null means unrestricted on
// that axis. Ranges are generous; SetPose itself lets users toggle them off
// because tight limits frustrate creative posing.
const CONSTRAINTS = {
	pelvis:    { x: [-0.8, 0.8], y: [-Math.PI, Math.PI], z: [-0.6, 0.6] },
	spine:     { x: [-0.6, 0.6], y: [-0.6, 0.6], z: [-0.5, 0.5] },
	chest:     { x: [-0.6, 0.6], y: [-0.6, 0.6], z: [-0.5, 0.5] },
	neck:      { x: [-0.7, 0.7], y: [-0.8, 0.8], z: [-0.4, 0.4] },
	head:      { x: [-0.9, 0.9], y: [-1.3, 1.3], z: [-0.6, 0.6] },
	// Shoulder x: arm forward(+)/back(-). z: arm out to side (away from torso).
	shoulderL: { x: [-2.4, 2.4], y: [-1.6, 1.6], z: [-0.4, Math.PI] },
	shoulderR: { x: [-2.4, 2.4], y: [-1.6, 1.6], z: [-Math.PI, 0.4] },
	elbowL:    { x: [-2.4, 0.0], y: [-1.6, 1.6], z: null },
	elbowR:    { x: [-2.4, 0.0], y: [-1.6, 1.6], z: null },
	wristL:    { x: [-1.0, 1.0], y: [-0.6, 0.6], z: [-0.6, 0.6] },
	wristR:    { x: [-1.0, 1.0], y: [-0.6, 0.6], z: [-0.6, 0.6] },
	hipL:      { x: [-2.0, 0.6], y: [-1.0, 1.0], z: [-0.6, Math.PI / 2] },
	hipR:      { x: [-2.0, 0.6], y: [-1.0, 1.0], z: [-Math.PI / 2, 0.6] },
	kneeL:     { x: [0, 2.6], y: null, z: null },
	kneeR:     { x: [0, 2.6], y: null, z: null },
	ankleL:    { x: [-0.6, 0.9], y: [-0.4, 0.4], z: [-0.3, 0.3] },
	ankleR:    { x: [-0.6, 0.9], y: [-0.4, 0.4], z: [-0.3, 0.3] },
};

function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

// A limb mesh is a capsule oriented along -Y. The joint group sits at the
// PROXIMAL end (the rotation pivot, at the top of the limb), and the capsule
// is translated so its top cap touches that origin and its body hangs below.
// The next joint group is then placed at the distal end (y = -length).
function downLimb(length, radius, material) {
	const geom = new CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 8, 16);
	const mesh = new Mesh(geom, material);
	mesh.position.y = -length / 2;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;
}

function ballMesh(radius, material) {
	const m = new Mesh(new SphereGeometry(radius, 18, 14), material);
	m.castShadow = true;
	m.receiveShadow = true;
	return m;
}

// A limb that extends UP from its joint (used for spine, neck) — same as
// downLimb but mirrored. Spine goes up because its joint is at the pelvis
// and the chest joint sits at the top of the spine.
function upLimb(length, radius, material) {
	const geom = new CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 8, 16);
	const mesh = new Mesh(geom, material);
	mesh.position.y = length / 2;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;
}

// Tag a joint group and its descendant meshes so a raycaster can map a hit
// back to the owning joint name.
function tagJoint(group, name) {
	group.userData.jointName = name;
	group.traverse((child) => {
		if (child !== group && child instanceof Mesh) {
			child.userData.jointName = name;
		}
	});
}

export class Mannequin {
	constructor({ build = 'male', color = '#d4d4d8' } = {}) {
		this.build = build;
		this.constraintsEnabled = true;
		this.material = new MeshStandardMaterial({
			color: new Color(color),
			roughness: 0.62,
			metalness: 0.05,
		});
		this.jointMaterial = new MeshStandardMaterial({
			color: new Color(color).offsetHSL(0, 0, -0.06),
			roughness: 0.55,
			metalness: 0.05,
		});

		this.joints = {};
		this.selectableMeshes = [];
		this.root = new Group();
		this.root.name = 'mannequin-root';
		this._build();
	}

	// Walk a hit object back up to the nearest tagged joint group.
	jointFromHit(object) {
		let o = object;
		while (o) {
			if (o.userData?.jointName && this.joints[o.userData.jointName]) {
				return o.userData.jointName;
			}
			o = o.parent;
		}
		return null;
	}

	setBuild(build) {
		if (build === this.build) return;
		const prev = this.getPose();
		this.build = build;
		this.root.clear();
		this.joints = {};
		this.selectableMeshes = [];
		this._build();
		this.applyPose(prev);
	}

	setColor(hex) {
		this.material.color.set(hex);
		this.jointMaterial.color.set(hex).offsetHSL(0, 0, -0.06);
	}

	setConstraintsEnabled(enabled) {
		this.constraintsEnabled = !!enabled;
		if (this.constraintsEnabled) {
			for (const name of Object.keys(CONSTRAINTS)) {
				const j = this.joints[name];
				if (j) this._applyConstraint(name, j.rotation);
			}
		}
	}

	setJointRotation(name, axis, radians) {
		const j = this.joints[name];
		if (!j) return;
		j.rotation[axis] = radians;
		if (this.constraintsEnabled) this._applyConstraint(name, j.rotation);
	}

	getJointRotation(name) {
		const j = this.joints[name];
		if (!j) return { x: 0, y: 0, z: 0 };
		return { x: j.rotation.x, y: j.rotation.y, z: j.rotation.z };
	}

	// A pose is a flat map of jointName → {x, y, z} rotations (radians),
	// plus an optional "rootPosition" for translating the whole figure.
	applyPose(pose) {
		if (!pose) return;
		// Reset everything first so a partial preset doesn't leak previous
		// rotations on unmentioned joints.
		this.resetPose();
		for (const [name, rot] of Object.entries(pose)) {
			if (name === 'rootPosition' && rot) {
				this.root.position.set(rot.x || 0, rot.y || 0, rot.z || 0);
				continue;
			}
			const j = this.joints[name];
			if (!j) continue;
			j.rotation.set(rot.x || 0, rot.y || 0, rot.z || 0);
			if (this.constraintsEnabled) this._applyConstraint(name, j.rotation);
		}
	}

	getPose() {
		const pose = {};
		for (const name of Object.keys(this.joints)) {
			const r = this.joints[name].rotation;
			pose[name] = { x: r.x, y: r.y, z: r.z };
		}
		pose.rootPosition = {
			x: this.root.position.x,
			y: this.root.position.y,
			z: this.root.position.z,
		};
		return pose;
	}

	resetPose() {
		for (const j of Object.values(this.joints)) {
			j.rotation.set(0, 0, 0);
		}
		this.root.position.set(0, 0, 0);
	}

	_applyConstraint(name, rot) {
		const c = CONSTRAINTS[name];
		if (!c) return;
		if (c.x) rot.x = clamp(rot.x, c.x[0], c.x[1]);
		if (c.y) rot.y = clamp(rot.y, c.y[0], c.y[1]);
		if (c.z) rot.z = clamp(rot.z, c.z[0], c.z[1]);
	}

	_build() {
		const p = PROPORTIONS[this.build];
		this.root.scale.setScalar(p.scale);

		// Standing height: legs + spine + chest + neck + head. Place the
		// pelvis at hip height so the feet rest on y = 0.
		const pelvisY = p.thighLen + p.shinLen;

		// Pelvis — owns the whole figure's translation/rotation in body
		// space. Body yaw (turning the figure left/right) maps to pelvis.y.
		const pelvis = new Group();
		pelvis.name = 'pelvis';
		pelvis.position.y = pelvisY;
		this.root.add(pelvis);
		this.joints.pelvis = pelvis;

		// Pelvis block (flattened sphere).
		const pelvisMesh = new Mesh(
			new SphereGeometry(p.torsoRadius * 1.05, 18, 14),
			this.jointMaterial,
		);
		pelvisMesh.scale.set(1, 0.6, 0.8);
		pelvisMesh.castShadow = true;
		pelvisMesh.receiveShadow = true;
		pelvis.add(pelvisMesh);
		this.selectableMeshes.push(pelvisMesh);
		tagJoint(pelvis, 'pelvis');

		// Spine — extends UP from the pelvis. Rotation here flexes the
		// lower back.
		const spine = new Group();
		spine.name = 'spine';
		pelvis.add(spine);
		this.joints.spine = spine;
		const spineMesh = upLimb(p.spineLen, p.torsoRadius * 0.95, this.material);
		spine.add(spineMesh);
		this.selectableMeshes.push(spineMesh);
		tagJoint(spine, 'spine');

		// Chest — extends UP from the top of the spine. The rib-cage mesh
		// is slightly wider front-to-back than side-to-side via scale.
		const chest = new Group();
		chest.name = 'chest';
		chest.position.y = p.spineLen;
		spine.add(chest);
		this.joints.chest = chest;
		const chestMesh = upLimb(p.chestLen, p.torsoRadius, this.material);
		chestMesh.scale.set(1.05, 1.0, 0.85);
		chest.add(chestMesh);
		this.selectableMeshes.push(chestMesh);
		tagJoint(chest, 'chest');

		// Neck — up from the top of the chest.
		const neck = new Group();
		neck.name = 'neck';
		neck.position.y = p.chestLen;
		chest.add(neck);
		this.joints.neck = neck;
		const neckMesh = upLimb(p.neckLen, p.limbRadius * 0.9, this.material);
		neck.add(neckMesh);
		this.selectableMeshes.push(neckMesh);
		tagJoint(neck, 'neck');

		// Head — sphere at the top of the neck, plus a small wedge so the
		// front of the head is visible (helps a poser tell which way the
		// figure is looking).
		const head = new Group();
		head.name = 'head';
		head.position.y = p.neckLen;
		neck.add(head);
		this.joints.head = head;
		const headMesh = ballMesh(p.headRadius, this.material);
		headMesh.position.y = p.headRadius;
		head.add(headMesh);
		this.selectableMeshes.push(headMesh);
		const nose = new Mesh(
			new BoxGeometry(p.headRadius * 0.25, p.headRadius * 0.3, p.headRadius * 0.4),
			this.jointMaterial,
		);
		nose.position.set(0, p.headRadius * 0.95, p.headRadius * 0.85);
		nose.castShadow = true;
		head.add(nose);
		this.selectableMeshes.push(nose);
		tagJoint(head, 'head');

		// Arms — anchored at the top of the chest, extend DOWN from the
		// shoulder joint along -Y. Rest pose: arms at sides.
		this._buildArm('L', chest, p, +1);
		this._buildArm('R', chest, p, -1);

		// Legs — hang off the pelvis (not the spine, so spinal flexion
		// doesn't carry the legs with it).
		this._buildLeg('L', pelvis, p, +1);
		this._buildLeg('R', pelvis, p, -1);
	}

	_buildArm(side, chest, p, sign) {
		// sign: +1 for left, -1 for right (in world +X / -X).
		const shoulderName = 'shoulder' + side;
		const elbowName = 'elbow' + side;
		const wristName = 'wrist' + side;

		const shoulder = new Group();
		shoulder.name = shoulderName;
		shoulder.position.set(sign * p.shoulderHalf, p.chestLen * 0.92, 0);
		chest.add(shoulder);
		this.joints[shoulderName] = shoulder;

		const shoulderBall = ballMesh(p.limbRadius * 1.1, this.jointMaterial);
		shoulder.add(shoulderBall);
		this.selectableMeshes.push(shoulderBall);

		const upperArm = downLimb(p.upperArmLen, p.limbRadius, this.material);
		shoulder.add(upperArm);
		this.selectableMeshes.push(upperArm);
		tagJoint(shoulder, shoulderName);

		const elbow = new Group();
		elbow.name = elbowName;
		elbow.position.y = -p.upperArmLen;
		shoulder.add(elbow);
		this.joints[elbowName] = elbow;
		const forearm = downLimb(p.forearmLen, p.limbRadius * 0.92, this.material);
		elbow.add(forearm);
		this.selectableMeshes.push(forearm);
		tagJoint(elbow, elbowName);

		const wrist = new Group();
		wrist.name = wristName;
		wrist.position.y = -p.forearmLen;
		elbow.add(wrist);
		this.joints[wristName] = wrist;
		const hand = new Mesh(
			new BoxGeometry(p.limbRadius * 1.6, p.handLen, p.limbRadius * 0.7),
			this.material,
		);
		hand.position.y = -p.handLen / 2;
		hand.castShadow = true;
		hand.receiveShadow = true;
		wrist.add(hand);
		this.selectableMeshes.push(hand);
		tagJoint(wrist, wristName);
	}

	_buildLeg(side, pelvis, p, sign) {
		const hipName = 'hip' + side;
		const kneeName = 'knee' + side;
		const ankleName = 'ankle' + side;

		const hip = new Group();
		hip.name = hipName;
		hip.position.set(sign * p.hipHalf, -p.torsoRadius * 0.2, 0);
		pelvis.add(hip);
		this.joints[hipName] = hip;

		const hipBall = ballMesh(p.limbRadius * 1.15, this.jointMaterial);
		hip.add(hipBall);
		this.selectableMeshes.push(hipBall);

		const thigh = downLimb(p.thighLen, p.limbRadius * 1.15, this.material);
		hip.add(thigh);
		this.selectableMeshes.push(thigh);
		tagJoint(hip, hipName);

		const knee = new Group();
		knee.name = kneeName;
		knee.position.y = -p.thighLen;
		hip.add(knee);
		this.joints[kneeName] = knee;
		const shin = downLimb(p.shinLen, p.limbRadius * 0.95, this.material);
		knee.add(shin);
		this.selectableMeshes.push(shin);
		tagJoint(knee, kneeName);

		const ankle = new Group();
		ankle.name = ankleName;
		ankle.position.y = -p.shinLen;
		knee.add(ankle);
		this.joints[ankleName] = ankle;
		// Foot: box extended forward (toward +Z in default world frame).
		const foot = new Mesh(
			new BoxGeometry(p.limbRadius * 1.7, p.limbRadius * 0.6, p.footLen),
			this.material,
		);
		foot.position.set(0, -p.limbRadius * 0.3, p.footLen * 0.3);
		foot.castShadow = true;
		foot.receiveShadow = true;
		ankle.add(foot);
		this.selectableMeshes.push(foot);
		tagJoint(ankle, ankleName);
	}

	getApproxHeight() {
		const p = PROPORTIONS[this.build];
		return (p.thighLen + p.shinLen + p.spineLen + p.chestLen + p.neckLen + p.headRadius * 2) * p.scale;
	}
}

export { PROPORTIONS as MANNEQUIN_PROPORTIONS, CONSTRAINTS as MANNEQUIN_CONSTRAINTS };
