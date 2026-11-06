// Spatial MCP conformance validator — the public gate for 3D-native tool results.
//
// `validate_spatial_response` checks that a structured-content payload conforms to
// the open Spatial MCP artifact shape (specs/SPATIAL_MCP.md) and returns
// ACTIONABLE diagnostics — every problem names the offending path and the fix —
// so a third-party MCP server adopting the shape (or a three.ws tool self-checking
// its own output) can correct it. Free, read-only, and crypto-clean: it carries
// no payment, wallet, coin, or token surface, so it drops cleanly into the free
// OpenAI track. The validation core lives in api/_lib/spatial-mcp.js and is shared
// with the emitting tools so the gate and the emitters never drift.

import { validateSpatialArtifact, SPATIAL_MCP_VERSION } from '../../_lib/spatial-mcp.js';

const SPEC_URL = 'https://three.ws/specs/spatial-mcp';

export const toolDefs = [
	{
		name: 'validate_spatial_response',
		title: 'Validate a Spatial MCP 3D artifact',
		annotations: {
			readOnlyHint: true, // pure check — creates and mutates nothing
			destructiveHint: false,
			idempotentHint: true, // same payload → same verdict
			openWorldHint: false, // fully local; no external calls
		},
		description:
			'Check whether a structured-content payload conforms to the open Spatial MCP artifact shape — the ' +
			'standard for returning a live, interactive 3D scene as a first-class MCP tool result (scene GLB, camera, ' +
			'environment, animation, AR handoff, interaction affordances). Returns valid/invalid plus actionable ' +
			`errors and warnings (each naming the field and the fix), not just a boolean. Spec version ${SPATIAL_MCP_VERSION}. ` +
			'Use it to conform a third-party 3D tool result to the shape so any Spatial-MCP renderer can display it.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['artifact'],
			properties: {
				artifact: {
					type: 'object',
					description: 'The Spatial MCP artifact to validate (the structuredContent a 3D tool returns, or one you are building).',
				},
			},
		},
		async handler(args) {
			const result = validateSpatialArtifact(args?.artifact);
			const errLines = result.errors.map((e) => `  • ${e.path}: ${e.message}`);
			const warnLines = result.warnings.map((w) => `  • ${w.path}: ${w.message}`);
			const text = result.valid
				? `Conformant Spatial MCP artifact (v${result.version || SPATIAL_MCP_VERSION}).` +
					(warnLines.length ? `\nWarnings:\n${warnLines.join('\n')}` : '')
				: `Not conformant. Fix these:\n${errLines.join('\n')}` +
					(warnLines.length ? `\nWarnings:\n${warnLines.join('\n')}` : '');
			return {
				content: [{ type: 'text', text }],
				structuredContent: {
					valid: result.valid,
					specVersion: SPATIAL_MCP_VERSION,
					spec: SPEC_URL,
					version: result.version,
					errors: result.errors,
					warnings: result.warnings,
				},
			};
		},
	},
];
