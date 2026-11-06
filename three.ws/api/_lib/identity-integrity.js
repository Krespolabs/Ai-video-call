// Granite identity integrity — the trust gate that runs when an agent identity is
// born or renamed.
//
// three.ws agents are first-class identities: each holds a wallet, takes real
// actions, and earns on-chain reputation. That makes impersonation a real attack
// — a fresh agent cloning the name, bio, and persona of a credentialed one to
// inherit its trust. Two IBM Granite capabilities already in the platform combine
// into a defence:
//
//   1. Granite embeddings (the Agent Galaxy's vectors) measure *semantic* identity
//      distance. We embed the candidate identity and cosine-compare it against
//      every public agent's cached vector — catching look-alikes that a plain
//      string match on the name would miss ("Granite Oracle" vs "The Granite
//      Oracle 🔮").
//   2. Granite Guardian screens the identity *content* (name + bio + persona) for
//      harm / social bias / sexual content before it can go public.
//
// The verdict is advisory by default and best-effort. Granite embeddings lead;
// without watsonx the comparison runs on the platform's embedding chain, whose
// vectors the Granite-calibrated thresholds below do not fit, so those neighbours
// are reported but never produce a similarity verdict. Granite Guardian runs on
// watsonx or on the self-hosted lane. With neither an embedder nor Guardian the
// check reports `configured: false` and never blocks, so identity creation
// degrades cleanly rather than failing closed.

import { sql } from './db.js';
import { watsonxConfig } from './watsonx.js';
import { readAgentVectors, agentEmbedText, agentEmbedders } from './agent-embeddings.js';
import { cosineSimilarity } from './embedding-math.js';
import { guardianConfig, assess, decide, RISKS } from './granite-guardian.js';

// Cosine thresholds on Granite embeddings. Calibrated to the 278m-multilingual
// model: near-duplicate identities land above ~0.93, clearly-related-but-distinct
// ones in the 0.86–0.93 band, and unrelated agents well below.
export const IMPERSONATION_THRESHOLD = 0.93; // block: this is effectively the same identity
export const SIMILAR_THRESHOLD = 0.86; // review: close enough to confuse a user

// Below this many characters of embeddable text there isn't enough signal to
// trust a similarity verdict (a bare "Agent" name embeds near everything), so we
// never *block* on it — only surface neighbours.
const MIN_TEXT_FOR_BLOCK = 16;

// Identity-content risks worth screening before an agent represents the platform.
// Kept lean (each is one Granite Guardian classifier call, run concurrently) so
// the gate stays responsive on the create path.
export const IDENTITY_RISKS = ['harm', 'social_bias', 'sexual_content'];

// How many candidate agents to compare against. The cap mirrors the galaxy's so
// the cached-vector read stays a single round-trip.
const MAX_COMPARE = 500;

function round(n) {
	return Math.round(Number(n) * 1e4) / 1e4;
}

// Pull the comparison set: every public agent (the impersonation surface) plus
// the requester's own agents (so we can warn about duplicating yourself), each
// with the fields needed to embed and to attribute ownership.
async function selectComparableAgents({ userId, excludeAgentId }) {
	// Neon's HTTP driver has no nested-fragment composition, so build the
	// conditional own-agents clause as a parameterised raw query (the same
	// pattern api/agents.js uses for its optional filters).
	const exclude = excludeAgentId || '00000000-0000-0000-0000-000000000000';
	const params = [exclude];
	let ownClause = '';
	if (userId) {
		params.push(userId);
		ownClause = `OR i.user_id = $${params.length}`;
	}
	const text = `
		SELECT i.id, i.name, i.description, i.persona_tone_tags, i.user_id, i.is_public
		FROM agent_identities i
		WHERE i.deleted_at IS NULL
		  AND (i.is_public = true ${ownClause})
		  AND i.id <> $1::uuid
		  AND i.description IS NOT NULL
		  AND length(trim(i.description)) > 0
		ORDER BY i.created_at DESC
		LIMIT ${MAX_COMPARE}
	`;
	return sql(text, params);
}

/**
 * Assess the integrity of a candidate agent identity.
 *
 * @param {{name?:string, description?:string, persona_tone_tags?:string[]}} candidate
 * @param {{userId?:string, excludeAgentId?:string, risks?:string[], withGuardian?:boolean, signal?:AbortSignal}} [opts]
 * @returns {Promise<{
 *   configured:boolean, status:'clear'|'review'|'block'|'unavailable',
 *   uniqueness:number|null, reasons:string[],
 *   similar:Array<{id:string,name:string,score:number,owned:boolean,public:boolean}>,
 *   duplicateOf:{id:string,name:string,score:number}|null,
 *   guardian:{decision:string,flagged:string[],reasons:Array<{risk:string,label:string,probability:number}>}|null,
 *   model:{embed:string|null,guardian:string|null}
 * }>}
 */
export async function checkIdentityIntegrity(candidate, opts = {}) {
	const { userId = null, excludeAgentId = null, risks = IDENTITY_RISKS, withGuardian = true, signal } = opts;

	const text = agentEmbedText(candidate || {});
	const base = {
		configured: false,
		status: 'unavailable',
		uniqueness: null,
		reasons: [],
		similar: [],
		duplicateOf: null,
		guardian: null,
		model: { embed: null, guardian: null },
	};

	const embedders = agentEmbedders(watsonxConfig());
	const guardianReady = withGuardian && guardianConfig().configured;
	if (!embedders.length && !guardianReady) {
		base.reasons.push('No embedding lane or Granite Guardian lane is configured; identity integrity check skipped.');
		return base;
	}
	if (!text) {
		// Nothing meaningful to embed (no name + description yet).
		return { ...base, configured: true, status: 'clear', uniqueness: 1, reasons: ['No identity text to evaluate.'] };
	}

	// Run the semantic comparison and the content screen concurrently: they are
	// independent calls.
	const [similarity, guardian] = await Promise.all([
		embedders.length
			? compareSemantically({ embedders, text, userId, excludeAgentId })
			: Promise.resolve({ model: null, calibrated: false, similar: [] }),
		guardianReady ? screenContent({ text, risks, signal }) : Promise.resolve(null),
	]);

	const reasons = [];
	let status = 'clear';

	// ── Similarity verdict ───────────────────────────────────────────────────
	const top = similarity.similar[0] || null;
	const impersonation = similarity.similar.find(
		(s) => s.public && !s.owned && s.score >= IMPERSONATION_THRESHOLD,
	) || null;
	const enoughSignal = text.length >= MIN_TEXT_FOR_BLOCK;

	// Neighbours from a non-Granite embedder are still listed, but the thresholds
	// were calibrated on Granite vectors, so only Granite similarity sets a verdict.
	let duplicateOf = null;
	if (!similarity.calibrated) {
		// Reported via `similarityScored: false` below.
	} else if (impersonation && enoughSignal) {
		status = 'block';
		duplicateOf = { id: impersonation.id, name: impersonation.name, score: impersonation.score };
		reasons.push(
			`This identity is ${(impersonation.score * 100).toFixed(0)}% similar to an existing public agent ("${impersonation.name}") owned by someone else — likely impersonation.`,
		);
	} else if (top && top.score >= SIMILAR_THRESHOLD) {
		status = status === 'block' ? 'block' : 'review';
		const who = top.owned ? 'one of your own agents' : `another agent ("${top.name}")`;
		reasons.push(`Closely resembles ${who} (${(top.score * 100).toFixed(0)}% similar).`);
	}

	// ── Guardian verdict ───────────────────────────────────────────────────────
	if (guardian) {
		if (guardian.decision === 'block') {
			status = 'block';
			for (const r of guardian.reasons) {
				reasons.push(`Granite Guardian flagged the identity for ${r.label.toLowerCase()}.`);
			}
		} else if (guardian.decision === 'review' && status === 'clear') {
			status = 'review';
			reasons.push('Granite Guardian flagged the identity for review.');
		}
	}

	const uniqueness = top ? round(Math.max(0, 1 - top.score)) : 1;
	if (status === 'clear' && !reasons.length) {
		reasons.push(
			similarity.calibrated
				? 'Identity is distinct from existing agents and passed content screening.'
				: 'Identity passed content screening. Similar agents are listed for reference; similarity is only scored on Granite embeddings.',
		);
	}

	return {
		configured: true,
		status,
		uniqueness: similarity.calibrated ? uniqueness : null,
		similarityScored: similarity.calibrated,
		reasons,
		similar: similarity.similar,
		duplicateOf,
		guardian: guardian
			? { decision: guardian.decision, flagged: guardian.flagged, reasons: guardian.reasons }
			: null,
		model: { embed: similarity.model, guardian: guardian?.model || null },
	};
}

// Embed the candidate and rank it against the cached public/own agent vectors
// written by the same embedder. Walks the embedder chain (watsonx Granite first)
// until one answers; `calibrated` is true only when Granite served.
async function compareSemantically({ embedders, text, userId, excludeAgentId }) {
	const rows = await selectComparableAgents({ userId, excludeAgentId });
	const usable = rows.filter((a) => agentEmbedText(a));
	const ids = usable.map((a) => a.id);
	let lastErr = null;
	for (const embedder of embedders) {
		try {
			const [vectorMap, qvec] = await Promise.all([
				ids.length ? readAgentVectors(ids, { model: embedder.model }) : Promise.resolve(new Map()),
				embedder.embedQuery(text),
			]);
			if (!qvec?.length) throw new Error(`${embedder.model} returned no candidate embedding`);
			return {
				model: embedder.model,
				calibrated: embedder.provider === 'watsonx',
				similar: rankNeighbours({ qvec, vectorMap, usable, userId }),
			};
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

function rankNeighbours({ qvec, vectorMap, usable, userId }) {
	const byId = new Map(usable.map((a) => [a.id, a]));
	const ranked = [];
	for (const [id, vec] of vectorMap) {
		if (!vec?.length) continue;
		const a = byId.get(id);
		ranked.push({
			id,
			name: a?.name || '',
			score: round(cosineSimilarity(qvec, vec)),
			owned: !!userId && a?.user_id === userId,
			public: !!a?.is_public,
		});
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, 8);
}

// Screen identity text through Granite Guardian. Returns a decide() verdict, or
// null when Guardian isn't configured (best-effort, never fabricated).
async function screenContent({ text, risks, signal }) {
	const gcfg = guardianConfig();
	if (!gcfg.configured) return null;
	const wanted = risks.filter((r) => RISKS[r]);
	const verdicts = await assess(gcfg, { input: text, risks: wanted.length ? wanted : IDENTITY_RISKS, signal });
	const d = decide(verdicts);
	return {
		decision: d.decision,
		flagged: d.flagged,
		reasons: (d.reasons || []).map((r) => ({ risk: r.risk, label: r.label, probability: round(r.probability) })),
		model: verdicts[0]?.model || gcfg.model,
	};
}
