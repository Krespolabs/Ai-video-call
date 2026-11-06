// Smoke test: every api routed-handler module must import cleanly.
//
// Catches broken import paths, wrong-stack imports, and placeholder code that
// throws on module init. If this fails on a file that is intentionally a stub,
// fix the stub or add it to SKIP_MODULES below with a clear reason.
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_DIR = join(process.cwd(), 'api');

// api/chat-skills.js and api/skills-manifest.js read data/_generated/skill-metadata.json
// at import time (a build artifact produced by `prebuild`, gitignored, never written
// by `npm test`). On a clean checkout the file is absent and those two modules throw
// ENOENT before their handler runs. Generate it the same way the build does — via the
// real generator script, no mock — so this smoke test is self-sufficient. Idempotent:
// skipped when the artifact already exists (e.g. after a prior build).
beforeAll(() => {
	const artifact = join(process.cwd(), 'data', '_generated', 'skill-metadata.json');
	if (existsSync(artifact)) return;
	execFileSync('node', [join(process.cwd(), 'scripts', 'build-skill-metadata.mjs')], {
		stdio: 'ignore',
	});
}, 60_000);

// Files we know fail because they load env-gated infrastructure not present in the
// test sandbox (DB, RPC, keypair files). Add only with a clear reason; never to
// hide a real bug.
const SKIP_MODULES = new Set([
	// @nirholas/pump-sdk has an ESM exports map that vite's import-analysis
	// stage cannot resolve (works fine in plain node + vercel runtime).
	// Verified: `node -e "import('./api/pump/curve.js')"` succeeds.
	'api/pump/curve.js',
	'api/pump/quote-sdk.js',

	// Heavy MCP SDK import graphs take 10-40s in Node but 90-190s under Vitest's
	// ESM transform pipeline (5-9x overhead). Covered by tests/api/mcp.test.js
	// which exercises them with proper mocking.
	'api/_mcp/auth.js',
	'api/_mcp/catalog.js',

	// @bonfida/spl-name-service v3 uses a CJS exports map that Vitest's module
	// resolver cannot satisfy (Missing "./dist/cjs/index.js" specifier) even
	// though plain Node resolves it correctly. Modules that directly or
	// transitively import @bonfida/spl-name-service are skipped here; the
	// actual runtime behaviour is exercised by tests/api/pay-by-name-resolve.test.js
	// and tests/api/x402-pay-by-name.test.js with proper mocking.
	'api/agents/sns.js',
	'api/x402/pay-by-name.js',
]);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = statSync(path);
		if (st.isDirectory()) {
			// Skip _lib, _id (helpers), and node_modules — those are imported by routed handlers,
			// so they get exercised transitively. We only enumerate routed surfaces here.
			if (name === '_lib' || name === '_id' || name === 'node_modules') continue;
			yield* walk(path);
		} else if (st.isFile() && name.endsWith('.js')) {
			yield path;
		}
	}
}

const files = [...walk(API_DIR)]
	.map((p) => relative(process.cwd(), p))
	.filter((rel) => !SKIP_MODULES.has(rel))
	.sort();

// Some handlers transitively load heavy ESM SDKs (@coinbase/x402, jsdom, the
// neon serverless client, @anthropic-ai/sdk, etc.). The cold import is 1-3s in
// plain Node on an idle box, but under Vitest's ESM transform pipeline (5-9x
// overhead) WITH the full suite's parallel forks competing for the same cores,
// a single graph walk has been measured north of 75s (api/_mcp/dispatch.js).
// 180s keeps this a correctness test — does the module evaluate? — instead of
// a scheduler race, while still bounding a genuine load-time hang.
describe('every api/**/*.js handler loads', () => {
	for (const rel of files) {
		it(
			rel,
			async () => {
				const url = pathToFileURL(join(process.cwd(), rel)).href;
				const mod = await import(url);
				expect(mod).toBeTruthy();
				// Most Vercel handlers export `default`; some export named handlers (e.g. cron jobs).
				// We don't enforce shape — only that the module evaluates without throwing.
			},
			180_000,
		);
	}
});
