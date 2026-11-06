// AI bounty judge — pure prompt-building + output-normalising logic.
//
// Kept free of any I/O imports (no db, no llm, no cache) so it can be unit
// tested in isolation and so importing it never drags in env-dependent modules.
// The endpoint (api/bounties/[id]/judge.js) wires this to the real LLM.

const CONTENT_CAP = 600; // per-submission text fed to the model
const VERDICT_CAP = 160;
const SUMMARY_CAP = 280;

// Build the system + user prompt for judging a bounty's submissions.
// `bounty`: { title, description }
// `subs`:   [{ id, username, content, media_url, media_type, like_count }]
export function buildJudgePrompt(bounty, subs) {
	const system = [
		'You are an impartial judge for a crypto bounty board.',
		'A poster set a task with a reward. People submitted proof of doing it. Score how well each submission fulfils the task.',
		'Judge on, in order: relevance to the task, quality and credibility of the proof (an attached photo / video / link is stronger evidence than a bare claim), effort, and originality.',
		'Community likes are a weak secondary signal — use them only to break near-ties, never as the main driver. Reward genuine fulfilment, not popularity.',
		'Give clearly off-topic, low-effort, spam, or unverifiable submissions low scores (under 35).',
		'Do not mention or name any cryptocurrency, coin, or token in your output.',
		'Respond with ONLY a single minified JSON object — no markdown, no code fence, no commentary — in exactly this shape:',
		'{"summary":"<=200 char read on the field and why your pick wins","recommended_id":"<one submission id>","rankings":[{"submission_id":"<id>","score":<integer 0-100>,"verdict":"<=120 char reason"}]}',
		'Include every submission in rankings, best first. recommended_id MUST be one of the provided submission ids.',
	].join('\n');

	const blocks = subs.map((s, i) => {
		const proof = s.media_url
			? `[${s.media_type || 'link'} attached: ${String(s.media_url).slice(0, 300)}]`
			: '[no media attached]';
		const text =
			(s.content || '').replace(/\s+/g, ' ').trim().slice(0, CONTENT_CAP) ||
			'(no description)';
		return [
			`Submission ${i + 1}`,
			`id: ${s.id}`,
			`author: ${s.username || 'anon'}`,
			`community_likes: ${s.like_count || 0}`,
			`proof: ${proof}`,
			`text: ${text}`,
		].join('\n');
	});

	const user = [
		`BOUNTY TITLE: ${bounty.title}`,
		`BOUNTY DETAILS: ${bounty.description?.trim() || '(none provided)'}`,
		'',
		`SUBMISSIONS (${subs.length}):`,
		blocks.join('\n\n'),
	].join('\n');

	return { system, user };
}

function clampScore(v) {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, n));
}

// Best-effort extraction of a JSON object from a model response that may be
// wrapped in prose or a ```json fence.
export function extractJson(text) {
	if (!text) return null;
	let t = String(text).trim();
	// Strip a leading/trailing markdown code fence if present.
	t = t
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	try {
		return JSON.parse(t);
	} catch {
		/* fall through to brace-slicing */
	}
	const start = t.indexOf('{');
	const end = t.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(t.slice(start, end + 1));
	} catch {
		return null;
	}
}

// Validate + normalise raw model text into a safe, sorted judgement.
// Throws if the output can't be salvaged into at least one valid ranking.
// `validIds` is a Set (or array) of submission ids that actually exist — any
// id the model invents is dropped, so the result can be trusted downstream.
export function normalizeJudgement(rawText, validIds) {
	const parsed = extractJson(rawText);
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('judge returned unparseable output');
	}
	const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
	const seen = new Set();

	const rankings = (Array.isArray(parsed.rankings) ? parsed.rankings : [])
		.map((r) => ({
			submission_id: String(r?.submission_id ?? r?.id ?? ''),
			score: clampScore(r?.score),
			verdict: typeof r?.verdict === 'string' ? r.verdict.trim().slice(0, VERDICT_CAP) : '',
		}))
		.filter((r) => {
			if (!valid.has(r.submission_id) || seen.has(r.submission_id)) return false;
			seen.add(r.submission_id);
			return true;
		})
		.sort((a, b) => b.score - a.score);

	if (!rankings.length) throw new Error('judge produced no valid rankings');

	let recommendedId = typeof parsed.recommended_id === 'string' ? parsed.recommended_id : '';
	if (!valid.has(recommendedId)) recommendedId = rankings[0].submission_id;

	const summary =
		typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, SUMMARY_CAP) : '';

	return { summary, recommended_id: recommendedId, rankings };
}
