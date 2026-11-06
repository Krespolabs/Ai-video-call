// Catalog assembly for the hosted IBM Granite MCP server.
//
// TOOL_CATALOG is the tools/list payload: each tool's public schema plus the
// per-call price and a v2 `bazaar` discovery extension, both baked in at module
// load so the shared makeDispatcher can return it verbatim (no per-request
// enrichment, no changes to the shared dispatcher). TOOLS maps tool name →
// { handler, validate } for tools/call.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { declareMcpDiscovery } from '../_lib/x402/bazaar-helpers.js';
import { toolDefs } from './tools.js';
import { priceFor } from './pricing.js';

// `useDefaults` fills schema defaults (e.g. analysis_type → 'general'),
// `coerceTypes` accepts the string-form integers some MCP clients emit. Mirrors
// the main /api/mcp catalog's Ajv configuration.
const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);

// Public tools/list entries — strip the server-side `handler` and the spec-only
// `example`/`output` (carried into the bazaar extension instead), and attach
// pricing + discovery. `annotations` (read-only/destructive/idempotent/
// open-world hints) ride through to the wire verbatim.
export const TOOL_CATALOG = toolDefs.map((def) => {
	const price = priceFor(def.name);
	const entry = {
		name: def.name,
		title: def.title,
		description: def.description,
		annotations: def.annotations,
		inputSchema: def.inputSchema,
	};
	if (price) {
		entry.pricing = {
			amount_usdc: price.amount_usdc,
			currency: 'USDC',
			description: price.description,
			scheme: 'x402',
		};
		entry.extensions = {
			bazaar: declareMcpDiscovery({
				toolName: def.name,
				description: def.description,
				transport: 'streamable-http',
				inputSchema: def.inputSchema,
				example: def.example,
				output: def.output,
			}),
		};
	}
	return entry;
});

// Registered tools that carry no price — callable with neither an x402 payment
// nor an OAuth token. Currently just ibm_granite_getting_started. api/ibm-mcp.js
// reads this to serve a free, public entry point without the auth/payment gate.
const FREE_TOOLS = new Set(toolDefs.filter((def) => !priceFor(def.name)).map((def) => def.name));

export function isFreeTool(toolName) {
	return FREE_TOOLS.has(toolName);
}

// Handler + compiled validator lookup for tools/call.
export const TOOLS = Object.fromEntries(
	toolDefs.map((def) => [
		def.name,
		{
			handler: def.handler,
			validate: def.inputSchema ? ajv.compile(def.inputSchema) : null,
		},
	]),
);
