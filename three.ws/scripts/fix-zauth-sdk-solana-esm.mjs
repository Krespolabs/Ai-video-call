// Patches @zauthx402/sdk after install to keep its @solana/* refund imports off
// Vercel's NFT trace.
//
// The SDK is consumed via api/_lib/zauth.js, which api/_lib/http.js imports, which
// in turn is imported by ~517 API routes. scripts/bundle-api.mjs INLINES the SDK
// into every one of those route bundles (it is not in that script's EXTERNALS).
// The SDK lazy-loads its Solana refund path with three LITERAL dynamic imports:
//
//   await import('@solana/signers')
//   await import('@solana/kit')
//   await import('@solana-program/token')
//
// @solana/* and @solana-program/* ARE in bundle-api's EXTERNALS, so esbuild
// leaves those literal imports in place. Vercel's @vercel/nft follows literal
// dynamic imports, so it traced the ~162 MB @solana tree once per route across
// all 517 bundles — 41 minutes of post-build function packaging, blowing the
// 45-minute build timeout (deploy Ca7BCT7LH). This is the same failure mode that
// removed @sentry/node from the http.js path (see api/_lib/sentry.js's header).
//
// Fix: rewrite each @solana/@solana-program literal specifier to atob('<base64>').
// Neither esbuild nor NFT decode base64, so the static trace stops at the SDK;
// the specifier is reconstructed at runtime, so the import resolves exactly as
// before from whatever node_modules the lambda ships (the Solana payment/agent
// routes that actually run refunds import @solana statically anyway, so the tree
// is present where it is used). EVM refunds are unaffected — viem is inlined, not
// externalized, so NFT never traced it.
//
// Idempotent (the atob() form no longer matches the literal-import regex);
// survives `npm ci` via postinstall. Scoped to @solana/@solana-program only —
// other dynamic imports the SDK makes (viem, bs58) are inlined by esbuild and
// must keep their literal specifiers.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);
const distDir = join(repo, 'node_modules/@zauthx402/sdk/dist');

if (!existsSync(distDir)) {
	console.log('[fix-zauth-sdk-solana-esm] package not installed, skipping');
	process.exit(0);
}

// Match literal dynamic imports of @solana/* and @solana-program/* only.
const LITERAL_SOLANA_IMPORT = /import\(\s*(['"])(@solana(?:-program)?\/[A-Za-z0-9._-]+)\1\s*\)/g;

function patchSource(src) {
	let count = 0;
	const out = src.replace(LITERAL_SOLANA_IMPORT, (_m, _q, spec) => {
		count++;
		const b64 = Buffer.from(spec, 'utf8').toString('base64');
		return `import(atob('${b64}'))`;
	});
	return { out, count };
}

function collectDistFiles(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectDistFiles(full, acc);
		else if (/\.(mjs|js|cjs)$/.test(entry.name)) acc.push(full);
	}
	return acc;
}

let filesPatched = 0;
let importsRewritten = 0;

for (const file of collectDistFiles(distDir)) {
	const src = readFileSync(file, 'utf8');
	if (!src.includes("import('@solana") && !src.includes('import("@solana')) continue;
	const { out, count } = patchSource(src);
	if (count > 0 && out !== src) {
		writeFileSync(file, out);
		filesPatched++;
		importsRewritten += count;
	}
}

if (importsRewritten > 0) {
	console.log(
		`[fix-zauth-sdk-solana-esm] obscured ${importsRewritten} @solana import(s) across ${filesPatched} file(s)`,
	);
} else {
	console.log('[fix-zauth-sdk-solana-esm] already patched');
}
