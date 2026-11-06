// Agora — the cross-chain identity handshake. When a citizen proves BOTH an EVM
// ERC-8004 identity AND a Solana Metaplex Core (MPL-Core) identity, the AgenC
// bridge binds them into ONE canonical agentId — one agent, two chains, one
// reputation. This panel renders that resolution and, crucially, RE-DERIVES the
// canonical id in the browser from the bridge's documented math, then confirms it
// equals what /api/agenc/link returns. The match is computed, not asserted — so
// the handshake proves itself.
//
// Bridge math mirrors solana-agent-sdk/src/actions/agenc/identity-bridge.ts:
//   composite: sha256("AgenC/three.ws/composite/v1\0" + canonicalJSON)
//   where canonicalJSON = {"v":1,"erc8004":"0x<32-byte BE hex>","mplCore":"<base58>"}

import { h, copyChip } from './panel.js';
import { sha256Hex } from './verify.js';
import { linkIdentity } from './api.js';
import { normalizeHex, shortId, explorerAddressUrl, etherscanAddressUrl } from './format.js';

// @solana/web3.js is the app's heaviest dep (~1MB solana chunk). The handshake
// only needs PublicKey to validate/normalize a base58 asset, and only renders for
// the rare dual-identity citizen — so we lazy-import it here instead of pulling
// the whole solana chunk into every /agora load. Memoized after first use.
let _PublicKey = null;
async function getPublicKey() {
	if (_PublicKey) return _PublicKey;
	({ PublicKey: _PublicKey } = await import('@solana/web3.js'));
	return _PublicKey;
}

const NS_COMPOSITE = 'AgenC/three.ws/composite/v1\0';
const NS_ERC8004 = 'AgenC/three.ws/erc8004/v1\0';
const NS_MPL_CORE = 'AgenC/three.ws/mpl-core/v1\0';
const NS_HANDLE = 'AgenC/three.ws/handle/v1\0';

const enc = new TextEncoder();

function concatBytes(...parts) {
	let len = 0;
	for (const p of parts) len += p.byteLength;
	const out = new Uint8Array(len);
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.byteLength; }
	return out;
}

// 32-byte big-endian encoding of an ERC-8004 uint256 agentId.
function erc8004IdToBeBytes(id) {
	let n = typeof id === 'bigint' ? id : BigInt(String(id).trim());
	if (n < 0n) throw new Error('ERC-8004 agentId must be non-negative');
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0 && n > 0n; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
	return out;
}

// Parse the identity proofs out of an on-chain metadataUri produced by
// buildThreewsMetadataUri (…/.well-known/agent.json?erc8004=&mpl=&handle=).
// Pure + null-safe — returns {} when the URI carries no recognizable proofs.
export function parseIdentityProofs(metadataUri) {
	const out = { erc8004AgentId: null, mplCoreAsset: null, handle: null };
	if (!metadataUri || typeof metadataUri !== 'string') return out;
	let qs = '';
	const qi = metadataUri.indexOf('?');
	if (qi >= 0) qs = metadataUri.slice(qi + 1);
	else if (/^[\w-]+=/.test(metadataUri)) qs = metadataUri; // bare query
	const params = new URLSearchParams(qs);
	const erc = params.get('erc8004') || params.get('erc');
	const mpl = params.get('mpl') || params.get('mplCore') || params.get('asset');
	const handle = params.get('handle');
	if (erc) out.erc8004AgentId = erc;
	if (mpl) out.mplCoreAsset = mpl;
	if (handle) out.handle = handle.toLowerCase();
	return out;
}

export function hasDualIdentity(proofs) {
	return !!(proofs && proofs.erc8004AgentId != null && proofs.erc8004AgentId !== ''
		&& proofs.mplCoreAsset != null && proofs.mplCoreAsset !== '');
}

// Re-derive the canonical AgenC agentId (64-char lowercase hex) from proofs,
// exactly as the on-chain bridge does. Selection priority matches
// getCanonicalThreewsAgenCId: composite > erc8004 > mpl-core > handle.
export async function deriveCanonicalAgenCId(proofs) {
	const hasErc = proofs.erc8004AgentId != null && proofs.erc8004AgentId !== '';
	const hasMpl = proofs.mplCoreAsset != null && proofs.mplCoreAsset !== '';

	if (hasErc && hasMpl) {
		const PublicKey = await getPublicKey();
		const ercBytes = erc8004IdToBeBytes(proofs.erc8004AgentId);
		const ercHex = [...ercBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
		const mplBase58 = new PublicKey(proofs.mplCoreAsset).toBase58();
		const composite = JSON.stringify({ v: 1, erc8004: '0x' + ercHex, mplCore: mplBase58 });
		return { source: 'composite', hex: await sha256Hex(concatBytes(enc.encode(NS_COMPOSITE), enc.encode(composite))) };
	}
	if (hasErc) {
		return { source: 'erc8004', hex: await sha256Hex(concatBytes(enc.encode(NS_ERC8004), erc8004IdToBeBytes(proofs.erc8004AgentId))) };
	}
	if (hasMpl) {
		const PublicKey = await getPublicKey();
		const pkBytes = new PublicKey(proofs.mplCoreAsset).toBytes();
		return { source: 'mpl-core', hex: await sha256Hex(concatBytes(enc.encode(NS_MPL_CORE), pkBytes)) };
	}
	if (proofs.handle) {
		return { source: 'handle', hex: await sha256Hex(concatBytes(enc.encode(NS_HANDLE), enc.encode(String(proofs.handle).trim().toLowerCase()))) };
	}
	throw new Error('no identity proofs supplied');
}

// Render the handshake into `container`. Shows the EVM ↔ Solana resolution, the
// canonical AgenC id, and a computed bridge-verification check.
//
//   renderHandshake(container, { proofs, cluster, expectedAgentPda })
export async function renderHandshake(container, { proofs, cluster = 'devnet', expectedAgentPda } = {}) {
	container.classList.add('agora-handshake');
	if (!hasDualIdentity(proofs)) {
		container.replaceChildren(); // host decides whether to show anything
		return false;
	}

	container.replaceChildren(h('div', { class: 'agora-handshake-loading' }, [
		h('span', { class: 'agora-skel agora-skel-line' }),
		h('span', { class: 'agora-handshake-loading-label' }, ['Resolving the cross-chain identity…']),
	]));

	// Derive locally + ask the bridge endpoint in parallel; the panel only claims
	// "verified" when the two agree.
	let local, remote;
	try {
		[local, remote] = await Promise.all([
			deriveCanonicalAgenCId(proofs),
			linkIdentity({ erc8004AgentId: proofs.erc8004AgentId, mplCoreAsset: proofs.mplCoreAsset, cluster }),
		]);
	} catch (err) {
		container.replaceChildren(h('p', { class: 'agora-muted' }, [`Couldn't resolve the cross-chain identity: ${err.message}`]));
		return true;
	}

	const remoteHex = normalizeHex(remote.agenCAgentId);
	const localHex = normalizeHex(local.hex);
	const bridgeVerified = remoteHex.length === 64 && remoteHex === localHex;
	const pdaMatches = !expectedAgentPda || !remote.agentPda || expectedAgentPda === remote.agentPda;

	container.replaceChildren(buildHandshake({ proofs, cluster, remote, remoteHex, bridgeVerified, pdaMatches, expectedAgentPda }));
	return true;
}

function buildHandshake({ proofs, cluster, remote, remoteHex, bridgeVerified, pdaMatches }) {
	const evmAddr = looksLikeEvmAddress(proofs.erc8004AgentId) ? proofs.erc8004AgentId : null;

	const evmCard = chainCard({
		chain: 'EVM', standard: 'ERC-8004', glyph: '⬡',
		idLabel: 'agent id', idValue: String(proofs.erc8004AgentId),
		link: evmAddr ? etherscanAddressUrl(evmAddr) : null,
		linkText: evmAddr ? 'Etherscan ↗' : null,
	});
	const solCard = chainCard({
		chain: 'Solana', standard: 'MPL-Core', glyph: '◎',
		idLabel: 'asset', idValue: shortId(proofs.mplCoreAsset, 4, 4),
		copyValue: proofs.mplCoreAsset,
		link: explorerAddressUrl(proofs.mplCoreAsset, cluster),
		linkText: 'Explorer ↗',
	});

	const canonical = h('div', { class: 'agora-handshake-canonical' }, [
		h('div', { class: 'agora-handshake-canon-head' }, [
			h('span', { class: 'agora-handshake-canon-title' }, ['Canonical AgenC id']),
			bridgeVerified
				? h('span', { class: 'agora-handshake-verified', title: 'Re-derived in your browser from the bridge math and matched the registry' }, ['✓ bridge-verified'])
				: h('span', { class: 'agora-handshake-unverified', title: 'Local derivation did not match the bridge endpoint' }, ['⚠ unverified']),
		]),
		h('div', { class: 'agora-hash-row' }, [
			h('code', { class: `agora-hash ${bridgeVerified ? 'is-ok' : 'is-bad'}` }, [shortId(remoteHex, 12, 12)]),
			copyChip(remoteHex, 'canonical AgenC id'),
		]),
		remote.agentPda ? h('div', { class: 'agora-hash-row' }, [
			h('span', { class: 'agora-hash-label' }, ['agent PDA']),
			h('a', { class: 'agora-addr', href: explorerAddressUrl(remote.agentPda, cluster), target: '_blank', rel: 'noopener noreferrer' }, [shortId(remote.agentPda, 4, 4), ' ↗']),
			copyChip(remote.agentPda, 'agent PDA'),
		]) : null,
		h('div', { class: 'agora-handshake-flags' }, [
			flag(remote.registered, remote.registered ? 'Registered on-chain' : 'Not yet registered'),
			!pdaMatches ? flag(false, 'PDA differs from citizen record') : null,
		].filter(Boolean)),
	].filter(Boolean));

	return h('div', { class: 'agora-handshake-inner' }, [
		h('p', { class: 'agora-handshake-explainer' }, [
			h('strong', {}, ['One agent, two chains, one reputation.']),
			' This citizen proves an identity on both Ethereum (ERC-8004) and Solana (MPL-Core). The bridge hashes both proofs into a single canonical AgenC id, so neither side can be swapped without re-registering.',
		]),
		h('div', { class: 'agora-handshake-bridge' }, [
			evmCard,
			h('div', { class: 'agora-handshake-merge', 'aria-hidden': 'true' }, [
				h('span', { class: 'agora-handshake-merge-line' }),
				h('span', { class: 'agora-handshake-merge-node' }, ['⛓']),
				h('span', { class: 'agora-handshake-merge-line' }),
			]),
			solCard,
		]),
		canonical,
	]);
}

function chainCard({ chain, standard, glyph, idLabel, idValue, copyValue, link, linkText }) {
	return h('div', { class: 'agora-chaincard' }, [
		h('div', { class: 'agora-chaincard-head' }, [
			h('span', { class: 'agora-chaincard-glyph', 'aria-hidden': 'true' }, [glyph]),
			h('div', {}, [
				h('div', { class: 'agora-chaincard-chain' }, [chain]),
				h('div', { class: 'agora-chaincard-standard' }, [standard]),
			]),
		]),
		h('div', { class: 'agora-chaincard-id' }, [
			h('span', { class: 'agora-kv-key' }, [idLabel]),
			h('code', { class: 'agora-chaincard-val' }, [idValue]),
			copyValue ? copyChip(copyValue, idLabel) : null,
		].filter(Boolean)),
		link ? h('a', { class: 'agora-chaincard-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, [linkText]) : null,
	].filter(Boolean));
}

function flag(ok, label) {
	return h('span', { class: `agora-flag ${ok ? 'is-on' : 'is-off'}` }, [
		h('span', { class: 'agora-flag-dot', 'aria-hidden': 'true' }), label,
	]);
}

function looksLikeEvmAddress(v) {
	return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}
