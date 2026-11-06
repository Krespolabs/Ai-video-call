#!/usr/bin/env node
// Regenerates api/_lib/riva-protos/descriptor.js (and the avatar-agent-mcp
// mirror) from the vendored NVIDIA Riva .proto sources.
//
//   node scripts/generate-riva-tts-descriptor.mjs
//
// Why a generated descriptor instead of loading the .proto files at runtime:
// api/ routes are esbuild-bundled in place on Vercel (scripts/bundle-api.mjs),
// so a runtime fs read of a .proto would need fragile includeFiles +
// import.meta.url path math that differs between dev (api/_lib/…) and the
// bundled output (api/tts/…). A checked-in JS module bundles cleanly, needs no
// filesystem at runtime, and is loaded via @grpc/proto-loader's fromJSON().
//
// The descriptor is parsed with keepCase:true so the gRPC surface uses the
// snake_case field names from the proto (text, language_code, sample_rate_hz,
// voice_name) — same names NVIDIA's docs and the probe transcript use.

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROTO_DIR = resolve(ROOT, 'api/_lib/riva-protos');
const SOURCES = ['riva_common.proto', 'riva_audio.proto', 'riva_tts.proto'];
const OUTPUTS = [
	resolve(PROTO_DIR, 'descriptor.js'),
	resolve(ROOT, 'packages/avatar-agent-mcp/src/lib/riva-protos/descriptor.js'),
];

const root = new protobuf.Root();
for (const name of SOURCES) {
	const source = await readFile(resolve(PROTO_DIR, name), 'utf8');
	protobuf.parse(source, root, { keepCase: true });
}
root.resolveAll();

// Sanity: the exact surface api/_lib/tts-nvidia.js depends on must exist.
root.lookupService('nvidia.riva.tts.RivaSpeechSynthesis');
root.lookupType('nvidia.riva.tts.SynthesizeSpeechRequest');
root.lookupType('nvidia.riva.tts.SynthesizeSpeechResponse');
root.lookupEnum('nvidia.riva.AudioEncoding');

const banner = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/generate-riva-tts-descriptor.mjs
// protobufjs JSON descriptor for the NVIDIA Riva TTS service, parsed
// (keepCase) from the vendored protos in api/_lib/riva-protos/*.proto,
// themselves from https://github.com/nvidia-riva/common (riva/proto/).
// SPDX-FileCopyrightText: Copyright (c) 2022 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT
`;

const body = `${banner}export default ${JSON.stringify(root.toJSON(), null, '\t')};\n`;
for (const out of OUTPUTS) {
	await writeFile(out, body);
	console.log(`wrote ${out}`);
}
