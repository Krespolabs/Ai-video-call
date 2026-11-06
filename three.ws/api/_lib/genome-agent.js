// Genome ⇆ agent glue. Loads the heritable slice of an agent (the fields
// api/_lib/genome.js reads), resolves an agent's genome (stored or founder-derived),
// and centralizes the breeding-eligibility + cooldown + stud-consent rules so the
// preview, breed, and lineage endpoints agree on one source of truth.

import { sql } from './db.js';
import { solanaConnection } from './agent-pumpfun.js';
import { TOKEN_MINT, TOKEN_DECIMALS } from './token/config.js';
import {
	genomeFromAgent,
	normalizeGenome,
	GENOME_VERSION,
	pedigreeScore,
	voiceSettings,
	appearanceFromGenome,
	composePersonaPrompt,
	expressedSkills,
} from './genome.js';

const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;

// Verify, on-chain, that a stud fee was actually paid in $THREE to the stud
// owner(s) before a cross-owner breeding is allowed. Without this, the breed
// endpoint only checked that *some* (any) string was supplied as the settlement
// signature — letting a breeder pair with a paid, rare stud for free and stiff
// the stud owner. Returns { ok, atomics } or { ok:false, reason }.
//
// `recipientOwners` is the set of the cross-owner studs' Solana payout wallets;
// the total $THREE credited across them in the referenced transaction must cover
// the fee. Replay across breedings is prevented by the caller (signature must be
// unique in genome_breedings).
export async function verifyStudFeePayment({ signature, recipientOwners, feeThree, network = 'mainnet' }) {
	const sig = String(signature || '').trim();
	if (!SOL_SIG_RE.test(sig)) {
		return { ok: false, reason: 'stud_fee_signature is not a valid Solana transaction signature' };
	}
	const owners = [...new Set((recipientOwners || []).filter(Boolean))];
	if (!owners.length) {
		return { ok: false, reason: 'the stud has no Solana payout wallet on record — cannot verify the fee' };
	}
	const decimals = Number(TOKEN_DECIMALS) || 6;
	const need = BigInt(Math.ceil((Number(feeThree) || 0) * 10 ** decimals));
	if (need <= 0n) return { ok: true, atomics: '0' };

	const conn = solanaConnection(network === 'devnet' ? 'devnet' : 'mainnet');
	let tx;
	try {
		tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
	} catch {
		return { ok: false, reason: 'could not fetch the stud-fee transaction from the chain' };
	}
	if (!tx) return { ok: false, reason: 'stud-fee transaction not found or not yet confirmed' };
	if (tx.meta?.err) return { ok: false, reason: 'the stud-fee transaction failed on-chain' };

	// Sum the $THREE balance delta credited to any stud owner wallet in this tx
	// (robust to an ATA created within the same transaction).
	const pre = tx.meta?.preTokenBalances || [];
	const post = tx.meta?.postTokenBalances || [];
	const ownerSet = new Set(owners);
	let delta = 0n;
	for (const p of post) {
		if (p.mint !== TOKEN_MINT || !ownerSet.has(p.owner)) continue;
		const before = pre.find((x) => x.accountIndex === p.accountIndex);
		delta += BigInt(p.uiTokenAmount?.amount ?? '0') - BigInt(before?.uiTokenAmount?.amount ?? '0');
	}
	if (delta < need) {
		return { ok: false, reason: `stud-fee transfer is too small: need ${feeThree} $THREE paid to the stud owner` };
	}
	return { ok: true, atomics: delta.toString() };
}

// Client-safe projection of a genome — everything needed to render the predicted
// offspring (traits, voice settings + voice_id for a real TTS sample, bakeable
// appearance, skill alleles, mutations, pedigree). Carries no secret; a genome
// never holds one.
export function publicGenome(genome, name = 'Offspring') {
	const g = normalizeGenome(genome);
	return {
		version: g.version,
		generation: g.generation,
		brain: g.brain,
		voice: {
			provider: g.voice.provider,
			voice_id: g.voice.voice_id,
			model: g.voice.model,
			pitch: g.voice.pitch,
			settings: voiceSettings(g),
		},
		appearance: appearanceFromGenome(g),
		skills: g.skills,
		expressed_skills: expressedSkills(g),
		mutations: g.mutations,
		persona_prompt: composePersonaPrompt(g, name),
		pedigree: pedigreeScore(g),
	};
}

// A parent can breed at most once per cooldown window — keeps deep pedigrees
// scarce and blocks spam-minting offspring. Per agent, regardless of who breeds it.
export const BREED_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

// Load every column genome derivation needs, joined to the backing avatar so we
// have its GLB storage key + appearance for body synthesis.
export async function loadBreedingAgent(agentId) {
	const [row] = await sql`
		select i.id, i.user_id, i.name, i.meta, i.skills, i.is_public, i.wallet_address,
		       i.persona_prompt, i.persona_tone_tags,
		       i.voice_provider, i.voice_id, i.voice_model, i.voice_settings,
		       i.avatar_id,
		       a.storage_key as avatar_storage_key,
		       a.appearance  as avatar_appearance,
		       a.visibility  as avatar_visibility,
		       a.name        as avatar_name
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.id = ${agentId} and i.deleted_at is null
		limit 1
	`;
	return row || null;
}

// Shape a DB row into the object genomeFromAgent() consumes. A stored genome on
// meta.genome wins; otherwise a stable founder genome is derived from real traits.
export function agentGenome(row) {
	const meta = row.meta || {};
	if (meta.genome && meta.genome.version === GENOME_VERSION) return normalizeGenome(meta.genome);
	return genomeFromAgent({
		id: row.id,
		meta,
		persona_tone_tags: row.persona_tone_tags || meta.persona_tone_tags || [],
		voice_provider: row.voice_provider,
		voice_id: row.voice_id,
		voice_model: row.voice_model,
		voice_settings: row.voice_settings,
		appearance: row.avatar_appearance || meta.appearance || {},
		skills: row.skills || [],
		avatar_id: row.avatar_id,
	});
}

// The owner-set breeding policy for an agent (defaults: own-use breedable, not a
// public stud, no fee). Lives on meta.genome_breeding.
export function breedingPolicy(row) {
	const p = (row.meta || {}).genome_breeding || {};
	return {
		breedable: p.breedable !== false,
		stud: p.stud === true,
		stud_fee_three: Math.max(0, Number(p.stud_fee_three) || 0),
	};
}

// Can `callerUserId` use `row` as a breeding parent?
//   • own agent (breedable)           → free, allowed
//   • someone else's public stud       → allowed, may carry a $THREE stud fee
//   • anything else                    → denied
// Returns { allowed, reason, fee_three, cross_owner, owner_id }.
export function eligibilityFor(row, callerUserId) {
	const policy = breedingPolicy(row);
	const owned = row.user_id === callerUserId;
	if (owned) {
		if (!policy.breedable) return { allowed: false, reason: 'parent_not_breedable' };
		return { allowed: true, fee_three: 0, cross_owner: false, owner_id: row.user_id };
	}
	if (!row.is_public) return { allowed: false, reason: 'parent_private' };
	if (!policy.stud) return { allowed: false, reason: 'parent_not_listed_as_stud' };
	return { allowed: true, fee_three: policy.stud_fee_three, cross_owner: true, owner_id: row.user_id };
}

// Most-recent breeding timestamp for an agent as either parent. Null if never.
export async function lastBredAt(agentId) {
	const [row] = await sql`
		select max(created_at) as last
		from genome_breedings
		where (parent_a_agent_id = ${agentId} or parent_b_agent_id = ${agentId})
		  and status <> 'failed'
	`;
	return row?.last ? new Date(row.last) : null;
}

// Cooldown check against an injected `now` (testable, no Date.now in genome core).
export async function cooldownRemainingMs(agentId, now = Date.now()) {
	const last = await lastBredAt(agentId);
	if (!last) return 0;
	const remaining = BREED_COOLDOWN_MS - (now - last.getTime());
	return remaining > 0 ? remaining : 0;
}
