// Tests for the animated USDZ exporter (src/usdz-animated.js).
//
// The risky, hand-authored parts of the animated pipeline are pure: turning
// per-frame vertex arrays into USD `point3f[] points.timeSamples`, injecting
// stage playback timing, and re-packing the 64-byte-aligned USDZ zip. Those are
// covered here directly and deterministically — no GLB parsing, no browser
// canvas — plus an end-to-end sampler test driving a real SkinnedMesh through a
// real AnimationClip to prove the captured frames follow the skeleton.

import { describe, it, expect, beforeAll } from 'vitest';
import {
	Bone,
	Skeleton,
	SkinnedMesh,
	BufferGeometry,
	Float32BufferAttribute,
	Uint16BufferAttribute,
	MeshStandardMaterial,
	Scene,
	AnimationMixer,
	AnimationClip,
	VectorKeyframeTrack,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

import {
	_vec3ArrayToUsd,
	_pointsTimeSamplesBlock,
	_patchGeometryPoints,
	_injectStageTiming,
	_packUsdz,
	_sampleSkinnedFrames,
	glbBlobToAnimatedUsdzBlob,
} from '../src/usdz-animated.js';

// GLTFExporter's binary writer reaches for the browser FileReader; shim it over
// Node's Blob so the end-to-end test can mint a GLB without a DOM.
beforeAll(() => {
	if (typeof globalThis.FileReader === 'undefined') {
		globalThis.FileReader = class {
			readAsArrayBuffer(blob) {
				blob.arrayBuffer().then((b) => {
					this.result = b;
					this.onloadend?.();
				});
			}
			readAsDataURL(blob) {
				blob.arrayBuffer().then((b) => {
					this.result = `data:${blob.type || ''};base64,${Buffer.from(b).toString('base64')}`;
					this.onloadend?.();
				});
			}
		};
	}
});

describe('_vec3ArrayToUsd', () => {
	it('formats a flat xyz array as USD tuples at the given precision', () => {
		const out = _vec3ArrayToUsd(new Float32Array([1, 2, 3, 4, 5, 6]), 3);
		expect(out).toBe('(1.00, 2.00, 3.00), (4.00, 5.00, 6.00)');
	});
});

describe('_pointsTimeSamplesBlock', () => {
	it('keys each frame array by its integer time code', () => {
		const block = _pointsTimeSamplesBlock(
			[new Float32Array([0, 0, 0]), new Float32Array([1, 1, 1])],
			3,
		);
		expect(block).toContain('point3f[] points.timeSamples = {');
		expect(block).toContain('0: [(0.00, 0.00, 0.00)],');
		expect(block).toContain('1: [(1.00, 1.00, 1.00)],');
	});
});

describe('_patchGeometryPoints', () => {
	const GEOM = [
		'def Mesh "Geometry"',
		'{',
		'\tint[] faceVertexCounts = [3]',
		'\tint[] faceVertexIndices = [0, 1, 2]',
		'\tpoint3f[] points = [(0, 1, 0), (1, 0, 0), (0, 0, 1)]',
		'\tuniform token subdivisionScheme = "none"',
		'}',
	].join('\n');

	it('swaps the static points property for time samples without touching the rest', () => {
		const out = _patchGeometryPoints(
			GEOM,
			[new Float32Array([0, 1, 0, 1, 0, 0, 0, 0, 1]), new Float32Array([5, 1, 0, 6, 0, 0, 5, 0, 1])],
			5,
		);
		expect(out).not.toContain('point3f[] points = [');
		expect(out).toContain('point3f[] points.timeSamples = {');
		expect(out).toContain('1: [(5.0000, 1.0000, 0.0000)');
		// Topology and other properties survive verbatim.
		expect(out).toContain('int[] faceVertexIndices = [0, 1, 2]');
		expect(out).toContain('uniform token subdivisionScheme = "none"');
	});

	it('throws when there is no static points property to animate', () => {
		expect(() => _patchGeometryPoints('def Mesh "x" {}', [new Float32Array([0, 0, 0])])).toThrow(
			/no static points/,
		);
	});
});

describe('_injectStageTiming', () => {
	const HEADER = ['#usda 1.0', '(', '\tdefaultPrim = "Root"', '\tmetersPerUnit = 1', '\tupAxis = "Y"', ')', ''].join(
		'\n',
	);

	it('adds frame range and real-time playback rate to the layer metadata', () => {
		const out = _injectStageTiming(HEADER, { frameCount: 16, durationSeconds: 3 });
		expect(out).toContain('startTimeCode = 0');
		expect(out).toContain('endTimeCode = 15');
		// 15 codes over 3s → 5 codes/sec.
		expect(out).toContain('timeCodesPerSecond = 5.00000');
		expect(out).toContain('framesPerSecond = 5.00000');
		// upAxis is preserved, not replaced.
		expect(out).toContain('upAxis = "Y"');
	});

	it('throws on an unexpected header rather than producing a broken stage', () => {
		expect(() => _injectStageTiming('#usda 1.0\n(\n)\n', { frameCount: 2, durationSeconds: 1 })).toThrow(
			/unexpected USDA header/,
		);
	});
});

describe('_packUsdz', () => {
	it('produces a valid zip with model.usda first and 64-byte-aligned payloads', () => {
		const files = {
			'geometries/Geometry_1.usda': new TextEncoder().encode('geom'),
			'model.usda': new TextEncoder().encode('#usda 1.0\n'),
			'textures/Texture_0.png': new Uint8Array([1, 2, 3, 4]),
		};
		const zipped = _packUsdz({ ...files });
		const back = unzipSync(zipped);

		// model.usda is present and first in iteration order.
		expect(Object.keys(back)[0]).toBe('model.usda');
		expect(strFromU8(back['model.usda'])).toContain('#usda 1.0');
		expect(strFromU8(back['geometries/Geometry_1.usda'])).toBe('geom');

		// Each file's data payload starts at a 64-byte boundary (USD mmap rule):
		// the local-file-header is 30 bytes + filename, plus any extra field, and
		// the resulting data offset must satisfy (offset % 64) === 0.
		const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
		let p = 0;
		while (p + 4 <= zipped.length && view.getUint32(p, true) === 0x04034b50) {
			const nameLen = view.getUint16(p + 26, true);
			const extraLen = view.getUint16(p + 28, true);
			const compSize = view.getUint32(p + 18, true);
			const dataOffset = p + 30 + nameLen + extraLen;
			expect(dataOffset % 64).toBe(0);
			p = dataOffset + compSize;
		}
	});
});

describe('_sampleSkinnedFrames', () => {
	it('captures deformed vertices that follow the bone across the clip', () => {
		const geo = new BufferGeometry();
		geo.setAttribute('position', new Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3));
		geo.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
		geo.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));

		const bone = new Bone();
		bone.name = 'TestBone';
		const skeleton = new Skeleton([bone]);
		const mesh = new SkinnedMesh(geo, new MeshStandardMaterial());
		mesh.add(bone);
		mesh.bind(skeleton);

		const scene = new Scene();
		scene.add(mesh);

		// Bone slides 0 → 4 on X across a 1s clip.
		const clip = new AnimationClip('slide', 1, [
			new VectorKeyframeTrack('TestBone.position', [0, 1], [0, 0, 0, 4, 0, 0]),
		]);
		const mixer = new AnimationMixer(scene);
		const action = mixer.clipAction(clip);

		const frames = _sampleSkinnedFrames(scene, mixer, action, [mesh], {
			frameCount: 4,
			duration: 1,
		}).get(mesh);

		expect(frames).toHaveLength(4);
		// Times sampled at 0, .25, .5, .75 → bone X at 0, 1, 2, 3 → vertex0.x tracks it.
		const x0 = frames.map((f) => f[0]);
		expect(x0[0]).toBeCloseTo(0, 4);
		expect(x0[1]).toBeCloseTo(1, 4);
		expect(x0[2]).toBeCloseTo(2, 4);
		expect(x0[3]).toBeCloseTo(3, 4);
		// Y/Z of vertex0 are unaffected by an X-only translation.
		expect(frames[3][1]).toBeCloseTo(1, 4);
	});
});

describe('glbBlobToAnimatedUsdzBlob (end-to-end)', () => {
	async function buildAnimatedSkinnedGlb() {
		const geo = new BufferGeometry();
		geo.setAttribute('position', new Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3));
		geo.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
		geo.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
		geo.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
		geo.setIndex([0, 1, 2]);

		const bone = new Bone();
		bone.name = 'Hips';
		const mesh = new SkinnedMesh(geo, new MeshStandardMaterial({ color: 0x8844ff }));
		mesh.name = 'Body';
		mesh.add(bone);
		mesh.bind(new Skeleton([bone]));

		const scene = new Scene();
		scene.add(mesh);
		const clip = new AnimationClip('idle', 1, [
			new VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0.3, 0, 0]),
		]);

		const buffer = await new Promise((resolve, reject) =>
			new GLTFExporter().parse(scene, resolve, reject, { binary: true, animations: [clip] }),
		);
		return new Blob([buffer]);
	}

	it('turns a skinned, animated GLB into a looping animated USDZ', async () => {
		const glbBlob = await buildAnimatedSkinnedGlb();
		const usdz = await glbBlobToAnimatedUsdzBlob(glbBlob, { targetFps: 8 });

		expect(usdz.type).toBe('model/vnd.usdz+zip');
		const files = unzipSync(new Uint8Array(await usdz.arrayBuffer()));

		// Valid USDZ shape: model.usda first, geometry packaged alongside.
		expect(Object.keys(files)[0]).toBe('model.usda');
		const model = strFromU8(files['model.usda']);
		expect(model).toMatch(/timeCodesPerSecond = 7\.0+/); // 8 frames over 1s → 7 codes/sec
		expect(model).toMatch(/endTimeCode = 7/);
		expect(model).toMatch(/startTimeCode = 0/);

		const geomName = Object.keys(files).find((f) => f.startsWith('geometries/'));
		const geom = strFromU8(files[geomName]);
		expect(geom).toContain('point3f[] points.timeSamples = {');
		expect(geom).not.toMatch(/point3f\[\] points = \[/);
		// All 8 frames present as time codes 0..7.
		for (let f = 0; f <= 7; f++) expect(geom).toContain(`${f}: [(`);
	});
});
