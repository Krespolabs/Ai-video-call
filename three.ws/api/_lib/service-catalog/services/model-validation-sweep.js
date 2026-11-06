// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'model-validation-sweep',
	title: 'Model Validation Sweep',
	category: '3d',
	useCase: 'three.ws model quality sweep — picks the next public GLB avatar in the database that has never been inspected (or whose inspection is older than 24 hours), downloads the file, runs the glTF-Transform inspector, computes a 0-100 quality score, and records a time-series row.',
	path: '/api/x402/model-validation-sweep',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Model Validation Sweep',
	tags: ['3d', 'gltf', 'glb', 'validation', 'quality'],
	description: 'three.ws model quality sweep — picks the next public GLB avatar in the database that has never been inspected (or whose inspection is older than 24 hours), downloads the file, runs the glTF-Transform inspector, computes a 0-100 quality score, and records a time-series row. Use to proactively detect geometry errors, missing rigs, and unsupported features before users encounter them in the viewer.',
	input: {},
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {},
	},
	storefronts: ['x402scan'],
};
