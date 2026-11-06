// Fixture: valid entry in the ALTERNATE naming style (id/name/methods/input).
// Proves the assembler accepts both conventions instead of dropping this entry.
export default {
	id: 'inspect',
	name: '3D Model Inspect & Validate',
	path: '/api/3d/inspect',
	methods: ['GET', 'POST'],
	description: 'Validate a glTF/GLB and return stats + recommendations.',
	inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } },
	outputSchema: { type: 'object', required: ['valid'], properties: { valid: { type: 'boolean' } } },
};
