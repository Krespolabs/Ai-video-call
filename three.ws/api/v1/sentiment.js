// POST /api/v1/sentiment — classify text sentiment.
//
// Unified-API surface over the same deterministic lexicon scorer that backs
// /api/sentiment and /api/social/sentiment (src/social/sentiment.js), so the
// classification is identical no matter which door a caller comes through.

import { defineEndpoint, fail } from '../_lib/gateway.js';
import { scoreSentiment } from '../../src/social/sentiment.js';

export default defineEndpoint({
	name: 'v1.sentiment',
	method: 'POST',
	auth: 'public',
	handler: ({ body }) => {
		const text = typeof body?.text === 'string' ? body.text.trim() : '';
		if (!text) fail(400, 'validation_error', '"text" must be a non-empty string');

		const r = scoreSentiment([{ text }]);
		let sentiment = 'Neutral';
		if (r.posPct > 0 && r.posPct >= r.negPct) sentiment = 'Positive';
		else if (r.negPct > 0) sentiment = 'Negative';

		return {
			sentiment,
			score: r.score,
			positive_pct: r.posPct,
			negative_pct: r.negPct,
		};
	},
});
