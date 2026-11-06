// api/_lib/x402/enrich-model-metadata.js
//
// Model Metadata Enrichment — the work behind the `enrich-model-metadata`
// autonomous-registry entry (use case 016).
//
// The autonomous loop pays the x402 `inspect_model` MCP tool ($0.01 USDC/call)
// to parse a public avatar's GLB, then this module turns the structural report
// into searchable feature tags + a model category and writes them back to the
// `avatars` table.
//
//   • selectUntaggedAvatar()  — pick one public, tag-less avatar to enrich
//   • inspectModelRpcBody()   — build the JSON-RPC tools/call body for the loop
//   • deriveModelMetadata()   — pure: inspection report → { tags, model_category }
//   • applyModelMetadata()    — persist tags + category to avatars (untagged-only)
//
// Downstream consumers of the data written here:
//   - Avatar search / marketplace filtering: `listPublicAvatars({ tag, category })`
//     in api/_lib/avatars.js queries `any(tags)` and `model_category` — the only
//     way these rows surface in tag/category facets is once they are enriched.
//   - The recommendation engine reads the same `avatars.tags` array.

import { sql } from '../db.js';
import { publicUrl } from '../r2.js';

// Cap stored tags to the same ceiling the manual save path enforces (from-forge
// slices to 20) so an enriched avatar never has a larger tag set than a
// user-curated one.
const MAX_TAGS = 20;

// Select up to `limit` public avatars that have no tags yet and whose GLB is
// reachable at a public https URL (inspect_model fetches the URL server-side;
// private/local blobs can't be inspected). Highest-traffic avatars first so the
// most-seen models become searchable soonest. Returns [] when nothing is
// pending — the pipeline then skips without paying.
export async function selectUntaggedAvatars(limit = 10) {
	const want = Math.max(1, Math.min(50, Number(limit) || 10));
	let rows;
	try {
		rows = await sql`
			select id, slug, storage_key
			from avatars
			where deleted_at is null
			  and visibility = 'public'
			  and storage_key is not null
			  and (tags is null or cardinality(tags) = 0)
			order by view_count desc nulls last, created_at desc
			limit ${want * 2}
		`;
	} catch {
		// Table/columns missing in a fresh env — nothing to enrich, not an error.
		return [];
	}

	const out = [];
	for (const row of rows) {
		if (out.length >= want) break;
		const url = publicUrl(row.storage_key);
		if (typeof url === 'string' && /^https:\/\//i.test(url)) {
			out.push({ id: row.id, slug: row.slug, glb_url: url });
		}
	}
	return out;
}

// JSON-RPC 2.0 envelope for a single `inspect_model` tool call against /api/mcp.
export function inspectModelRpcBody(glbUrl) {
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'inspect_model', arguments: { url: glbUrl } },
	};
}

// Pull the inspection report out of the MCP tools/call response. Returns null on
// a JSON-RPC error, a tool-level error, or a malformed envelope.
export function parseInspectResult(responseBody) {
	const result = responseBody?.result;
	if (!result || result.isError) return null;
	const info = result.structuredContent;
	if (!info || typeof info !== 'object' || !info.counts) return null;
	return info;
}

// Pure: turn an inspect_model structural report into feature tags + a category.
// Every branch is grounded in a concrete geometry fact — no guessing.
export function deriveModelMetadata(info) {
	const c = info?.counts || {};
	const ext = Array.isArray(info?.extensionsUsed) ? info.extensionsUsed : [];
	const tags = new Set();

	// Container format.
	if (info?.container === 'glb' || info?.container === 'gltf') tags.add(info.container);

	// Rig + animation — the signals that decide whether a mesh can drive the
	// canonical clip library, so they double as the category heuristic below.
	const rigged = (c.skins || 0) > 0;
	const animated = (c.animations || 0) > 0;
	tags.add(rigged ? 'rigged' : 'static');
	if (animated) tags.add('animated');

	// Mesh composition.
	if ((c.meshes || 0) > 1) tags.add('multi-mesh');
	else if ((c.meshes || 0) === 1) tags.add('single-mesh');

	// Materials / textures.
	if ((c.textures || 0) > 0) tags.add('textured');
	else tags.add('untextured');
	if ((c.materials || 0) > 1) tags.add('multi-material');

	// Triangle budget — the practical web-delivery tier.
	const tris = c.totalTriangles || 0;
	if (tris > 0) {
		if (tris < 10_000) tags.add('low-poly');
		else if (tris < 100_000) tags.add('mid-poly');
		else tags.add('high-poly');
	}

	// Compression / advanced material extensions present in the asset.
	if (ext.includes('KHR_draco_mesh_compression')) tags.add('draco');
	if (ext.includes('EXT_meshopt_compression')) tags.add('meshopt');
	if (ext.includes('KHR_texture_basisu')) tags.add('ktx2');
	if (
		ext.includes('KHR_materials_pbrSpecularGlossiness') ||
		ext.includes('KHR_materials_emissive_strength') ||
		ext.includes('KHR_materials_clearcoat') ||
		ext.includes('KHR_materials_transmission')
	) {
		tags.add('pbr');
	}

	// A skinned or animated mesh is treated as an avatar; an inert static mesh is
	// a prop. Mirrors how the rest of the platform splits humanoid avatars from
	// scene objects.
	const model_category = rigged || animated ? 'avatar' : 'prop';

	return { tags: [...tags].slice(0, MAX_TAGS), model_category };
}

// Persist derived tags + category, but only while the row is still untagged —
// never clobber tags a human or a concurrent process added between selection
// and write. Returns true when a row was updated.
export async function applyModelMetadata({ avatarId, tags, model_category }) {
	if (!avatarId || !Array.isArray(tags) || tags.length === 0) return false;
	const rows = await sql`
		update avatars
		   set tags           = ${tags}::text[],
		       model_category = coalesce(${model_category ?? null}, model_category),
		       updated_at     = now()
		 where id = ${avatarId}
		   and deleted_at is null
		   and (tags is null or cardinality(tags) = 0)
		returning id
	`;
	return rows.length > 0;
}

// End-to-end persistence used by the registry entry's `persist` hook: parse the
// MCP response, derive metadata, write it, and return a compact summary for the
// x402_autonomous_log.value_extracted column. Returns null when there is nothing
// useful to store (so the loop records the call without a value payload).
export async function enrichFromInspection({ responseBody, avatarId, slug }) {
	const info = parseInspectResult(responseBody);
	if (!info) return null;
	const { tags, model_category } = deriveModelMetadata(info);
	if (!tags.length) return null;
	const applied = await applyModelMetadata({ avatarId, tags, model_category });
	return {
		avatar_id: avatarId,
		slug: slug || null,
		applied,
		tags,
		model_category,
		triangles: info.counts?.totalTriangles ?? null,
	};
}
