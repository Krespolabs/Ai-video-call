// Frames for the surfaces that have no route.
//
// A page can be photographed: `npm run announce:media` drives it in a real
// browser and the frame is the product. A package, a worker, or a service has
// no page, and 115 of the 316 planned announcements are one of those. The
// engagement archive is blunt about the alternative: a post with no media
// measured 0.875x against the account median, so "this one ships without an
// image" is not an option that leaves the post worth making.
//
// So the frame is built from what the thing actually is: its real name, its
// real one-line description, the command a developer really runs, and the tools
// or exports it really provides, all read out of its README and package.json.
// Nothing is invented, and nothing is styled to look like a screenshot of
// something that does not exist. It is a title card, and it says so by being
// obviously typeset rather than obviously photographed.
//
// The card is typeset in the product's own three fonts, fetched from the live
// origin and inlined: a page rendered from a string has no origin, so a linked
// stylesheet whose @font-face rules use root-relative URLs resolves to nothing
// and the card silently falls back to Helvetica.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The house style bans both dash glyphs in every surface we author, and a card
// is authored copy that happens to be rendered as pixels.
const DASHES = new RegExp('\\s*[\\u2014\\u2013]\\s*', 'g');
const clean = (text) => String(text || '').replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').replace(DASHES, ', ').trim();
const escape = (text) =>
	String(text || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// The command a reader would actually run, preferred in the order a reader
// would meet it: the one-line agent install, then npx, then npm install.
export function commandFrom(readme) {
	const blocks = [...String(readme).matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)].map((match) => match[1]);
	const lines = blocks.flatMap((block) => block.split('\n').map((line) => line.trim())).filter(Boolean);
	return (
		lines.find((line) => line.startsWith('claude mcp add')) ||
		lines.find((line) => line.startsWith('npx ')) ||
		lines.find((line) => line.startsWith('npm install')) ||
		lines.find((line) => line.startsWith('npm ')) ||
		null
	);
}

// Tool or export names, from the shapes a README in this repo actually uses: a
// tools table, backticked headings, or a bullet list of backticked names.
export function namesFrom(readme, limit = 8) {
	const body = String(readme);
	const names = [];
	const section = body.slice(Math.max(0, body.search(/^#{2,3}\s+(?:tools|api|exports|commands)\b/im)));
	// Only the first table of that section: the ones after it list parameters
	// and enum values, which are not the names a reader is being shown.
	const firstTable = section.match(/(?:^\|.*\n)+/m)?.[0] || '';
	for (const match of firstTable.matchAll(/^\|\s*`([a-z0-9_.:-]{3,40})`/gim)) names.push(match[1]);
	if (names.length < 3) for (const match of section.matchAll(/^#{3,4}\s+`([a-z0-9_.:-]{3,40})`/gim)) names.push(match[1]);
	if (names.length < 3) for (const match of section.matchAll(/^[-*]\s+`([a-z0-9_.:-]{3,40})`/gim)) names.push(match[1]);
	return [...new Set(names)].slice(0, limit);
}

// The site's own @font-face rules, with their root-relative sources rewritten
// to absolute ones so they load inside a document that has no base URL.
let fontCssPromise = null;
export function fetchFontCss(origin = 'https://three.ws') {
	if (!fontCssPromise) {
		fontCssPromise = fetch(`${origin}/fonts/fonts.css`, { signal: AbortSignal.timeout(20_000) })
			.then((response) => (response.ok ? response.text() : ''))
			.then((css) => css.replace(/url\(['"]?\/fonts\//g, `url('${origin}/fonts/`))
			.catch(() => '');
	}
	return fontCssPromise;
}

export function cardFacts(root, { dir, title, description }) {
	const readme = dir && existsSync(join(root, dir, 'README.md')) ? readFileSync(join(root, dir, 'README.md'), 'utf8') : '';
	const pkgPath = dir ? join(root, dir, 'package.json') : null;
	const pkg = pkgPath && existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
	const subtitle =
		clean(pkg.description) ||
		clean(readme.match(/<p align="center"><strong>([\s\S]*?)<\/strong><\/p>/)?.[1]) ||
		clean(description);
	return {
		title: pkg.name || title,
		subtitle,
		command: commandFrom(readme),
		names: namesFrom(readme),
		footer: pkg.name?.startsWith('@') ? `npmjs.com/package/${pkg.name}` : dir,
	};
}

// 1600x900: the frame X renders uncropped for a single image, and the viewport
// the capture script calls `wide`.
export function cardHtml(facts, { origin = 'https://three.ws', fontCss = '' } = {}) {
	const chips = (facts.names || []).map((name) => `<span class="chip">${escape(name)}</span>`).join('');
	return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<style>
${fontCss}</style>
<style>
	html, body { margin: 0; height: 900px; width: 1600px; }
	body {
		background: radial-gradient(120% 90% at 78% 8%, rgba(255, 215, 0, 0.10), transparent 58%), #08080b;
		color: #f7f7f8;
		font-family: 'Inter', system-ui, sans-serif;
		display: flex;
		flex-direction: column;
		justify-content: center;
		padding: 96px 104px;
		box-sizing: border-box;
	}
	.eyebrow { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 22px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }
	h1 { font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 74px; line-height: 1.04; margin: 26px 0 0; letter-spacing: -0.02em; }
	p.sub { font-size: 30px; line-height: 1.38; margin: 26px 0 0; color: rgba(255, 255, 255, 0.72); max-width: 1180px; }
	.cmd {
		margin-top: 44px;
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 27px;
		color: #f7f7f8;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 14px;
		padding: 24px 30px;
		display: flex;
		gap: 16px;
		align-items: baseline;
		max-width: 1290px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}
	.cmd.long { font-size: 23px; }
	.cmd b { color: rgba(255, 215, 0, 0.85); font-weight: 600; }
	.chips { margin-top: 40px; display: flex; flex-wrap: wrap; gap: 12px; max-width: 1300px; }
	.chip {
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 21px;
		color: rgba(255, 255, 255, 0.78);
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.10);
		border-radius: 999px;
		padding: 10px 20px;
	}
	footer { position: absolute; left: 104px; bottom: 74px; display: flex; gap: 22px; align-items: center; font-size: 24px; color: rgba(255, 255, 255, 0.5); }
	footer .dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 215, 0, 0.8); }
</style>
</head>
<body>
	<div class="eyebrow">three.ws</div>
	<h1>${escape(facts.title)}</h1>
	${facts.subtitle ? `<p class="sub">${escape(facts.subtitle)}</p>` : ''}
	${facts.command ? `<div class="cmd${facts.command.length > 70 ? ' long' : ''}"><b>$</b><span>${escape(facts.command)}</span></div>` : ''}
	${chips ? `<div class="chips">${chips}</div>` : ''}
	<footer><span class="dot"></span>${escape(facts.footer || 'three.ws')}</footer>
</body>
</html>`;
}
