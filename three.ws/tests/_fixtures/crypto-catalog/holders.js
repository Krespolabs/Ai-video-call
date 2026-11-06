// Fixture: a well-formed entry exported as a named `entry` (the assembler
// accepts default, `entry`, or `catalogEntry`). Uses a templated path param and
// an array-style inputSchema to exercise both OpenAPI conversion branches.
export const entry = {
	slug: 'holders',
	method: 'GET',
	path: '/api/crypto/holders/{mint}',
	title: 'Top Holders',
	summary: 'Holder distribution for a mint.',
	inputSchema: [
		{ name: 'mint', in: 'path', required: true, schema: { type: 'string' } },
		{ name: 'limit', schema: { type: 'integer' }, description: 'Rows to return' },
	],
	outputSchema: { type: 'object', properties: { holders: { type: 'array' } } },
};
