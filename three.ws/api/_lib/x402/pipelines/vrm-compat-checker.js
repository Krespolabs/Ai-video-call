// api/_lib/x402/pipelines/vrm-compat-checker.js
//
// VRM 1.0 Compatibility Checker (USE-019) — an autonomous x402 spend-loop entry.
//
// Validates that VRM 0.x avatars can be upgraded to the VRM 1.0 spec. For each
// selected avatar it pays a real x402 call to /api/mcp (inspect_model), parses
// the structural report, flags the well-known VRM 0.x → 1.0 breaking changes
// (forward-axis flip, BlendShapeMaster → VRMC_vrm expressions, secondaryAnimation
// → VRMC_springBone, MToon → VRMC_materials_mtoon), and upserts a per-avatar
// migration report into `avatar_vrm_compat` (keyed by avatar_id).
//
// Wiring: this module exports a single registry entry object consumed by
// api/_lib/x402/autonomous-registry.js. The spend loop
// (api/cron/x402-autonomous-loop.js) drives it via the generic entry hooks:
//   • resolveTarget(ctx) → picks the avatar + builds its public GLB URL
//   • body(ctx)          → embeds that URL into an MCP inspect_model tools/call
//   • extractSignal(r)   → verdict summary → x402_autonomous_log.signal_data
//   • storeValue(ctx)    → full migration report → avatar_vrm_compat
//
// Real on-chain payment only (inspect_model is $0.01 USDC over /api/mcp). If the
// seed wallet is unconfigured the loop exits before this entry runs; if there is
// no VRM avatar pending and no canary configured, resolveTarget yields no target
// and the loop skips the tick without paying.
//
// Downstream consumers of avatar_vrm_compat:
//   • Avatar detail / marketplace gallery → "VRM 1.0 ready" badge + upgrade CTA.
//   • Avatar Pricing Engine pipeline (USE-020) → spec compliance as a pricing input.

import { publicUrl } from '../../r2.js';

// Optional public VRM canary that keeps the paid path warm when no user VRM
// avatar is pending a check. Unset → the pipeline skips that tick rather than
// paying for a non-existent target. Mirrors X402_MCP_PERF_CANARY_MODEL.
const VRM_CANARY_MODEL = (process.env.X402_VRM_CANARY_MODEL || '').trim();

// Per-call price of inspect_model over /api/mcp, in USDC atomics (6 decimals).
// Informational — the loop pays whatever the live 402 challenge quotes.
export const VRM_INSPECT_PRICE_ATOMIC = 10_000; // $0.01

// Derive the VRM-compatibility verdict from an inspect_model structural report
// (the tool's structuredContent). Shared by extractSignal (→ signal_data) and
// storeValue (→ avatar_vrm_compat) so both always agree on the classification.
export function classifyVrmCompat(info, sourceUrl) {
	const c = (info && info.counts) || {};
	const ext = [
		...(Array.isArray(info?.extensionsUsed) ? info.extensionsUsed : []),
		...(Array.isArray(info?.extensionsRequired) ? info.extensionsRequired : []),
	].map(String);
	const has = (n) => ext.includes(n);
	// VRM 0.x ships the single `VRM` extension; VRM 1.0 splits into the VRMC_*
	// family (VRMC_vrm, VRMC_springBone, VRMC_materials_mtoon, …).
	const isVrm1 = ext.some((x) => /^VRMC_/.test(x));
	const isVrm0 = has('VRM') && !isVrm1;
	const isVrm = isVrm0 || isVrm1;
	const vrmVersion = isVrm1 ? '1.0' : isVrm0 ? '0.x' : 'none';

	const matCount = Array.isArray(info?.materials)
		? info.materials.length
		: Number(c.materials || 0);
	const issues = [];
	if (isVrm0) {
		// Migration checklist — the classic VRM 0.x → 1.0 breaking changes. These
		// are advisory (the UniVRM converter automates them); they tell the upgrade
		// tool what to verify, not whether the upgrade is possible.
		issues.push({
			code: 'coordinate_space',
			severity: 'warn',
			message: 'VRM 1.0 reverses the forward axis (0.x +Z → 1.0 −Z). Root transform and normals must be flipped during upgrade.',
		});
		issues.push({
			code: 'expression_remap',
			severity: 'warn',
			message: 'VRM 0.x BlendShapeMaster groups must be remapped to VRMC_vrm expressions (presets + custom) in 1.0.',
		});
		if (Number(c.skins || 0) > 0) {
			issues.push({
				code: 'springbone_remap',
				severity: 'warn',
				message: 'VRM 0.x secondaryAnimation spring bones must be re-expressed as VRMC_springBone joints + colliders.',
			});
		}
		if (matCount > 0 && !has('VRMC_materials_mtoon')) {
			issues.push({
				code: 'mtoon_migration',
				severity: 'info',
				message: `${matCount} material(s) — MToon parameters migrate to VRMC_materials_mtoon; verify outline and shading after upgrade.`,
			});
		}
	}

	// A VRM 0.x avatar can always be mechanically upgraded to 1.0. Already-1.0 and
	// non-VRM models are not upgrade candidates → null (N/A).
	const upgradeable = isVrm0 ? true : null;
	const blockerCount = issues.filter(
		(i) => i.severity === 'warn' || i.severity === 'critical',
	).length;

	return {
		source_url: sourceUrl || info?.url || null,
		is_vrm: isVrm,
		vrm_version: vrmVersion,
		upgradeable,
		blocker_count: blockerCount,
		issues,
		extensions: ext,
		counts: {
			nodes: Number(c.nodes || 0),
			meshes: Number(c.meshes || 0),
			materials: Number(c.materials || 0),
			skins: Number(c.skins || 0),
			animations: Number(c.animations || 0),
			vertices: Number(c.totalVertices || 0),
			triangles: Number(c.totalTriangles || 0),
		},
		filename: info?.filename || null,
		container: info?.container || null,
		generator: info?.generator || null,
	};
}

// Pull the inspect_model structural report out of an MCP tools/call response.
function structuredContent(responseBody) {
	return responseBody?.result?.structuredContent || null;
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
// The canonical schema also ships as a migration
// (api/_lib/migrations/20260629100000_avatar_vrm_compat.sql); this keeps the
// pipeline self-healing on a cold DB where the migration hasn't been applied.
let _vrmSchemaReady = false;
async function ensureVrmSchema(sql) {
	if (_vrmSchemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS avatar_vrm_compat (
			avatar_id      uuid PRIMARY KEY REFERENCES avatars(id) ON DELETE CASCADE,
			source_url     text NOT NULL,
			is_vrm         boolean NOT NULL DEFAULT false,
			vrm_version    text NOT NULL DEFAULT 'none',
			upgradeable    boolean,
			blocker_count  int NOT NULL DEFAULT 0,
			issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
			report         jsonb NOT NULL DEFAULT '{}'::jsonb,
			extensions     text[] NOT NULL DEFAULT '{}',
			run_id         uuid,
			tx_signature   text,
			checked_at     timestamptz NOT NULL DEFAULT now()
		)
	`;
	_vrmSchemaReady = true;
}

// Select the next avatar to validate: a VRM-candidate (tagged 'vrm', named like
// a VRM, a .vrm storage key, or an imported/avaturn source) not checked in the
// last 30 days, least-recently-checked first. Falls back to the optional public
// canary so the paid path stays exercised even with no pending user avatar.
async function nextVrmTarget(ctx) {
	if (ctx?.sql) {
		try {
			await ensureVrmSchema(ctx.sql);
			const rows = await ctx.sql`
				SELECT a.id, a.name, a.storage_key
				FROM avatars a
				LEFT JOIN avatar_vrm_compat v ON v.avatar_id = a.id
				WHERE a.deleted_at IS NULL
				  AND a.storage_key IS NOT NULL
				  AND a.storage_key <> ''
				  AND (v.avatar_id IS NULL OR v.checked_at < now() - interval '30 days')
				  AND (
				        'vrm' = ANY(a.tags)
				        OR a.name ILIKE '%vrm%'
				        OR a.storage_key ILIKE '%.vrm%'
				        OR a.source IN ('avaturn', 'import')
				  )
				ORDER BY v.checked_at ASC NULLS FIRST, a.created_at DESC
				LIMIT 1`;
			if (rows && rows.length) {
				const a = rows[0];
				const url = publicUrl(a.storage_key);
				if (/^https:\/\//i.test(url)) {
					return { targetUrl: url, context: { avatar_id: a.id, name: a.name, canary: false } };
				}
			}
		} catch {
			// DB unavailable or table not yet migrated — fall through to the canary.
		}
	}
	if (VRM_CANARY_MODEL) {
		return { targetUrl: VRM_CANARY_MODEL, context: { avatar_id: null, name: 'vrm-canary', canary: true } };
	}
	return null;
}

// Persist the per-avatar migration report. Skips canary / unidentified targets
// (no avatars row to key on) — their verdict is still captured in
// x402_autonomous_log.signal_data via extractSignal.
async function storeVrmReport({ sql, responseBody, runId, targetUrl, targetContext, txSig }) {
	if (!sql) return;
	const avatarId = targetContext?.avatar_id;
	if (!avatarId) return;
	const info = structuredContent(responseBody);
	if (!info) return;
	const v = classifyVrmCompat(info, targetUrl);
	await ensureVrmSchema(sql);
	await sql`
		INSERT INTO avatar_vrm_compat
			(avatar_id, source_url, is_vrm, vrm_version, upgradeable,
			 blocker_count, issues, report, extensions, run_id, tx_signature, checked_at)
		VALUES
			(${avatarId}, ${v.source_url || targetUrl}, ${v.is_vrm}, ${v.vrm_version},
			 ${v.upgradeable}, ${v.blocker_count},
			 ${JSON.stringify(v.issues)}, ${JSON.stringify(v)},
			 ${v.extensions}, ${runId}, ${txSig || null}, now())
		ON CONFLICT (avatar_id) DO UPDATE SET
			source_url    = EXCLUDED.source_url,
			is_vrm        = EXCLUDED.is_vrm,
			vrm_version   = EXCLUDED.vrm_version,
			upgradeable   = EXCLUDED.upgradeable,
			blocker_count = EXCLUDED.blocker_count,
			issues        = EXCLUDED.issues,
			report        = EXCLUDED.report,
			extensions    = EXCLUDED.extensions,
			run_id        = EXCLUDED.run_id,
			tx_signature  = EXCLUDED.tx_signature,
			checked_at    = now()
	`;
}

// The registry entry. Imported and spread into SELF_ENDPOINTS by
// autonomous-registry.js. Cooldown 1800s → ≤48 checks/day ≈ $0.48/day at $0.01
// each, well under the loop's daily cap (shared across all pipelines).
export const vrmCompatEntry = {
	id: 'vrm-compat-checker',
	name: 'VRM 1.0 Compatibility Checker',
	path: '/api/mcp',
	method: 'POST',
	// Dynamic body: resolveTarget picks the avatar + URL, this embeds it into the
	// MCP inspect_model tools/call. Returns null when there is no target → the loop
	// skips the tick without probing or paying.
	body: ({ targetUrl }) => {
		if (!targetUrl) return null;
		return {
			jsonrpc: '2.0',
			id: 'vrm-compat',
			method: 'tools/call',
			params: { name: 'inspect_model', arguments: { url: targetUrl } },
		};
	},
	cooldown_s: 1800,
	priority: 42,
	pipeline: 'vrm-compat',
	enabled: true,
	resolveTarget: (ctx) => nextVrmTarget(ctx),
	extractSignal: (r) => {
		const info = structuredContent(r);
		if (!info) return { ok: false, reason: 'no_structured_content' };
		const v = classifyVrmCompat(info, null);
		return {
			is_vrm: v.is_vrm,
			vrm_version: v.vrm_version,
			upgradeable: v.upgradeable,
			blocker_count: v.blocker_count,
			filename: v.filename,
		};
	},
	storeValue: (ctx) => storeVrmReport(ctx),
};
