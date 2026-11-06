// Bazaar discovery helpers — wraps the @x402/extensions/bazaar declarators
// with the bits our paidEndpoint() wrapper expects.
//
// USE-13: every paid endpoint in the repo advertises a v2 `bazaar` extension
// so the CDP / agentic.market / x402.org facilitators can index it. The
// declared shape MUST match the BazaarServerExtension's expectations exactly
// — deviating causes the validator to reject the endpoint with "v2 discovery
// extension validation failed" even when the 402 challenge is otherwise
// well-formed.
//
// We expose three things:
//   1. declareHttpDiscovery({...}) — returns the bazaar inner object
//      ({discoverable, info, schema}) for an HTTP endpoint. Pass it directly
//      as paidEndpoint({ bazaar: ... }).
//   2. declareMcpDiscovery({...}) — same shape for an MCP tool. Each paid
//      tool needs its own entry: facilitators key MCP catalog rows on
//      (resourceUrl, toolName), not on resourceUrl alone.
//   3. THREEWS_SERVICE — default resource-level service metadata
//      (serviceName, tags, iconUrl) the facilitator surfaces in search
//      results. Per-route helpers below merge specific tags on top of this.
//
// Spec: /tmp/x402-docs/specs/extensions/bazaar.md
//       /tmp/x402-docs/docs/extensions/bazaar.mdx

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { declareDiscoveryExtension } from '@x402/extensions';

import { buildBazaarSchema } from '../x402-spec.js';
import { env } from '../env.js';

// Resource-level service metadata. Per spec §"Service Metadata":
//   • serviceName: ≤32 printable ASCII chars
//   • tags:        up to 5 entries, each ≤32 printable ASCII chars
//   • iconUrl:     absolute http(s) URL (≤2048 chars, no IP literals)
// Facilitators apply soft-drop rules: a field that fails validation is
// silently discarded but the rest survive, so keeping every field within
// the limits is purely a matter of getting cataloged with full metadata.
export const THREEWS_SERVICE = Object.freeze({
	serviceName: 'three.ws',
	tags: ['x402', 'mcp', '3d', 'agent', 'solana'],
	iconUrl: 'https://three.ws/favicon.ico',
});

// Merge per-route service metadata on top of the three.ws defaults. Pass
// `{ serviceName, tags, iconUrl }` per endpoint; missing fields fall back
// to the default. `tags` REPLACES the default tag list when provided —
// callers know which tags actually describe their route.
export function withService(custom = {}) {
	const out = {
		serviceName: THREEWS_SERVICE.serviceName,
		tags: [...THREEWS_SERVICE.tags],
		iconUrl: THREEWS_SERVICE.iconUrl,
	};
	if (typeof custom.serviceName === 'string' && custom.serviceName.length) {
		out.serviceName = custom.serviceName;
	}
	if (Array.isArray(custom.tags) && custom.tags.length) {
		out.tags = custom.tags.slice(0, 5);
	}
	if (typeof custom.iconUrl === 'string' && custom.iconUrl.length) {
		out.iconUrl = custom.iconUrl;
	}
	// Anchor relative icon paths against APP_ORIGIN — facilitators reject
	// non-absolute iconUrl per the SSRF defense in the spec.
	if (out.iconUrl && !/^https?:\/\//i.test(out.iconUrl)) {
		out.iconUrl = `${env.APP_ORIGIN}${out.iconUrl.startsWith('/') ? '' : '/'}${out.iconUrl}`;
	}
	return out;
}

// Build the v2 HTTP bazaar discovery entry for a route. Returns the inner
// `{ discoverable, info, schema }` object (NOT wrapped in `{ bazaar: ... }`)
// because our paidEndpoint helper takes that inner shape directly.
//
// Args (mirrors agentic.market's declareDiscoveryExtension):
//   method       — 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
//   input        — example query params or body (for the spec UI)
//   inputSchema  — JSON Schema for the query/body params
//   output       — { example, schema } for the response body
//   bodyType     — 'json' | 'form-data' | 'text' (required for POST/PUT/PATCH)
//
// The wrapped declareDiscoveryExtension call asserts our payload matches the
// SDK's runtime expectations — when the SDK ships a stricter validator we
// pick it up automatically rather than silently emitting a stale shape.
export function declareHttpDiscovery({
	method = 'GET',
	input,
	inputSchema,
	output,
	bodyType,
} = {}) {
	const upper = String(method).toUpperCase();
	const isBody = ['POST', 'PUT', 'PATCH'].includes(upper);

	// Run the SDK declarator for its side effect: in v2 it returns
	// `{ bazaar: { info, schema, ... } }`. We extract the inner entry so
	// our paidEndpoint helper can plug it straight into the 402 challenge.
	const sdkConfig = isBody
		? {
			method: upper,
			bodyType: bodyType || 'json',
			input: input ?? {},
			inputSchema: inputSchema || { properties: {} },
			output: output || undefined,
		}
		: {
			method: upper,
			input: input ?? undefined,
			inputSchema: inputSchema || undefined,
			output: output || undefined,
		};

	let sdkBlock;
	try {
		sdkBlock = declareDiscoveryExtension(sdkConfig);
	} catch (err) {
		throw new Error(`declareHttpDiscovery: SDK rejected config: ${err.message}`);
	}
	const sdkInner = sdkBlock?.bazaar || Object.values(sdkBlock || {})[0];

	// Belt-and-braces: rebuild the meta-schema with our own buildBazaarSchema
	// so it stays in sync with what agentic.market's validator expects. The
	// SDK's schema is structurally equivalent but slightly more permissive in
	// `additionalProperties` placement — running through buildBazaarSchema
	// guarantees the exact shape that has been validated against the CDP
	// Bazaar's discovery probe.
	const info = sdkInner?.info || {};
	const inputInfo = info.input || {};

	// The meta-schema closes `input` to additional properties, so it has to
	// describe `queryParams` whenever info carries them. A route that gives
	// example params but no param schema used to get an info block its own
	// schema rejected, which is the mismatch CDP drops a listing for.
	const queryParamsSchema = inputSchema || (inputInfo.queryParams !== undefined ? {} : undefined);
	const schema = buildBazaarSchema({
		method: upper,
		queryParamsSchema: isBody ? undefined : queryParamsSchema,
		bodyType: isBody ? bodyType || 'json' : undefined,
		bodySchema: isBody ? inputSchema : undefined,
		outputSchema: output?.schema,
	});

	// Surface the response example/schema in the same shape buildBazaarSchema
	// expects. The SDK already nests these under info.output but only when an
	// `output` arg was passed; we re-normalize so consumers can rely on the
	// shape unconditionally.
	const outputInfo = output
		? {
			type: 'json',
			...(output.example !== undefined ? { example: output.example } : {}),
		}
		: info.output;

	return {
		discoverable: true,
		info: {
			input: { ...inputInfo, type: 'http', method: upper },
			...(outputInfo ? { output: outputInfo } : {}),
		},
		schema,
	};
}

// Build the v2 MCP bazaar discovery entry for a paid tool. The catalog
// uniqueness key is (resource, toolName) — every paid tool needs its own
// entry so search can find them individually.
//
// Args:
//   toolName     — the MCP tool name (matches the `tools/call` `name` arg)
//   description  — human-readable summary (optional but recommended)
//   transport    — 'streamable-http' (default) | 'sse'
//   inputSchema  — MCP Tool.inputSchema (JSON Schema object)
//   example      — example arguments object (for the spec UI)
//   output       — { example, schema } for the result payload
export function declareMcpDiscovery({
	toolName,
	description,
	transport = 'streamable-http',
	inputSchema,
	example,
	output,
} = {}) {
	if (!toolName || typeof toolName !== 'string') {
		throw new Error('declareMcpDiscovery: toolName is required');
	}
	if (!inputSchema || typeof inputSchema !== 'object') {
		throw new Error('declareMcpDiscovery: inputSchema is required');
	}

	const sdkConfig = {
		toolName,
		description,
		transport,
		inputSchema,
		example,
		output,
	};
	let sdkBlock;
	try {
		sdkBlock = declareDiscoveryExtension(sdkConfig);
	} catch (err) {
		throw new Error(`declareMcpDiscovery: SDK rejected config: ${err.message}`);
	}
	const sdkInner = sdkBlock?.bazaar || Object.values(sdkBlock || {})[0];
	// Force the top-level `discoverable: true` flag. The SDK's inner block omits
	// it, but CDP Bazaar / agentic.market only catalog a resource whose bazaar
	// extension is explicitly discoverable — without this, every priced MCP tool
	// row is silently skipped by the discovery crawler. declareHttpDiscovery sets
	// the same flag for REST routes; this keeps MCP rows at parity.
	return { ...sdkInner, discoverable: true };
}

// Bring whatever a route passed as `bazaar` to a canonical v2 entry,
// `{ discoverable, info: { input, output }, schema }`, whose info validates
// against its own schema. That self-validation is the strict check CDP runs
// before it catalogs a resource, and marketplace validators read it off the
// live 402, so it is the pass-through test here too.
//
// Three shapes reach this point that fail it:
//   - flat, pre-v2: `{ description, useCases, input: { type: 'query' | 'json',
//     example, schema }, output }`, with no `info` block at all;
//   - hybrid: an `info` wrapper around that same legacy input;
//   - v2 by hand, but drifted from its schema (no `bodyType`, stray keys).
// paidEndpoint() used to forward all of them verbatim. The discovery document
// rebuilds its own entries and looked fine, which hid it. Each is rebuilt from
// its parts through declareHttpDiscovery; a valid entry, and any MCP entry
// (built by declareMcpDiscovery), passes through untouched.
const bazaarAjv = new Ajv2020({ allErrors: false, strict: false });
addFormats(bazaarAjv);

function infoMatchesSchema(entry) {
	if (!entry?.info?.input || !entry.schema) return false;
	try {
		return bazaarAjv.compile(entry.schema)(entry.info) === true;
	} catch {
		return false;
	}
}

export function normalizeBazaarEntry(bazaar, { method = 'GET' } = {}) {
	const entry = bazaar || {};
	const input = entry.info?.input ?? entry.input ?? {};
	if (input.type === 'mcp' || infoMatchesSchema(entry)) return entry;

	const upper = String(input.method || method).toUpperCase();
	const isBody = ['POST', 'PUT', 'PATCH'].includes(upper);
	const isV2Input = input.type === 'http';
	const part = isBody ? 'body' : 'queryParams';
	// Some hand-written blocks carry the example as `bodyExample`, a key the v2
	// schema does not define, so it counts as the example rather than as drift.
	const example = isV2Input ? input[part] ?? input.bodyExample ?? input.example : input.example;
	const inputSchema = isV2Input ? entry.schema?.properties?.input?.properties?.[part] : input.schema;
	const hasExample = example && typeof example === 'object' && Object.keys(example).length > 0;

	const declaredOutput = entry.info?.output ?? entry.output;
	const outputSchema = isV2Input ? undefined : declaredOutput?.schema;
	const output =
		declaredOutput && (declaredOutput.example !== undefined || outputSchema)
			? { example: declaredOutput.example, schema: outputSchema }
			: undefined;

	const rebuilt = declareHttpDiscovery({
		method: upper,
		input: hasExample || isBody ? example : undefined,
		inputSchema,
		output,
		bodyType: isBody ? input.bodyType || 'json' : undefined,
	});
	return entry.discoverable === false ? { ...rebuilt, discoverable: false } : rebuilt;
}

// Convenience: returns the full extensions block `{ bazaar: <inner> }` for
// callers that want to spread it straight into a payment-wrapper config.
// Matches the v2 SDK call signature ({ method, input, inputSchema, output, … })
// but always returns OUR canonical inner shape via declareHttpDiscovery.
export function declareDiscovery(config = {}) {
	return { bazaar: declareHttpDiscovery(config) };
}
