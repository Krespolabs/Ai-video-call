import { describe, it, expect } from 'vitest';

// The stdio @three-ws/mcp-server package. buildTools() returns the exact tool
// surface registerTool() hands the MCP client — name, title, description,
// inputSchema, annotations — so asserting on it asserts on the tools/list wire
// payload. It is side-effect-free w.r.t. payment env, so it is safe to call
// here without secrets.
//
// The hosted HTTP servers are covered by mcp-remote-annotations.test.js; this is
// the matching invariant for the published stdio package, which had no test —
// the gap that let read-only tools ship without an explicit destructiveHint
// (the MCP spec defaults destructiveHint to TRUE when omitted, silently marking
// an annotation-less tool destructive).
import { buildTools } from '../mcp-server/src/index.js';

const tools = await buildTools();

// The stdio package exposes no irreversible delete/spend tools today: every tool
// is a read (lookups/snapshots/resolves) or a non-destructive generation
// (mesh/avatar/rig/delegate). If a genuinely destructive tool is ever added,
// pin it here AND set destructiveHint: true on it.
const DESTRUCTIVE_TOOLS = new Set();

describe('@three-ws/mcp-server stdio tool surface', () => {
	it('exposes a non-empty tool set', () => {
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.length).toBeGreaterThan(0);
	});

	it('tool names are unique', () => {
		const names = tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('tool titles are unique', () => {
		const titles = tools.map((t) => t.title);
		expect(new Set(titles).size).toBe(titles.length);
	});

	it('every tool has a name, a human title, and a description', () => {
		for (const t of tools) {
			expect(typeof t.name, `${t.name}: name`).toBe('string');
			expect(t.name.length).toBeGreaterThan(0);
			expect(typeof t.title, `${t.name}: title`).toBe('string');
			expect(t.title.length, `${t.name}: title`).toBeGreaterThan(0);
			expect(typeof t.description, `${t.name}: description`).toBe('string');
			expect(t.description.length, `${t.name}: description`).toBeGreaterThan(0);
		}
	});

	it('every tool carries complete, explicit boolean annotations', () => {
		for (const t of tools) {
			const a = t.annotations;
			expect(a, `${t.name}: annotations`).toBeTypeOf('object');
			for (const hint of [
				'readOnlyHint',
				'destructiveHint',
				'idempotentHint',
				'openWorldHint',
			]) {
				expect(typeof a[hint], `${t.name}: ${hint}`).toBe('boolean');
			}
		}
	});

	it('only pinned destructive tools advertise destructiveHint: true', () => {
		for (const t of tools) {
			const a = t.annotations;
			if (DESTRUCTIVE_TOOLS.has(t.name)) {
				expect(a.destructiveHint, `${t.name}: destructiveHint`).toBe(true);
				expect(a.readOnlyHint, `${t.name}: readOnlyHint`).toBe(false);
			} else {
				expect(a.destructiveHint, `${t.name}: destructiveHint`).toBe(false);
			}
			// A read-only tool can never be destructive.
			if (a.readOnlyHint) {
				expect(a.destructiveHint, `${t.name}: read-only yet destructive`).toBe(false);
			}
		}
	});
});
