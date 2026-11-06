// GET /api/marketplace — canonical alias for /api/marketplace/agents.
// Callers that omit the sub-path get the agents list directly, no round-trip.
import handler from './marketplace/[action].js';

export default (req, res) => {
	const url = new URL(req.url, 'http://x');
	// Rewrite the path so the downstream handler sees /api/marketplace/agents.
	url.pathname = '/api/marketplace/agents';
	req.url = url.pathname + (url.search || '');
	return handler(req, res);
};
