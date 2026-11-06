// Vitest setup — load .env.local / .env into process.env BEFORE any test
// module is imported. Mirrors the loader in scripts/apply-migrations.mjs so a
// developer who has DATABASE_URL etc. in .env.local doesn't have to export
// them by hand to run DB-backed tests (e.g. siwx-storage). On CI the env vars
// are set on the runner; this loader is a no-op when no .env file is present.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch {
		// File not present — nothing to do.
	}
}
