/**
 * Remix feed — the composable, remixable-asset gallery (FREE surface).
 *
 *   GET  /api/remix-feed                      → { enabled, items: [...], next? }
 *   GET  /api/remix-feed?before=<iso>         → next page (cursor by created_at)
 *   GET  /api/remix-feed?action=lineage&root=<id>
 *                                             → { enabled, lineage: [...] }
 *   POST /api/remix-feed  { action:'publish', creation_id, royalty_bps?,
 *                           creator_wallet?, license?, remixable? }
 *                                             → { published: {...} }
 *
 * Browsing is free and identifier-light: each item carries the provenance and
 * royalty TERMS a remixer needs to decide (prompt, whether it is itself a remix,
 * royalty rate, and whether royalties can actually route) — but never the raw
 * creator payout wallet. Remixing (and paying the royalty) happens on the paid
 * x402 endpoint /api/x402/remix-asset; this feed is the read + publish half.
 *
 * Publishing opts one of YOUR OWN finished creations into the remix bazaar and
 * sets its license + royalty rate + Solana payout wallet — scoped to the
 * x-forge-client that created it, so nobody can publish another's model. All of
 * this lives on the existing forge_creations rows; no parallel asset store.
 *
 * No coin is named anywhere here — USDC is the settlement asset on the paid
 * endpoint only; this feed never mentions a token.
 */

import { cors, json, method, wrap, rateLimited, readJson } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	hashClient,
	forgeStoreEnabled,
	listRemixable,
	listMostRemixed,
	setRemixable,
	getLineage,
	validModelCategory,
} from './_lib/forge-store.js';
import { clampRoyaltyBps } from './_lib/remix-royalty.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LICENSES = new Set(['remix-cc', 'remix-nc', 'remix-royalty', 'all-rights']);

function clientKeyFrom(req) {
	const raw = req.headers['x-forge-client'];
	return hashClient(Array.isArray(raw) ? raw[0] : raw);
}

// Shape a public feed item: provenance + royalty TERMS, no payout wallet, no
// internal identifiers beyond the creation id needed to remix it.
function publicItem(it) {
	return {
		id: it.id,
		prompt: it.prompt,
		glbUrl: it.glb_url,
		previewImageUrl: it.preview_image_url ?? null,
		viewerUrl: `https://three.ws/viewer?src=${encodeURIComponent(it.glb_url)}`,
		royaltyBps: it.royaltyBps ?? 0,
		royaltyPercent: Math.round(((it.royaltyBps ?? 0) / 100) * 10) / 10,
		royaltyPayable: Boolean(it.royaltyPayable),
		isDerived: Boolean(it.isDerived),
		lineageIndex: it.lineageIndex ?? 0,
		remixCount: it.remixCount ?? 0,
		category: it.model_category ?? 'other',
		createdAt: it.created_at,
	};
}

// Trending item: a most-remixed asset, which may since have been unpublished
// (remixable: false) — its remix history is a fact even if the terms changed.
function trendingItem(it) {
	return {
		id: it.id,
		prompt: it.prompt,
		glbUrl: it.glb_url,
		previewImageUrl: it.preview_image_url ?? null,
		viewerUrl: `https://three.ws/viewer?src=${encodeURIComponent(it.glb_url)}`,
		royaltyBps: it.royaltyBps ?? 0,
		royaltyPercent: Math.round(((it.royaltyBps ?? 0) / 100) * 10) / 10,
		royaltyPayable: Boolean(it.royaltyPayable),
		remixable: Boolean(it.remixable),
		remixCount: it.remixCount ?? 0,
		category: it.model_category ?? 'other',
		createdAt: it.created_at,
	};
}

const SORTS = new Set(['recent', 'royalty', 'remixed']);

async function handleGet(req, res) {
	const url = new URL(req.url, 'http://localhost');
	const action = (url.searchParams.get('action') || '').trim();

	if (action === 'lineage') {
		const root = (url.searchParams.get('root') || '').trim();
		if (!root) return json(res, 400, { error: 'root creation id required' });
		const rows = await getLineage({ rootCreationId: root, clientKey: null });
		const lineage = rows.map((r) => ({
			id: r.id,
			parentId: r.parent_creation_id,
			lineageIndex: r.lineage_index,
			instruction: r.refine_instruction,
			prompt: r.prompt,
			glbUrl: r.glb_url,
			viewerUrl: r.glb_url ? `https://three.ws/viewer?src=${encodeURIComponent(r.glb_url)}` : null,
			status: r.status,
			createdAt: r.created_at,
		}));
		return json(res, 200, { enabled: true, lineage }, { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' });
	}

	// The trending half of the creator marketplace leaderboard (prompt 09) —
	// the most-remixed published assets platform-wide, a real count of child
	// creations, not a synthetic popularity score.
	if (action === 'trending') {
		const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 24);
		const rows = await listMostRemixed({ limit });
		return json(
			res,
			200,
			{ enabled: true, items: rows.map(trendingItem) },
			{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
		);
	}

	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 48);
	const before = (url.searchParams.get('before') || '').trim() || undefined;
	const category = validModelCategory((url.searchParams.get('category') || '').trim()) || undefined;
	const q = (url.searchParams.get('q') || '').trim() || undefined;
	const sortRaw = (url.searchParams.get('sort') || '').trim();
	const sort = SORTS.has(sortRaw) ? sortRaw : 'recent';
	const rows = await listRemixable({ limit, before, category, q, sort });
	const items = rows.map(publicItem);
	// A non-recent sort returns a fixed top-N leaderboard slice (see
	// listRemixable) — no cursor, no infinite scroll, by design.
	const next = sort === 'recent' && items.length === limit ? items[items.length - 1].createdAt : null;
	return json(
		res,
		200,
		{ enabled: true, items, next, sort, category: category ?? null, q: q ?? null },
		{ 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' },
	);
}

async function handlePost(req, res) {
	const body = await readJson(req);
	const action = (body?.action || '').trim();
	if (action !== 'publish') return json(res, 400, { error: 'unknown action' });

	const creationId = String(body.creation_id || '').trim();
	if (!creationId) return json(res, 400, { error: 'creation_id required' });

	const clientKey = clientKeyFrom(req);

	// A payout wallet is required to actually earn royalties, but publishing
	// without one is allowed (license may be remix-cc/-nc where nothing routes).
	const creatorWallet = body.creator_wallet ? String(body.creator_wallet).trim() : null;
	if (creatorWallet && !BASE58_RE.test(creatorWallet)) {
		return json(res, 400, { error: 'creator_wallet must be a Base58 Solana address' });
	}
	const license = LICENSES.has(body.license) ? body.license : 'remix-royalty';
	// remix-royalty/-cc/-nc are remixable; all-rights is publish-as-display-only.
	const remixable = body.remixable === false ? false : license !== 'all-rights';
	const royaltyBps = clampRoyaltyBps(body.royalty_bps ?? 1000);

	const published = await setRemixable({ creationId, clientKey, remixable, royaltyBps, creatorWallet, license });
	if (!published) {
		return json(res, 404, {
			error: 'creation not found, not finished, or not owned by this client',
		});
	}
	return json(res, 200, {
		published: {
			id: published.id,
			remixable: published.remixable,
			license,
			royaltyBps: published.royaltyBps,
			royaltyPercent: Math.round((published.royaltyBps / 100) * 10) / 10,
			royaltyPayable: Boolean(published.creatorWallet),
		},
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!forgeStoreEnabled()) {
		return json(res, 200, { enabled: false, items: [] });
	}

	if (req.method === 'POST') return handlePost(req, res);
	return handleGet(req, res);
});
