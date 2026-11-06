// Fixture: valid entry, slug/method/inputSchema style.
export default {
	slug: 'generate',
	method: 'post',
	path: '/api/3d/generate',
	title: 'Text → 3D (free draft)',
	summary: 'Turn a text prompt into a GLB.',
	inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
	outputSchema: { type: 'object', properties: { status: { type: 'string' } } },
	example: { request: { prompt: 'a robot' }, response: { status: 'pending' } },
};
