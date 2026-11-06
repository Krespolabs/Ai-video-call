#!/usr/bin/env node
// Post-build copy of character-studio/build → dist/avatar-studio.
// Used when build:avatar-studio runs in parallel with the main vite build, so
// the vite closeBundle hook fires before character-studio/build is ready.
// Running this after both finish ensures avatar-studio lands in dist/.
import { cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'character-studio/build');
const dest = resolve(root, 'dist/avatar-studio');

// On Vercel the avatar studio is built (phase 3) before this copy (phase 5), so
// a missing source here means the studio SPA would be absent from dist and
// /avatar-studio/ — a live, nav-linked production route — would 404 silently.
// Fail the deploy loudly rather than ship a 404. Locally (no VERCEL env) the
// studio may legitimately be unbuilt, so stay a warning there.
const isVercel = Boolean(process.env.VERCEL);

if (!existsSync(src)) {
	const msg = '[copy-avatar-studio] character-studio/build/ missing — avatar-studio would 404 in production';
	if (isVercel) {
		console.error(`${msg}; failing the build (run \`npm run build --prefix character-studio\` first)`);
		process.exit(1);
	}
	console.warn(`${msg} (skipped: not a Vercel build)`);
	process.exit(0);
}

cpSync(src, dest, { recursive: true });

// A source that exists but copies to an empty/incomplete dest (e.g. the SPA
// build emitted no entry HTML) is just as broken as a missing one — verify the
// served entry point actually landed before declaring success.
if (!existsSync(resolve(dest, 'index.html'))) {
	console.error('[copy-avatar-studio] dist/avatar-studio/index.html missing after copy — incomplete studio build');
	if (isVercel) process.exit(1);
}
console.log('[copy-avatar-studio] dist/avatar-studio populated');
