#!/usr/bin/env node
// tour-build-curriculum — generate a tour curriculum from a pages document.
// =========================================================================
// Reads a JSON "pages" document and writes a tour curriculum (see
// curriculum.schema.json). Curation options — section order, chapter intros,
// hero ordering, denied paths, per-page anchors — come from an optional config
// file so the curriculum is reproducible and version-controlled.
//
//   tour-build-curriculum --pages pages.json --out public/tour/curriculum.json
//   tour-build-curriculum --pages pages.json --config tour.config.json --out curriculum.json
//   tour-build-curriculum --pages pages.json --out curriculum.json --check
//
// --check exits non-zero if the file on disk differs from a fresh build (minus
// the volatile generatedAt timestamp) — wire it into CI to catch a stale tour.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCurriculum } from '../src/build-curriculum.js';

function parseArgs(argv) {
	const args = { check: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--check') args.check = true;
		else if (a === '--pages') args.pages = argv[++i];
		else if (a === '--config') args.config = argv[++i];
		else if (a === '--out') args.out = argv[++i];
		else if (a === '-h' || a === '--help') args.help = true;
	}
	return args;
}

function usage() {
	console.log(
		`Usage: tour-build-curriculum --pages <pages.json> --out <curriculum.json> [--config <config.json>] [--check]

  --pages   Path to the pages document ({ sections: [{ id, title, pages: [...] }] }).
  --out     Path to write the curriculum JSON.
  --config  Optional curation options passed to buildCurriculum (sectionOrder,
            sectionIntros, sectionHeroes, targets, deny, denyPrefix, title, …).
  --check   Fail if <out> is missing or differs from a fresh build.`,
	);
}

function stable(obj) {
	// Stable stringify ignoring generatedAt so --check doesn't flap on timestamp.
	const clone = JSON.parse(JSON.stringify(obj));
	delete clone.generatedAt;
	return JSON.stringify(clone);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.pages || !args.out) {
		usage();
		process.exit(args.help ? 0 : 1);
	}

	const pagesDoc = JSON.parse(readFileSync(resolve(args.pages), 'utf8'));
	const opts = args.config ? JSON.parse(readFileSync(resolve(args.config), 'utf8')) : {};
	const next = { ...buildCurriculum(pagesDoc, opts), generatedAt: new Date().toISOString() };
	const outPath = resolve(args.out);

	if (args.check) {
		if (!existsSync(outPath)) {
			console.error(`curriculum missing — run without --check to generate ${args.out}`);
			process.exit(1);
		}
		const current = JSON.parse(readFileSync(outPath, 'utf8'));
		if (stable(current) !== stable(next)) {
			console.error(`curriculum is stale — re-run tour-build-curriculum to regenerate ${args.out}`);
			process.exit(1);
		}
		console.log(`curriculum OK — ${next.stopCount} stops, ~${next.estimatedMinutes} min`);
		return;
	}

	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(next, null, '\t') + '\n');
	console.log(
		`Wrote ${args.out} — ${next.stopCount} stops across ${next.sections.length} chapters, ~${next.estimatedMinutes} min.`,
	);
}

main();
