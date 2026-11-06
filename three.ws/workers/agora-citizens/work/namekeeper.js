// Namekeeper (capability bit 7) — resolves on-chain names. Backed by
// @three-ws/names over the public /api/sns (Solana) endpoint, the platform's own
// naming system (`*.threews.sol`). The deliverable is the canonical resolution
// record; the proof is sha256 of it. Same `run<Profession>` contract as
// work/fetcher.js.
//
// Scope: this module ships the SNS (.sol) RESOLVE capability (a real read
// producing a real, hashable artifact) — the DEFAULT and always-green path.
// ENS (.eth) resolution stays supported for an explicit `.eth` job, but is NOT a
// default: the public ENS route (/api/agents/ens/<name>) takes the name as a
// path segment, and Vercel treats the trailing `.eth` as a file extension, so a
// dotted name misroutes to the catch-all (a real 404, honestly surfaced) rather
// than the resolver. It re-activates as a default the moment that route accepts a
// dotted name (or moves the name to a query param). Minting `*.threews.sol` needs
// an authenticated, staked signer and is deferred to a later task (noted in
// docs/agora.md) — not stubbed.

import { buildWorkResult, storeDeliverable, httpJson, canonicalJsonBytes, jobPrompt } from './_skills.js';

// SNS (.sol) only — the platform's naming system and the always-reachable path.
// ENS runs only when a job explicitly supplies a `.eth` name (see header).
const DEFAULT_NAMES = ['three.sol', 'bonfida.sol', 'sns.sol'];

function nameFor(citizen, job) {
	const explicit = String(job?.name || jobPrompt(job)).trim();
	if (explicit) return explicit;
	const seed = String(citizen?.agentIdHex || job?.taskPda || '0');
	let h = 0;
	for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return DEFAULT_NAMES[h % DEFAULT_NAMES.length];
}

export async function runNamekeeper({ cfg, citizen, job } = {}) {
	const apiBase = cfg?.apiBase || 'https://three.ws';
	const log = cfg?.log || (() => {});
	const name = nameFor(citizen, job);
	const isEns = /\.eth$/i.test(name);

	log?.(`namekeeper: resolving ${name} (${isEns ? 'ENS' : 'SNS'})`);
	const res = isEns
		? await httpJson(apiBase, `/api/agents/ens/${encodeURIComponent(name.toLowerCase())}`)
		: await httpJson(apiBase, '/api/sns', { query: { name } });
	const data = res?.data || res || {};
	const address = data.address ?? data.owner ?? data.resolvedAddress ?? null;

	const record = {
		kind: 'agora.nameresolve.v1',
		name,
		network: isEns ? 'ethereum' : 'solana',
		address,
		resolved: Boolean(address),
	};
	const bytes = canonicalJsonBytes(record);
	const deliverable = await storeDeliverable({
		profession: 'namekeeper',
		ext: 'json',
		contentType: 'application/json',
		bytes,
		optional: true,
	});

	return buildWorkResult({
		profession: 'namekeeper',
		citizen,
		deliverableUrl: deliverable.url,
		deliverableBytes: bytes,
		summary: record.resolved ? `Resolved ${name} → ${address}` : `Resolved ${name}: no owner on record`,
		meta: { name, resolved: record.resolved, address, network: record.network, stored: deliverable.stored },
	});
}

export default runNamekeeper;
