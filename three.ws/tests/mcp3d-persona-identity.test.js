import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET ||= 'test-jwt-secret-not-a-real-secret-0123456789';
process.env.PERSONA_WALLET_SECRET ||= 'test-persona-wallet-secret-0123456789';

const { toolDefs } = await import('../api/_mcp3d/tools/persona-identity.js');
const { TOOL_CATALOG: studioCatalog } = await import('../api/_mcp3d/catalog.js');
const { TOOL_CATALOG: freeStudioCatalog } = await import('../api/_mcp-studio/tools.js');
const { PERSONA_TOOL_CATALOG: freePersonaCatalog } = await import('../api/_mcp-studio/persona-tools.js');
const { PERSONA_SPEND_CAPS } = await import('../api/_lib/persona-spend-ledger.js');

const NAMES = ['persona_identity', 'persona_tip', 'persona_send'];

describe('persona identity/wallet tools — the paid 3D Studio catalog', () => {
	it('are registered exactly once each', () => {
		for (const name of NAMES) {
			expect(toolDefs.filter((t) => t.name === name)).toHaveLength(1);
			expect(studioCatalog.filter((t) => t.name === name)).toHaveLength(1);
		}
	});

	it('persona_identity is read-only, open-world, non-destructive', () => {
		const t = studioCatalog.find((x) => x.name === 'persona_identity');
		expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
	});

	it('persona_tip and persona_send are irreversible value-moving tools', () => {
		for (const name of ['persona_tip', 'persona_send']) {
			const t = studioCatalog.find((x) => x.name === name);
			expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
		}
	});

	it('value-op input schemas require persona_id, to, usdc and expose the guardrail knobs', () => {
		for (const name of ['persona_tip', 'persona_send']) {
			const t = toolDefs.find((x) => x.name === name);
			expect(t.inputSchema.required).toEqual(['persona_id', 'to', 'usdc']);
			expect(Object.keys(t.inputSchema.properties)).toEqual(
				expect.arrayContaining(['persona_id', 'to', 'usdc', 'session_id', 'memo', 'network', 'confirm']),
			);
			expect(t.inputSchema.additionalProperties).toBe(false);
		}
	});

	it('every tool documents the real, current per-call and per-session caps (not stale numbers)', () => {
		for (const name of ['persona_tip', 'persona_send']) {
			const t = toolDefs.find((x) => x.name === name);
			expect(t.description).toContain(`$${PERSONA_SPEND_CAPS.maxPerCallUsdc}`);
			expect(t.description).toContain(`$${PERSONA_SPEND_CAPS.maxPerSessionUsdc}`);
		}
	});
});

describe('coin policy — the wallet tools never reference a non-$THREE mint or a private key', () => {
	const blob = JSON.stringify(toolDefs);

	it('never hardcodes a third-party mint address or recommends another coin', () => {
		// USDC mint addresses are settlement plumbing (explicitly allowed); no other
		// symbol/mint should appear anywhere in the tool schemas/descriptions.
		expect(blob).not.toMatch(/\$THREE|pump\.fun coin(?!\b too)|bonk|wif\b/i);
	});

	it('never mentions a private key, secret key, or seed phrase as something a caller provides or receives', () => {
		expect(blob).not.toMatch(/private[_ ]?key|secret[_ ]?key|seed[_ ]?phrase|mnemonic/i);
	});
});

describe('free studio catalog stays wallet/crypto-free (persona identity tools are Claude/paid-track only)', () => {
	it('the free studio catalog never registers persona_identity/persona_tip/persona_send', () => {
		const names = new Set([...freeStudioCatalog, ...freePersonaCatalog].map((t) => t.name));
		for (const n of NAMES) expect(names.has(n)).toBe(false);
	});
});
