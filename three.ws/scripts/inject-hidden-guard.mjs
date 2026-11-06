#!/usr/bin/env node
/**
 * Universal [hidden] guard injector — the WRITER half of the inject+audit pair.
 *
 * Most pages get the guard for free: public/tokens.css carries
 * `[hidden]{display:none!important}` and is imported by style.css and nav.css, so
 * any page linking a shared stylesheet resolves it. A minority link only
 * page-specific CSS and rely on the UA `[hidden]` default — which silently breaks
 * the moment a component sets `display` on a class/id (the Brain Studio modal that
 * covered /agent-studio#brain was this exact failure). This step stamps a tiny
 * inline guard into the <head> of every product page that does NOT already resolve
 * one, so `hidden` is authoritative everywhere regardless of which CSS a page loads.
 *
 * Safe by construction: the rule only collapses elements that carry the `hidden`
 * attribute (i.e. ones already meant to be off), and it matches the global guard
 * style.css has shipped for the rest of the site for years.
 *
 * Idempotent: pages that already resolve a guard (shared stylesheet, prior inline
 * rule, or this injector's marker) are left untouched.
 *
 * Usage:
 *   node scripts/inject-hidden-guard.mjs           # report what would change
 *   node scripts/inject-hidden-guard.mjs --write   # apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ROOT, collectPages, pageIsGuarded, INLINE_GUARD } from './lib/hidden-guard.mjs';

const write = process.argv.includes('--write');

/** Insert the inline guard right after the opening <head> tag, matching its indent. */
function injectGuard(html) {
	const headOpen = html.match(/<head\b[^>]*>/i);
	if (!headOpen) return { html, changed: false };
	const at = headOpen.index + headOpen[0].length;
	const lineStart = html.lastIndexOf('\n', headOpen.index) + 1;
	const indent = html.slice(lineStart, headOpen.index).match(/^[\t ]*/)[0] + '\t';
	return { html: html.slice(0, at) + `\n${indent}${INLINE_GUARD}` + html.slice(at), changed: true };
}

const changed = [];
const skippedNoHead = [];

for (const path of collectPages()) {
	if (pageIsGuarded(path)) continue;
	const orig = readFileSync(path, 'utf8');
	const { html, changed: didChange } = injectGuard(orig);
	if (!didChange) { skippedNoHead.push(relative(ROOT, path)); continue; }
	changed.push(relative(ROOT, path));
	if (write) writeFileSync(path, html);
}

if (skippedNoHead.length) {
	console.warn(`⚠ ${skippedNoHead.length} unguarded page(s) have no <head> to stamp:`);
	for (const rel of skippedNoHead) console.warn(`  ${rel}`);
}

if (!changed.length) {
	console.log('✓ inject-hidden-guard: every page already resolves the [hidden] guard');
} else if (write) {
	console.log(`✓ inject-hidden-guard: stamped the inline guard into ${changed.length} page(s)`);
} else {
	console.log(`inject-hidden-guard: ${changed.length} page(s) would be stamped (run with --write):`);
	for (const rel of changed) console.log(`  ${rel}`);
}
