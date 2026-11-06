/**
 * Avatar Studio — export optimization + validation.
 *
 * The studio exports the live Three.js scene via GLTFExporter with
 * `embedImages: true`, which produces a correct but heavyweight GLB: textures
 * are re-embedded uncompressed, vertex buffers are full-precision floats, and
 * nothing is deduplicated. Uploaded as-is, a customised avatar can be several
 * times larger than it needs to be — slow to download, slow to first paint.
 *
 * This module runs the same conservative glTF-Transform passes the server bake
 * uses ([api/_lib/bake.js]) directly in the browser, before upload:
 *
 *   prune → dedup → weld → quantize → meshopt (EXT_meshopt_compression)
 *
 * All of these are geometry/structure transforms — no texture re-encode (that
 * needs sharp, which is Node-only). They are lossless or near-lossless and are
 * already proven safe on arbitrary user avatars by the server bake. The output
 * is meshopt-compressed; TalkScene's loader wires the meshopt decoder, so it
 * loads everywhere the studio's own GLBs already load.
 *
 * The result is then validated with the official Khronos glTF-Validator. If the
 * optimized GLB has hard errors — or somehow ends up larger than the source, or
 * the pipeline throws — we discard it and fall back to the original export. The
 * save must never fail because optimization failed.
 */

import { log } from './shared/log.js';

// Quantization precision — copied verbatim from the server bake so studio
// exports and server-baked avatars compress identically and predictably.
const QUANTIZE_OPTS = Object.freeze({
	quantizePosition: 14,
	quantizeNormal: 10,
	quantizeTexcoord: 12,
	quantizeColor: 8,
	quantizeWeight: 8,
	quantizeGeneric: 12,
});

function fmtBytes(n) {
	if (!Number.isFinite(n)) return '';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compress and validate a freshly-exported avatar GLB.
 *
 * @param {Blob} blob — the GLTFExporter output (binary GLB).
 * @param {{ onStatus?: (sublabel: string) => void }} [opts]
 * @returns {Promise<{ blob: Blob, optimized: boolean, sourceBytes: number, outputBytes: number, report: object|null }>}
 *          Always resolves. `optimized` is false when we fell back to the
 *          original blob for any reason.
 */
export async function optimizeAndValidateGlb(blob, opts = {}) {
	const { onStatus } = opts;
	const sourceBytes = blob.size;
	const fallback = (report = null) => ({
		blob,
		optimized: false,
		sourceBytes,
		outputBytes: sourceBytes,
		report,
	});

	let optimizedBytes;
	try {
		// Lazy-load the heavy transform + encoder modules only at save time so
		// they never weigh down the initial studio load.
		const [{ WebIO }, { ALL_EXTENSIONS }, fns, { MeshoptEncoder, MeshoptDecoder }] =
			await Promise.all([
				import('@gltf-transform/core'),
				import('@gltf-transform/extensions'),
				import('@gltf-transform/functions'),
				import('meshoptimizer'),
			]);
		const { prune, dedup, weld, quantize, meshopt } = fns;

		await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);

		const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
			'meshopt.encoder': MeshoptEncoder,
			'meshopt.decoder': MeshoptDecoder,
		});

		const srcBuf = new Uint8Array(await blob.arrayBuffer());
		const doc = await io.readBinary(srcBuf);

		await doc.transform(
			prune(),
			dedup(),
			weld(),
			quantize(QUANTIZE_OPTS),
			meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
		);

		optimizedBytes = await io.writeBinary(doc);
	} catch (err) {
		log.warn(
			'[avatar-studio] GLB optimization failed; uploading original export:',
			err?.message,
		);
		return fallback();
	}

	// A larger output means the source was already tight (or pathological); keep
	// the original rather than ship a regression.
	if (optimizedBytes.byteLength >= sourceBytes) {
		log.warn('[avatar-studio] optimized GLB not smaller; keeping original export');
		return fallback();
	}

	// Validate the optimized bytes with the official Khronos validator. Hard
	// errors mean a transform produced an invalid GLB — discard and fall back.
	let report = null;
	try {
		const { validateBytes } = await import('gltf-validator');
		report = await validateBytes(optimizedBytes);
		const numErrors = report?.issues?.numErrors ?? 0;
		if (numErrors > 0) {
			log.warn(
				`[avatar-studio] optimized GLB failed validation (${numErrors} errors); uploading original export`,
			);
			return fallback(report);
		}
	} catch (err) {
		// Validator itself threw — treat as a hard failure of the optimized path
		// and fall back to the trusted original export.
		log.warn('[avatar-studio] GLB validation threw; uploading original export:', err?.message);
		return fallback();
	}

	const outputBytes = optimizedBytes.byteLength;
	onStatus?.(`${fmtBytes(sourceBytes)} → ${fmtBytes(outputBytes)}`);
	log.info(
		`[avatar-studio] optimized GLB ${fmtBytes(sourceBytes)} → ${fmtBytes(outputBytes)} ` +
			`(${Math.round((1 - outputBytes / sourceBytes) * 100)}% smaller)`,
	);

	return {
		blob: new Blob([optimizedBytes], { type: 'model/gltf-binary' }),
		optimized: true,
		sourceBytes,
		outputBytes,
		report,
	};
}
