// @ts-check
// Build a real OpenAPI 3.1 document FROM the Crypto Data API catalog entries.
//
// The catalog (see ./index.js) is the single source of truth; this renders it
// into the spec agents and tooling (Swagger UI, openapi-generator, LangChain's
// OpenAPI toolkit, etc.) consume. Every path, parameter, and response schema
// comes from an entry's `path` / `inputSchema` / `outputSchema` — nothing is
// hand-maintained, so the spec can never drift from what `/api/crypto` lists.
//
// Input flexibility: a sibling entry may express `inputSchema` either as a
// JSON-Schema object (`{ type:'object', properties:{…}, required:[…] }`) or as
// an array of OpenAPI parameter objects. Both are handled; a param whose name
// appears in the path as `{name}` is emitted as a required path parameter, the
// rest as query parameters (the free endpoints are keyless GETs).

/**
 * @param {string} path e.g. "/api/crypto/token"
 * @returns {Set<string>} names of `{templated}` path segments
 */
function pathParamNames(path) {
	const names = new Set();
	const re = /\{([^}]+)\}/g;
	let m;
	while ((m = re.exec(path))) names.add(m[1]);
	return names;
}

/**
 * Normalize one property descriptor into an OpenAPI Schema Object.
 * @param {any} prop
 */
function toSchema(prop) {
	if (!prop || typeof prop !== 'object') return { type: 'string' };
	const { description, example, ...schema } = prop;
	if (!schema.type && !schema.oneOf && !schema.anyOf && !schema.$ref) schema.type = 'string';
	return schema;
}

/**
 * Does this object look like a bare param map — `{ name: {type, in, required,
 * description, example} }` — rather than a JSON-Schema object? Used to support
 * the terser entry style some siblings adopted (no `type:'object'`/`properties`
 * envelope, each key a parameter descriptor).
 * @param {any} obj
 */
function looksLikeParamMap(obj) {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
	if (obj.type || obj.properties || obj.$ref || obj.oneOf || obj.anyOf || obj.allOf) return false;
	const vals = Object.values(obj);
	return vals.length > 0 && vals.every((v) => v && typeof v === 'object');
}

/** Build one query/path parameter from a `{type,in,required,description,example}` descriptor. */
function paramFromDescriptor(name, desc, inPath) {
	/** @type {any} */
	const d = desc || {};
	const isPath = d.in === 'path' || inPath.has(name);
	const { in: _in, required: _req, description, example, ...rest } = d;
	return {
		name,
		in: isPath ? 'path' : d.in || 'query',
		required: isPath || d.required === true,
		...(description ? { description } : {}),
		schema: toSchema(rest),
		...(example !== undefined ? { example } : {}),
	};
}

/**
 * Convert an entry's input contract into an OpenAPI `parameters` array. Accepts
 * a JSON-Schema object, an OpenAPI parameter array, or a bare param map.
 * @param {any} inputSchema
 * @param {Set<string>} inPath
 * @returns {Array<object>}
 */
function toParameters(inputSchema, inPath) {
	if (!inputSchema) {
		// Still emit path params so a templated route documents its required ids.
		return [...inPath].map((name) => ({
			name,
			in: 'path',
			required: true,
			schema: { type: 'string' },
		}));
	}

	// Already an OpenAPI parameter array — pass through, defaulting `in`.
	if (Array.isArray(inputSchema)) {
		return inputSchema
			.filter((p) => p && typeof p === 'object' && typeof p.name === 'string')
			.map((p) => ({
				name: p.name,
				in: p.in || (inPath.has(p.name) ? 'path' : 'query'),
				required: p.required ?? inPath.has(p.name),
				...(p.description ? { description: p.description } : {}),
				schema: p.schema || toSchema(p),
				...(p.example !== undefined ? { example: p.example } : {}),
			}));
	}

	// Bare param map (no JSON-Schema envelope) → one param per key.
	let params;
	if (looksLikeParamMap(inputSchema)) {
		params = Object.entries(inputSchema).map(([name, desc]) =>
			paramFromDescriptor(name, desc, inPath),
		);
	} else {
		// JSON-Schema object → one parameter per property.
		const properties =
			inputSchema.properties && typeof inputSchema.properties === 'object'
				? inputSchema.properties
				: {};
		const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
		params = Object.entries(properties).map(([name, prop]) => {
			const isPath = inPath.has(name);
			/** @type {any} */
			const p = prop || {};
			return {
				name,
				in: isPath ? 'path' : 'query',
				required: isPath || required.has(name),
				...(p.description ? { description: p.description } : {}),
				schema: toSchema(p),
				...(p.example !== undefined ? { example: p.example } : {}),
			};
		});
	}

	// A `{templated}` segment with no matching property still needs a param entry.
	for (const name of inPath) {
		if (!params.some((p) => p.name === name)) {
			params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
		}
	}
	return params;
}

/**
 * Build the response schema for an entry from its `outputSchema`. Accepts a full
 * JSON-Schema object or a bare `{ field: … }` map whose values may be nested
 * schema objects OR plain-text descriptions (the terser sibling style) — the
 * latter are coerced to `{ description }` so the emitted schema stays valid.
 * @param {any} outputSchema
 */
function toResponseSchema(outputSchema) {
	if (outputSchema && typeof outputSchema === 'object' && !Array.isArray(outputSchema)) {
		if (outputSchema.type || outputSchema.properties || outputSchema.$ref) return outputSchema;
		const properties = {};
		for (const [k, v] of Object.entries(outputSchema)) {
			properties[k] =
				typeof v === 'string'
					? { description: v }
					: v && typeof v === 'object'
						? v
						: { description: String(v) };
		}
		return { type: 'object', properties };
	}
	// No declared schema: document a free-form JSON object rather than lie.
	return { type: 'object', additionalProperties: true };
}

/**
 * @param {Array<{slug:string,method:string,path:string,title?:string,summary?:string,inputSchema?:any,outputSchema?:any,example?:any}>} entries
 * @param {{ origin?: string, version?: string }} [opts]
 * @returns {object} OpenAPI 3.1 document
 */
export function buildOpenApiDoc(entries, { origin = 'https://three.ws', version = '1.0.0' } = {}) {
	/** @type {Record<string, any>} */
	const paths = {};

	for (const e of entries) {
		const inPath = pathParamNames(e.path);
		const parameters = toParameters(e.inputSchema, inPath);
		const responseExample =
			e.example !== undefined && e.example !== null ? { example: e.example } : {};
		// An entry may answer more than one verb (e.g. GET + POST on /symbol).
		const verbs = Array.isArray(e.methods) && e.methods.length ? e.methods : [e.method];
		for (const verb of verbs) {
			const op = {
				operationId: verbs.length > 1 ? `${e.slug}_${verb.toLowerCase()}` : e.slug,
				summary: e.title || e.slug,
				...(e.summary ? { description: e.summary } : {}),
				tags: ['crypto'],
				parameters,
				responses: {
					200: {
						description: e.summary || `${e.title || e.slug} response`,
						content: {
							'application/json': {
								schema: toResponseSchema(e.outputSchema),
								...responseExample,
							},
						},
					},
					400: { description: 'Invalid or missing input.' },
					429: { description: 'Rate limited — retry after the `Retry-After` header.' },
					503: { description: 'Upstream data source temporarily unavailable.' },
				},
			};
			if (!paths[e.path]) paths[e.path] = {};
			paths[e.path][verb.toLowerCase()] = op;
		}
	}

	return {
		openapi: '3.1.0',
		info: {
			title: 'three.ws Crypto Data API',
			version,
			description:
				'A free, keyless crypto data bundle for AI agents — token snapshots, ' +
				'holders, security checks, bonding status, whale activity, wallet ' +
				'portfolios, trending, and symbol availability, all from one origin. ' +
				'No account, no API key. See https://three.ws/docs/crypto-api.',
			contact: { name: 'three.ws', url: 'https://three.ws', email: 'support@three.ws' },
			license: { name: 'Free to use', url: 'https://three.ws/docs/crypto-api' },
		},
		servers: [{ url: origin, description: 'three.ws production' }],
		tags: [
			{
				name: 'crypto',
				description: 'Free, keyless crypto market & on-chain data endpoints.',
			},
		],
		paths,
	};
}

/**
 * Minimal structural assertion used by tests and by any caller that wants to
 * fail fast on a malformed doc. Returns an array of problems (empty = valid).
 * Not a full JSON-Schema validation of the OpenAPI meta-schema — it checks the
 * required top-level fields OpenAPI 3.1 mandates plus per-operation invariants.
 * @param {any} doc
 * @returns {string[]}
 */
export function validateOpenApiDoc(doc) {
	const problems = [];
	if (!doc || typeof doc !== 'object') return ['document is not an object'];
	if (doc.openapi !== '3.1.0') problems.push(`openapi must be "3.1.0", got ${doc.openapi}`);
	if (!doc.info || typeof doc.info !== 'object') problems.push('info object missing');
	else {
		if (!doc.info.title) problems.push('info.title missing');
		if (!doc.info.version) problems.push('info.version missing');
	}
	if (!doc.paths || typeof doc.paths !== 'object') problems.push('paths object missing');
	else {
		for (const [p, item] of Object.entries(doc.paths)) {
			if (!p.startsWith('/')) problems.push(`path "${p}" must start with "/"`);
			for (const [verb, op] of Object.entries(/** @type {any} */ (item))) {
				if (!HTTP_VERBS.has(verb)) continue;
				const o = /** @type {any} */ (op);
				if (!o.responses || typeof o.responses !== 'object')
					problems.push(`${verb.toUpperCase()} ${p}: responses missing`);
				if (!Array.isArray(o.parameters))
					problems.push(`${verb.toUpperCase()} ${p}: parameters must be an array`);
			}
		}
	}
	return problems;
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
