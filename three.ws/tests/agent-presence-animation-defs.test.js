// Regression guard — the stage avatar's animation library must be registered.
//
// <agent-presence> builds its own `Viewer` directly (it does NOT go through the
// <agent-3d> element path that calls setAnimationDefs). The Viewer's
// AnimationManager therefore starts with an EMPTY def list. If nothing registers
// the shared clip library, `am.ensureLoaded(name)` finds no matching def and
// returns false for every clip — so the pinned resting idle never loads and every
// Body-studio "Movement" preview (playClip → ensureLoaded) is a silent no-op.
// That shipped once as "animations aren't working" on /agent-studio#body.
//
// This is a source-level guard (like schema-column-guard) rather than a WebGL
// integration test: it asserts the wiring exists in the model-load path so the
// no-op can't silently return.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/studio/agent-presence.js'), 'utf8');

describe('agent-presence registers the shared animation library', () => {
	it('calls setAnimationDefs on its Viewer in the model-load path', () => {
		expect(SRC).toMatch(/setAnimationDefs\s*\(/);
	});

	it('loads the animation manifest', () => {
		expect(SRC).toMatch(/animations\/manifest\.json/);
	});

	it('registers defs inside _loadModel, before/around the idle ensureLoaded', () => {
		const start = SRC.indexOf('async _loadModel');
		expect(start).toBeGreaterThan(-1);
		// Bound the slice to the _loadModel body (next method begins at the
		// following "async " / method declaration after a reasonable window).
		const body = SRC.slice(start, start + 1600);
		// Match the actual call sites, not the explanatory comments that also
		// mention these symbols.
		const defsCall = body.indexOf('.setAnimationDefs(');
		const ensureCall = body.indexOf('am.ensureLoaded(');
		expect(defsCall).toBeGreaterThan(-1);
		expect(ensureCall).toBeGreaterThan(-1);
		// The registration must precede the resting-idle ensureLoaded so the idle
		// actually has a def to load.
		expect(defsCall).toBeLessThan(ensureCall);
	});
});
