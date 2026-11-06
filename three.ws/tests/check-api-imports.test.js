// Guards the import sweep that gates `npm run deploy:gcp:submit`. A module that
// throws while loading is a 500 on every request to its route, not a build
// error: that is how @x402/extensions 2.25.0 and @bnb-chain/mpp 0.7.0 took the
// paid x402 surface down on 2026-09-18 while the build stayed green.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { listApiModules, findBrokenImports } from '../scripts/check-api-imports.mjs';

const scratchDirs = [];
function scratchTree(files) {
	const root = mkdtempSync(join(tmpdir(), 'check-api-imports-'));
	scratchDirs.push(root);
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), source);
	}
	return root;
}
afterEach(() => {
	while (scratchDirs.length) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

describe('listApiModules', () => {
	it('lists handlers and shared modules but not tests or vitest configs', () => {
		const root = scratchTree({
			'api/echo.js': 'export default 1;\n',
			'api/_lib/shared.js': 'export default 1;\n',
			'api/_lib/shared.test.js': 'export default 1;\n',
			'api/vitest.config.js': 'export default {};\n',
		});
		const listed = listApiModules({ root }).map((f) => f.slice(root.length + 1));
		expect(listed).toEqual(['api/_lib/shared.js', 'api/echo.js']);
	});
});

describe('findBrokenImports', () => {
	it('passes a tree where every module loads', async () => {
		const root = scratchTree({ 'api/ok.js': 'export const ok = true;\n' });
		expect(await findBrokenImports(listApiModules({ root }), { root })).toEqual([]);
	});

	it('reports a module that throws at load, and every module that imports it, as one finding', async () => {
		const root = scratchTree({
			'api/_lib/extension.js': "throw new Error('Invalid origin: \"undefined\" is not a valid URL');\n",
			'api/paid-a.js': "import './_lib/extension.js';\nexport default 1;\n",
			'api/paid-b.js': "import './_lib/extension.js';\nexport default 1;\n",
			'api/free.js': 'export default 1;\n',
		});
		const broken = await findBrokenImports(listApiModules({ root }), { root });
		expect(broken).toEqual([
			{
				error: 'Error: Invalid origin: "undefined" is not a valid URL',
				files: ['api/_lib/extension.js', 'api/paid-a.js', 'api/paid-b.js'],
			},
		]);
	});

	it('reports an import of a package subpath that no longer exists', async () => {
		const root = scratchTree({
			'api/rail.js': "import 'vitest/this-subpath-was-removed';\nexport default 1;\n",
		});
		const broken = await findBrokenImports(listApiModules({ root }), { root });
		expect(broken).toHaveLength(1);
		expect(broken[0].files).toEqual(['api/rail.js']);
		// Node reports ERR_PACKAGE_PATH_NOT_EXPORTED; vitest's resolver words the
		// same failure as "is not exported". Either way the subpath is named.
		expect(broken[0].error).toMatch(/this-subpath-was-removed/);
	});
});
