// Catalog entry for the free 3D Inspect endpoint. The /api/3d index (prompt 14)
// globs api/_lib/3d-catalog/*.js and merges every default export into the public
// API catalog + the generated OpenAPI doc. Each entry is a self-describing,
// OpenAPI-friendly record: path, methods, input/output schemas, and a live
// example. Same entry shape as the crypto catalog — one file per endpoint so
// parallel agents never edit a shared list.

export default {
	id: 'inspect',
	name: '3D Model Inspect & Validate',
	path: '/api/3d/inspect',
	methods: ['GET', 'POST'],
	free: true,
	keyless: true,
	category: '3d',
	tags: ['3d', 'gltf', 'glb', 'validation', 'inspection', 'optimization'],
	summary:
		'Validate a glTF/GLB and return structural stats plus a prioritized optimization plan.',
	description:
		'Fetches a glTF (.gltf) or binary glTF (.glb) from a URL (or accepts a raw upload), runs ' +
		'the Khronos glTF-Validator for the spec-compliance verdict, and reports structural stats ' +
		'(vertices, triangles, materials, textures, animations, extensions) plus a severity-ranked ' +
		'list of make-it-smaller/faster recommendations. Free, keyless, no account.',
	useCase:
		'An autonomous agent handling a 3D asset from any source validates it and sizes it up — ' +
		'is it spec-valid, how heavy is it, what should it optimize — before committing to use it. ' +
		'Free adoption funnels to the paid Forge Pro quality tiers, Rigged Avatars, and mesh ' +
		'optimization pipelines.',
	input: {
		query: {
			url: {
				type: 'string',
				format: 'uri',
				required: false,
				description: 'Public https URL of a .glb or .gltf model (≤32 MiB).',
			},
		},
		body: {
			description:
				'POST { "url": "…" } as application/json, OR upload raw .glb/.gltf bytes as the request body.',
		},
	},
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			url: {
				type: 'string',
				format: 'uri',
				description: 'Public https URL of a glTF (.gltf) or binary glTF (.glb) model. Max 32 MiB.',
			},
		},
	},
	outputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['valid', 'stats', 'sizeBytes', 'recommendations', 'ts'],
		properties: {
			url: { type: ['string', 'null'], format: 'uri' },
			valid: { type: 'boolean' },
			sizeBytes: { type: 'integer' },
			stats: {
				type: 'object',
				required: ['vertices', 'triangles', 'materials', 'textures', 'animations', 'extensions'],
				properties: {
					vertices: { type: 'integer' },
					triangles: { type: 'integer' },
					materials: { type: 'integer' },
					textures: { type: 'integer' },
					animations: { type: 'integer' },
					extensions: { type: 'array', items: { type: 'string' } },
					meshes: { type: 'integer' },
					nodes: { type: 'integer' },
					scenes: { type: 'integer' },
					skins: { type: 'integer' },
					joints: { type: 'integer' },
					container: { type: 'string', enum: ['glb', 'gltf'] },
					generator: { type: ['string', 'null'] },
				},
			},
			recommendations: {
				type: 'array',
				items: {
					type: 'object',
					required: ['severity', 'issue', 'fix'],
					properties: {
						severity: { type: 'string', enum: ['critical', 'warn', 'info'] },
						issue: { type: 'string' },
						fix: { type: 'string' },
					},
				},
			},
			validation: {
				type: 'object',
				properties: {
					valid: { type: 'boolean' },
					validatorVersion: { type: ['string', 'null'] },
					numErrors: { type: 'integer' },
					numWarnings: { type: 'integer' },
					numInfos: { type: 'integer' },
					numHints: { type: 'integer' },
				},
			},
			ts: { type: 'string', format: 'date-time' },
		},
	},
	example: {
		request: 'GET /api/3d/inspect?url=https://three.ws/avatars/cesium-man.glb',
		response: {
			url: 'https://three.ws/avatars/cesium-man.glb',
			valid: true,
			sizeBytes: 495956,
			stats: {
				vertices: 3272,
				triangles: 4672,
				materials: 1,
				textures: 1,
				animations: 1,
				extensions: [],
				meshes: 1,
				nodes: 22,
				scenes: 1,
				skins: 1,
				joints: 19,
				container: 'glb',
				generator: 'COLLADA2GLTF',
			},
			recommendations: [
				{
					severity: 'info',
					issue: 'Model looks well-optimized for web delivery — no suggestions flagged.',
					fix: 'No action needed — the model is already well-suited for web delivery.',
				},
			],
			validation: { valid: true, numErrors: 0, numWarnings: 0, numInfos: 0, numHints: 0 },
			ts: '2026-07-07T00:00:00.000Z',
		},
	},
};
