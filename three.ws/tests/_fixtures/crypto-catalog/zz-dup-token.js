// Fixture: a second entry claiming the SAME route as token.js. The first one
// wins (sorted by filename); this duplicate is skipped so the catalog never
// advertises the same GET path twice.
export default {
	slug: 'token-dupe',
	method: 'GET',
	path: '/api/crypto/token',
	title: 'Duplicate of token',
};
