// agora-citizens — world-seed. Fills the Commons with the platform's OWN 3D
// agents: the ones that carry a rigged humanoid GLB avatar (store.
// listRiggedSeedAgents). Each becomes a citizen with its REAL avatar, a canonical
// AgenC id derived offline via the identity bridge, and a profession mapped from
// its real signals (roster.professionForAgent).
//
// This path signs NO transaction and needs NO SOL: presence in the world does not
// require an on-chain PDA (agora_citizens.agenc_agent_pda stays null → the API and
// 3D world render the citizen as "pending registration"). It projects NO activity
// row either — a citizen only *exists* and idles until the funded life-engine
// registers it on AgenC and it starts claiming → working → earning. So the world
// is alive immediately, and every economic FACT still traces to a real on-chain
// action when it happens. No mocks, no fabricated trades.
//
//   AGORA_SEED_ONLY=1 AGORA_SEED_LIMIT=120 node index.js

import { log } from './log.js';
import { deriveIdentity } from './agenc.js';
import { buildWorldSeedRoster } from './roster.js';

/**
 * Project up to cfg.seedLimit real rigged agents into agora_citizens. Idempotent:
 * seedWorldCitizen upserts on agent_id, so re-running refreshes avatars/professions
 * without duplicating rows or clobbering a citizen that has since registered
 * on-chain. Returns a summary { candidates, specs, seeded, failed, byProfession }.
 */
export async function seedWorld(cfg, store) {
	// Refresh the pending population: drop the prior unregistered world-seed so a
	// re-seed swaps in the current distinct-avatar set (registered citizens + humans
	// are never touched — the clear is scoped to PDA-null, seedMode='world' rows).
	if (cfg.seedReset) {
		try {
			const removed = await store.clearUnregisteredWorldSeed();
			if (removed) log.info('world-seed: cleared prior pending citizens', { removed });
		} catch (err) {
			log.warn('world-seed: reset failed — seeding over existing rows', { err: err?.message });
		}
	}

	const agents = await store.listRiggedSeedAgents(cfg.seedLimit);
	const specs = buildWorldSeedRoster(agents, cfg);
	log.info('world-seed: roster assembled', { candidates: agents.length, specs: specs.length });

	let seeded = 0;
	let failed = 0;
	const byProfession = {};
	for (const spec of specs) {
		try {
			// Pure identity derivation (identity bridge) — no RPC, no signature.
			const ident = await deriveIdentity(spec.identityRef);
			const row = await store.seedWorldCitizen(spec, {
				agentIdHex: ident.agentIdHex,
				identitySource: ident.source,
				capabilityBits: spec.professionBits,
				avatarId: spec.avatarId,
				avatarUrl: spec.avatarUrl,
			});
			if (row) {
				seeded++;
				byProfession[spec.profession] = (byProfession[spec.profession] || 0) + 1;
			}
		} catch (err) {
			failed++;
			log.warn('world-seed: citizen failed — skipping', { key: spec.key, err: err?.message });
		}
	}

	const summary = { candidates: agents.length, specs: specs.length, seeded, failed, byProfession };
	log.info('world-seed: complete', summary);
	return summary;
}
