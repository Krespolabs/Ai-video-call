/**
 * Sentiment Scout: sourced momentum candidates, every claim with its receipt.
 *
 *   GET /api/pump/sentiment-scout                 the board: top candidates now
 *       &window=60         minutes of launches to rank against (15-240)
 *       &limit=5           candidates to return (1-10)
 *       &network=mainnet
 *       &notes=0           skip the LLM-written "Scout's read" per candidate
 *       &track=1           include the Scout's graded track record
 *   GET /api/pump/sentiment-scout?mint=<mint>     one coin's Scout read, even if
 *                                                  it would not make the board
 *
 * Each candidate: { mint, ticker, momentum_score, score_parts, evidence[],
 * caution, market_check, x, posts[], note?, links, unavailable[] }. Every
 * evidence line carries `source` (a URL a reader can open), `at` (when the fact
 * was true) and, for social or paid claims, `checked_against` (the on-chain
 * facts read in the same run). Sources that could not be read are named in
 * `unavailable` rather than estimated. The Scout never trades.
 *
 * Public, CORS-open, IP rate-limited. Logic and honesty rules live in
 * api/_lib/sentiment-scout.js; the note layer in api/_lib/scout-notes.js.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { runSentimentScout, scoutTrackRecord } from '../_lib/sentiment-scout.js';
import { writeScoutNotes } from '../_lib/scout-notes.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NETWORKS = new Set(['mainnet', 'devnet']);

export const maxDuration = 60;

/** Attach validated notes to candidates. Never throws, never blocks on a dead chain. */
export async function withNotes(candidates, writer = writeScoutNotes) {
	if (!candidates.length) return candidates;
	const notes = await writer(candidates).catch(() => new Map());
	return candidates.map((c) => {
		const n = notes.get(c.mint);
		return n ? { ...c, note: n.note, note_model: n.model } : { ...c, note: null, note_model: null };
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = params.get('network') || 'mainnet';
	if (!NETWORKS.has(network)) return error(res, 400, 'invalid_network', 'network must be mainnet or devnet');
	const mint = (params.get('mint') || '').trim() || null;
	if (mint && !BASE58_RE.test(mint)) return error(res, 400, 'invalid_mint', 'mint must be a base58 Solana address');
	const wantNotes = params.get('notes') !== '0';
	const wantTrack = params.get('track') === '1';

	const [scout, track] = await Promise.all([
		runSentimentScout({
			network,
			mint,
			windowMinutes: params.get('window'),
			limit: params.get('limit'),
		}),
		wantTrack ? scoutTrackRecord(network).catch(() => null) : null,
	]);

	const candidates = wantNotes ? await withNotes(scout.candidates) : scout.candidates;
	const body = { ...scout, candidates };
	if (wantTrack) body.track_record = track;

	return json(res, 200, body, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
