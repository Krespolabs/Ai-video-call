import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const routeManifest = JSON.parse(
	readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
);

describe('production deployment target', () => {
	it('routes the generic deploy command through the guarded GCP pipeline', () => {
		expect(packageJson.scripts.deploy).toBe('npm run deploy:gcp:full');
		expect(packageJson.scripts.deploy).not.toContain('vercel');
	});

	it('keeps automatic Vercel Git deployments disabled', () => {
		expect(routeManifest.git?.deploymentEnabled).toBe(false);
	});

	it('gives the legacy full-build orchestrator a provider-neutral command', () => {
		expect(packageJson.scripts['build:production']).toBe(
			'node scripts/build-vercel.mjs',
		);
		expect(packageJson.scripts['build:vercel']).toBe(
			'npm run build:production',
		);
	});
});
