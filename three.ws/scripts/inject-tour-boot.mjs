#!/usr/bin/env node
// Guarantee the Guided-Tour boot gate on EVERY built HTML page.
// ============================================================
// The tour navigates the visitor across dozens of pages (full-page loads), and
// on each new page it can only resume if the tiny boot gate is present to
// re-inject /feature-tour.js. That gate is normally added by a Vite
// transformIndexHtml hook (vite.config.js → 'feature-tour-boot') — but that hook
// runs inconsistently across the build: ~55% of built pages (e.g. /discover,
// /studio, /bazaar) shipped WITHOUT it, so the moment the tour navigated onto
// one of them the engine never loaded and the whole tour died, forcing a
// restart. An 88-stop curriculum hit a gateless page within the first few stops.
//
// This post-build step is the belt to that suspenders: it walks dist/ and adds
// the gate to any page missing it, so the tour survives navigation to any page.
// Doing it as a separate script (like strip-sw-from-embeds.mjs) makes it run
// reliably regardless of Vite plugin ordering. Idempotent — a second run is a
// no-op. Embed surfaces are intentionally skipped (they must never run the tour
// inside a third-party iframe).

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Must never run the tour — loaded in third-party iframes.
const EMBED_ENTRIES = new Set([
	'widget.html',
	'embed.html',
	'avatar-embed.html',
	'agent-embed.html',
	'a-embed.html',
	'agent-token-page.html',
]);

// The exact gate string used by vite.config.js → 'feature-tour-boot'. Only pulls
// in the heavy tour module when a tour is starting (?tour=) or already active
// (sessionStorage) — so adding it to a page never in a tour is a harmless no-op.
const GATE =
	"(function(){if(window.top!==window.self)return;var a=false;try{var r=sessionStorage.getItem('tws:tour:state');a=!!r&&JSON.parse(r).active===true}catch(e){}var p=new URLSearchParams(location.search).get('tour');if(!(p==='start'||p==='1'||(p!=='0'&&a)))return;if(document.querySelector('script[src=\"/feature-tour.js\"]'))return;var s=document.createElement('script');s.type='module';s.src='/feature-tour.js';document.head.appendChild(s)})();";

const GATE_TAG = `<script>${GATE}</script>`;
const MARKER = 'tws:tour:state'; // presence means the gate is already there

const distDir = process.argv[2] || 'dist';

if (!existsSync(distDir)) {
	console.error(`[tour-boot] dist directory not found: ${distDir}`);
	process.exit(2);
}

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (name.endsWith('.html')) out.push(p);
	}
	return out;
}

let injected = 0;
let already = 0;
let skipped = 0;

for (const file of walk(distDir)) {
	const base = file.split('/').pop();
	if (EMBED_ENTRIES.has(base)) {
		skipped++;
		continue;
	}
	const html = readFileSync(file, 'utf8');
	if (html.includes(MARKER)) {
		already++;
		continue;
	}
	// Inject just before </head> (fall back to before </body>, then prepend).
	let out;
	if (html.includes('</head>')) out = html.replace('</head>', `${GATE_TAG}</head>`);
	else if (html.includes('</body>')) out = html.replace('</body>', `${GATE_TAG}</body>`);
	else out = GATE_TAG + html;
	writeFileSync(file, out);
	injected++;
}

console.log(
	`[tour-boot] gate ensured on ${injected + already}/${injected + already + skipped} pages ` +
		`(${injected} injected, ${already} already had it, ${skipped} embed surfaces skipped)`,
);
