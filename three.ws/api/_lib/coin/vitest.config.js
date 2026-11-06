// Local vitest config for the coin module's property tests.
//
// The repo's top-level vitest.config.js only includes `tests/**` and
// `src/**`. The autonomy guardrails for the demo-coin work prevent
// modifying that config, so we keep a co-located config here. To run:
//
//   npx vitest run --config api/_lib/coin/vitest.config.js
//
// When the demo graduates to production, fold these globs into the
// top-level config and delete this file.

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['api/_lib/coin/**/*.test.js'],
		testTimeout: 30_000,
	},
});
