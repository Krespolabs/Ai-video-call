#!/usr/bin/env node
// Regenerates api/_lib/riva-protos/asr-descriptor.js from the vendored NVIDIA
// Riva .proto sources.
//
//   node scripts/generate-riva-asr-descriptor.mjs
//
// This is the ASR sibling of scripts/generate-riva-tts-descriptor.mjs. It is
// kept SEPARATE — a distinct generator writing a distinct descriptor file — so
// the proven TTS descriptor (descriptor.js, consumed by api/_lib/tts-nvidia.js)
// is never regenerated or perturbed when the ASR surface changes. The two
// lanes share the same vendored riva_audio.proto / riva_common.proto but own
// their service descriptors independently.
//
// Why a generated descriptor instead of loading the .proto files at runtime:
// api/ routes are esbuild-bundled in place on Vercel (scripts/bundle-api.mjs),
// so a runtime fs read of a .proto would need fragile includeFiles +
// import.meta.url path math that differs between dev (api/_lib/…) and the
// bundled output (api/asr.js). A checked-in JS module bundles cleanly, needs no
// filesystem at runtime, and is loaded via @grpc/proto-loader's fromJSON().
//
// The descriptor is parsed with keepCase:true so the gRPC surface uses the
// snake_case field names from the proto (config, sample_rate_hertz,
// language_code, max_alternatives) — the same names NVIDIA's docs use.

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROTO_DIR = resolve(ROOT, 'api/_lib/riva-protos');
const SOURCES = ['riva_common.proto', 'riva_audio.proto', 'riva_asr.proto'];
const OUTPUT = resolve(PROTO_DIR, 'asr-descriptor.js');

const root = new protobuf.Root();
for (const name of SOURCES) {
	const source = await readFile(resolve(PROTO_DIR, name), 'utf8');
	protobuf.parse(source, root, { keepCase: true });
}
root.resolveAll();

// Sanity: the exact surface api/_lib/asr-nvidia.js depends on must exist.
root.lookupService('nvidia.riva.asr.RivaSpeechRecognition');
root.lookupType('nvidia.riva.asr.RecognizeRequest');
root.lookupType('nvidia.riva.asr.RecognizeResponse');
root.lookupType('nvidia.riva.asr.RecognitionConfig');
root.lookupEnum('nvidia.riva.AudioEncoding');

const banner = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/generate-riva-asr-descriptor.mjs
// protobufjs JSON descriptor for the NVIDIA Riva ASR service, parsed
// (keepCase) from the vendored protos in api/_lib/riva-protos/*.proto,
// themselves from https://github.com/nvidia-riva/common (riva/proto/).
// SPDX-FileCopyrightText: Copyright (c) 2022 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT
`;

const body = `${banner}export default ${JSON.stringify(root.toJSON(), null, '\t')};\n`;
await writeFile(OUTPUT, body);
console.log(`wrote ${OUTPUT}`);
