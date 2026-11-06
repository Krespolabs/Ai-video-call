// Tests for the server-side Audio2Face-3D module — the audio normalization math
// and the vendored proto descriptor's wire contract. The live gRPC round-trip is
// exercised separately by scripts/verify-nvidia-a2f.mjs (needs NVIDIA_API_KEY).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { _internals, resolveA2fFunctionId, A2F_DEFAULT_FUNCTION_ID } from '../api/_lib/a2f-nvidia.js';
import a2fDescriptor from '../api/_lib/a2f-protos/descriptor.js';

const require = createRequire(import.meta.url);

describe('a2f audio normalization', () => {
	it('downmixes interleaved stereo s16 to mono by averaging', () => {
		// L = 100, R = 300 → mono 200, per frame.
		const stereo = new Int16Array([100, 300, -100, -300]);
		const buf = Buffer.from(stereo.buffer);
		const mono = _internals.toMonoInt16(buf, 2);
		expect(Array.from(mono)).toEqual([200, -200]);
	});

	it('passes mono through untouched', () => {
		const m = new Int16Array([1, 2, 3, 4]);
		const out = _internals.toMonoInt16(Buffer.from(m.buffer), 1);
		expect(Array.from(out)).toEqual([1, 2, 3, 4]);
	});

	it('resamples to the target rate with the expected length and endpoints', () => {
		// 8 samples @ 32 kHz → 16 kHz halves the length.
		const src = new Int16Array([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
		const out = _internals.resampleInt16(src, 32000, 16000);
		expect(out.length).toBe(4);
		expect(out[0]).toBe(0); // first sample preserved
	});

	it('returns the same array when rates match', () => {
		const src = new Int16Array([1, 2, 3]);
		expect(_internals.resampleInt16(src, 16000, 16000)).toBe(src);
	});
});

describe('a2f function id resolution', () => {
	it('defaults to the published James model id', () => {
		const prev = process.env.NVIDIA_A2F_FUNCTION_ID;
		delete process.env.NVIDIA_A2F_FUNCTION_ID;
		expect(resolveA2fFunctionId()).toBe(A2F_DEFAULT_FUNCTION_ID);
		expect(resolveA2fFunctionId('explicit-id')).toBe('explicit-id');
		if (prev !== undefined) process.env.NVIDIA_A2F_FUNCTION_ID = prev;
	});
});

describe('a2f proto descriptor wire contract', () => {
	const protobuf = require('protobufjs');
	const root = protobuf.Root.fromJSON(a2fDescriptor);

	it('exposes the A2FControllerService.ProcessAudioStream surface', () => {
		const svc = root.lookupService('nvidia_ace.services.a2f_controller.v1.A2FControllerService');
		expect(svc.methods.ProcessAudioStream).toBeTruthy();
		expect(svc.methods.ProcessAudioStream.requestStream).toBe(true);
		expect(svc.methods.ProcessAudioStream.responseStream).toBe(true);
	});

	it('round-trips an AudioStream header the module sends', () => {
		const AudioStream = root.lookupType('nvidia_ace.controller.v1.AudioStream');
		// The module passes the enum by NAME ('AUDIO_FORMAT_PCM'); grpc-js/proto-
		// loader serialize via fromObject(), which resolves enum names to numbers —
		// so mirror that path here rather than create()/verify() (which want a number).
		const msg = {
			audio_stream_header: {
				audio_header: {
					audio_format: 'AUDIO_FORMAT_PCM',
					channel_count: 1,
					samples_per_second: 16000,
					bits_per_sample: 16,
				},
				blendshape_params: { enable_clamping_bs_weight: true },
			},
		};
		const decoded = AudioStream.toObject(
			AudioStream.decode(AudioStream.encode(AudioStream.fromObject(msg)).finish()),
			{ enums: String, defaults: true, oneofs: true },
		);
		expect(decoded.audio_stream_header.audio_header.samples_per_second).toBe(16000);
		expect(decoded.audio_stream_header.audio_header.audio_format).toBe('AUDIO_FORMAT_PCM');
		expect(decoded.audio_stream_header.blendshape_params.enable_clamping_bs_weight).toBe(true);
	});

	it('decodes an AnimationDataStream blendshape frame the module reads', () => {
		const ADS = root.lookupType('nvidia_ace.controller.v1.AnimationDataStream');
		// Header carries the ordered blendshape names; a data frame carries weights
		// with a time code — exactly the two fields a2f-nvidia.js consumes.
		const headerBuf = ADS.encode(ADS.create({
			animation_data_stream_header: { skel_animation_header: { blend_shapes: ['JawOpen', 'MouthSmileLeft'] } },
		})).finish();
		const frameBuf = ADS.encode(ADS.create({
			animation_data: { skel_animation: { blend_shape_weights: [{ time_code: 0.5, values: [0.8, 0.2] }] } },
		})).finish();

		const header = ADS.toObject(ADS.decode(headerBuf), { defaults: true, oneofs: true, arrays: true });
		const frame = ADS.toObject(ADS.decode(frameBuf), { defaults: true, oneofs: true, arrays: true });

		expect(header.animation_data_stream_header.skel_animation_header.blend_shapes).toEqual(['JawOpen', 'MouthSmileLeft']);
		const bsw = frame.animation_data.skel_animation.blend_shape_weights[0];
		expect(bsw.time_code).toBeCloseTo(0.5, 5);
		expect(bsw.values[0]).toBeCloseTo(0.8, 5);
	});
});
