// Fixture: throws at import time. Must be SKIPPED, not fatal.
throw new Error('boom: this entry blows up on import');
// eslint-disable-next-line no-unreachable
export default { slug: 'never', method: 'GET', path: '/api/3d/never', summary: 'x' };
