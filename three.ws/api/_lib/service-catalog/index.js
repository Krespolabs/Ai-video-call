// Unified service catalog — ONE source of truth, two storefronts.
//
// x402scan/agentic.market (Base) and OKX.AI (X Layer) are storefronts over the
// same backend. Before this module, listing metadata was scattered: each paid
// endpoint's BAZAAR export, ~1,400 lines of hand-mirrored resource blocks in
// api/wk.js, and a separate OKX catalog — drift was inevitable (and real:
// descriptions for the same route differed between surfaces). Now every
// storefront renders from here, so a description is written once.
//
// Sources (imported, never duplicated):
//   • services/*.js            — one descriptor per paid x402 service (static
//                                barrel, discovery-doc order)
//   • ../crypto-catalog        — the free Crypto Data API bundle
//   • ../3d-catalog            — the free 3D API bundle
//   • ../okx-catalog.js        — the OKX.AI 3D Studio listing rows (owned by
//                                the OKX stream; read-only here)
//
// Consumers:
//   • api/wk.js — derives every static /api/x402/* resource entry in
//     /.well-known/x402.json from toBazaarDiscovery()
//   • the OKX stream — toOkxCatalog() emits the exact catalogIndex() shape
//     api/_lib/okx-catalog.js serves today, so it can point at this module
//   • tests/service-catalog.test.js — no-drift + projection-shape guards
//
// Contract: specs/service-catalog.md.

import { PAID_SERVICES } from './services/index.js';
import { loadCatalog as loadCryptoCatalog } from '../crypto-catalog/index.js';
import { loadCatalog as load3dCatalog } from '../3d-catalog/index.js';
import {
	OKX_CATALOG,
	catalogIndex as okxCatalogIndex,
	displayWidth,
	DESCRIPTION_MAX_WIDTH,
} from '../okx-catalog.js';
import { withService } from '../x402/bazaar-helpers.js';

const BASE = 'https://three.ws';

// Networks each accepts-builder advertises (mirrors api/wk.js acceptsForPrice /
// buildBazaarAccepts / the permit2-only block). Informational on the canonical
// entry; the live accepts[] are always built by wk.js from env at render time.
const NETWORKS_BY_BUILDER = Object.freeze({
	standard: Object.freeze(['solana', 'base']),
	'cdp-bazaar': Object.freeze(['solana', 'base', 'arbitrum']),
	'permit2-only': Object.freeze(['base']),
});

export function priceUsdFromAtomics(atomics) {
	const n = Number(atomics || 0) / 1_000_000;
	const s = n.toFixed(n < 0.01 ? 4 : 2);
	return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function firstSentence(text) {
	const m = String(text || '').match(/^.*?[.!?](?=\s|$)/s);
	return (m ? m[0] : String(text || '')).trim();
}

function normalizePaid(s) {
	return {
		slug: s.slug,
		title: s.title,
		category: s.category,
		useCase: s.useCase,
		free: false,
		status: s.status,
		method: s.method,
		path: s.path,
		endpoint: `${BASE}${s.path}`,
		price: {
			usd: priceUsdFromAtomics(s.priceAtomics),
			atomics: s.priceAtomics,
			networks: [...(NETWORKS_BY_BUILDER[s.acceptsBuilder] || NETWORKS_BY_BUILDER.standard)],
		},
		serviceName: s.serviceName,
		tags: [...s.tags],
		description: s.description,
		...(s.input !== undefined ? { input: s.input } : {}),
		...(s.inputSchema !== undefined ? { inputSchema: s.inputSchema } : {}),
		storefronts: [...s.storefronts],
		source: 'x402',
	};
}

function normalizeCrypto(e) {
	return {
		slug: `crypto-${e.slug}`,
		title: e.title,
		category: 'crypto-data',
		useCase: firstSentence(e.summary),
		free: true,
		status: 'live',
		method: e.method,
		path: e.path,
		endpoint: `${BASE}${e.path}`,
		price: null,
		tags: ['crypto', 'free', 'keyless'],
		description: e.summary,
		...(e.inputSchema ? { inputSchema: e.inputSchema } : {}),
		...(e.outputSchema ? { outputSchema: e.outputSchema } : {}),
		...(e.example != null ? { example: e.example } : {}),
		storefronts: ['crypto-index'],
		source: 'crypto-catalog',
	};
}

function normalize3d(e) {
	return {
		slug: `3d-${e.slug}`,
		title: e.title,
		category: e.category || '3d',
		useCase: e.useCase || firstSentence(e.summary),
		free: Boolean(e.free),
		status: 'live',
		method: Array.isArray(e.methods) && e.methods.length ? e.methods[0] : 'GET',
		path: e.path,
		endpoint: `${BASE}${e.path}`,
		price: null,
		tags: Array.isArray(e.tags) && e.tags.length ? [...e.tags] : ['3d', 'free', 'keyless'],
		description: e.summary || e.description || '',
		...(e.input !== undefined ? { input: e.input } : {}),
		...(e.inputSchema ? { inputSchema: e.inputSchema } : {}),
		...(e.outputSchema ? { outputSchema: e.outputSchema } : {}),
		...(e.example != null ? { example: e.example } : {}),
		storefronts: ['3d-index'],
		source: '3d-catalog',
	};
}

function normalizeOkx(e) {
	const free = e.priceUsd === '0';
	return {
		slug: `okx-${e.id}`,
		title: e.name,
		category: '3d',
		useCase: e.describes.capability,
		free,
		status: 'live',
		method: e.kind === 'a2mcp' || !free ? 'POST' : 'GET',
		path: new URL(e.endpoint).pathname,
		endpoint: e.endpoint,
		price: free ? null : { usd: e.priceUsd, atomics: e.amountAtomics, networks: ['xlayer'] },
		tags: ['okx', '3d', e.kind],
		description: `${e.describes.capability}\n${e.describes.input}`,
		...(e.inputSchema ? { inputSchema: e.inputSchema } : {}),
		storefronts: ['okx'],
		source: 'okx',
	};
}

// ── The canonical catalog ────────────────────────────────────────────────────

// Full merged catalog: paid x402 services (discovery order), free crypto + 3D
// bundles, and the OKX.AI listing rows. A failing free-catalog loader degrades
// to the entries that did load (matching each loader's own robustness
// contract) — the paid + OKX sections are static imports and always present.
export async function getCatalog() {
	const [crypto, threeD] = await Promise.all([
		loadCryptoCatalog().catch(() => []),
		load3dCatalog().catch(() => []),
	]);
	return [
		...PAID_SERVICES.map(normalizePaid),
		...crypto.map(normalizeCrypto),
		...threeD.map(normalize3d),
		...OKX_CATALOG.map(normalizeOkx),
	];
}

// Storefront views: 'x402scan' (paid x402 discovery), 'okx' (OKX.AI listing),
// 'crypto-index' (/api/crypto), '3d-index' (/api/3d).
export async function getByStorefront(storefront) {
	const all = await getCatalog();
	return all.filter((e) => e.storefronts.includes(storefront));
}

// ── x402scan projection ──────────────────────────────────────────────────────

// Emit the static /api/x402/* resource entries for /.well-known/x402.json in
// catalog order. wk.js injects its env-aware builders:
//   acceptsFor(service, url) — returns the accepts[] for the service's
//     acceptsBuilder ('standard' | 'cdp-bazaar' | 'permit2-only'), or null to
//     omit the resource entirely (permit2 without CDP creds).
//   extensionsForAccepts(accepts, bazaar) — wk.js's normalizer, so gasless
//     Permit2 extensions attach exactly as before.
export function toBazaarDiscovery({ origin, acceptsFor, extensionsForAccepts }) {
	const out = [];
	for (const s of PAID_SERVICES) {
		if (s.status !== 'live') continue;
		const url = `${origin}${s.path}`;
		const accepts = acceptsFor(s, url);
		if (!accepts) continue;
		const svc = withService({ serviceName: s.serviceName, tags: s.tags });
		out.push({
			path: s.path,
			url,
			method: s.method,
			description: s.description,
			mimeType: 'application/json',
			serviceName: svc.serviceName,
			tags: svc.tags,
			iconUrl: svc.iconUrl,
			accepts,
			// A descriptor may carry a fully-built {discoverable, info, schema}
			// bazaar block (forge does — its shared listing module builds one with
			// the output schema included); extensionsForAccepts passes such blocks
			// through verbatim. Otherwise the block is derived from input/inputSchema.
			extensions: extensionsForAccepts(
				accepts,
				s.bazaar || {
					method: s.method,
					discoverable: true,
					...(s.input !== undefined ? { input: s.input } : {}),
					...(s.inputSchema !== undefined ? { inputSchema: s.inputSchema } : {}),
					// Descriptors added before the catalog existed get their output
					// example backfilled by wk.js's REST_OUTPUT_EXAMPLES map; new
					// descriptors carry it here so the whole listing is one record.
					...(s.outputExample !== undefined ? { output: { example: s.outputExample } } : {}),
				},
			),
		});
	}
	return out;
}

// ── OKX projection ───────────────────────────────────────────────────────────

// Truncate to the OKX listing's 200-display-width budget (East-Asian wide
// glyphs count 2), appending '…' when cut so a clipped description reads as
// clipped instead of silently malformed.
function clampWidth(text, max = DESCRIPTION_MAX_WIDTH) {
	const s = String(text || '').trim();
	if (displayWidth(s) <= max) return s;
	let out = '';
	let width = 0;
	for (const ch of s) {
		const w = displayWidth(ch);
		if (width + w > max - 1) break;
		out += ch;
		width += w;
	}
	return `${out.trimEnd()}…`;
}

// Human-readable "what the caller provides" line for an x402 service, derived
// from its input schema — the second half of an OKX 2-part description.
function okxInputHint(s) {
	const required = Array.isArray(s.inputSchema?.required) ? s.inputSchema.required : [];
	const params = required.length
		? `with ${required.join(', ')}`
		: s.method === 'GET'
			? 'with the documented query params'
			: 'with the documented JSON body';
	return `${s.method} ${s.endpoint} ${params}. Pays ${priceUsdFromAtomics(
		s.price.atomics,
	)} USDC per call via x402 (HTTP 402).`;
}

// The OKX.AI storefront projection. Default ('okx') reproduces the EXACT
// payload api/_lib/okx-catalog.js's catalogIndex() serves today — the OKX
// stream can point its module here with zero behavior change (deep-equality
// is asserted in tests/service-catalog.test.js). Pass {include:'all'} to also
// project every live paid x402 service into the same row schema, ready for a
// listing expansion beyond the 3D studio.
export function toOkxCatalog({ include = 'okx' } = {}) {
	const index = okxCatalogIndex();
	if (include === 'okx') return index;
	const projected = PAID_SERVICES.filter((s) => s.status === 'live').map((s) => {
		const entry = normalizePaid(s);
		return {
			id: entry.slug,
			name: clampWidth(entry.title, 80),
			kind: 'rest',
			description: {
				capability: clampWidth(entry.useCase),
				input: clampWidth(okxInputHint(entry)),
			},
			price_usd: entry.price.usd,
			endpoint: entry.endpoint,
			...(entry.inputSchema ? { input_schema: entry.inputSchema } : {}),
		};
	});
	return { ...index, services: [...index.services, ...projected] };
}
