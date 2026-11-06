#!/usr/bin/env node
/**
 * Universal [hidden] guard audit — the VERIFIER half of the inject+audit pair.
 *
 * The `hidden` HTML attribute hides an element only while some CSS maps `[hidden]`
 * to `display:none`. The UA default does that, but its specificity (0,1,0) loses
 * to any component rule that sets `display` on a class/id (`.modal{display:grid}`),
 * so a `hidden` element renders anyway. A full-screen overlay authored that way
 * then covers the page and eats every click — exactly how the Brain Studio modal
 * once blocked /agent-studio#brain (that page skipped style.css, which carries the
 * global guard, and leaned on a fragile per-page inline copy).
 *
 * The canonical guard lives in public/tokens.css (imported by style.css and
 * nav.css, so it reaches every page that links any shared stylesheet); pages that
 * link none are stamped with an inline copy by scripts/inject-hidden-guard.mjs.
 * This audit fails the build if any product page still fails to RESOLVE a guard —
 * via a linked stylesheet (directly or through @import), an inline <style>, or the
 * injector's marker. It is self-validating: tokens/style/nav are checked through
 * the same resolver, so deleting the guard from tokens.css fails this audit too.
 *
 * Usage:
 *   node scripts/audit-hidden-guard.mjs           # exit 1 if any page is unguarded
 *   node scripts/audit-hidden-guard.mjs --strict  # same; explicit for prebuild parity
 */
import { relative } from 'node:path';
import { ROOT, collectPages, pageIsGuarded } from './lib/hidden-guard.mjs';

const pages = collectPages();
const offenders = pages.filter((p) => !pageIsGuarded(p)).map((p) => relative(ROOT, p));

if (offenders.length) {
	console.error(`\n✗ ${offenders.length} page(s) do not resolve a [hidden]{display:none} guard:\n`);
	for (const rel of offenders) console.error(`  ${rel}`);
	console.error(
		'\nEvery page must guarantee the `hidden` attribute actually hides — otherwise a\n' +
			'component that sets `display` on a class/id (e.g. a full-screen modal) renders\n' +
			'on top of the page and blocks all interaction. Run\n' +
			'  node scripts/inject-hidden-guard.mjs --write\n' +
			'to stamp the inline guard, or link /tokens.css, /style.css, or /nav.css.\n',
	);
	process.exit(1);
}

console.log(`✓ audit-hidden-guard: all ${pages.length} pages resolve the [hidden] guard`);
