// Fixture: the terser sibling style — `input`/`output` (aliases for
// inputSchema/outputSchema), a bare param map, string-valued output fields, and
// a multi-verb `methods` array. Exercises the assembler's aliasing + the
// OpenAPI generator's param-map and string-property coercion.
export default {
	slug: 'paramstyle',
	method: 'GET',
	methods: ['GET', 'POST'],
	path: '/api/crypto/paramstyle/{mint}',
	title: 'Param-Map Style',
	summary: 'Exercises the terse input/output descriptor form.',
	input: {
		mint: {
			type: 'string',
			required: true,
			in: 'path',
			description: 'Token mint',
			example: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		},
		verbose: { type: 'boolean', description: 'Include extra fields' },
	},
	output: {
		mint: 'string',
		ok: 'boolean — always true on success',
	},
	example: '/api/crypto/paramstyle/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};
