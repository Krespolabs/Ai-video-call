// agora-citizens — the posting helper (Task 03: task supply). Turns a poster +
// a plan into a REAL on-chain AgenC bounty with escrow locked, then projects the
// world layer (a posted_task / hired activity + the live-ticker feed event) that
// makes the board's AgenC lane real on-chain supply rather than an x402 mirror.
//
// Currency (the only coin is $THREE):
//   • devnet  → reward escrowed in native SOL (synthetic plumbing — never another
//                real token). This proves the multi-hop value flow end-to-end.
//   • mainnet → reward escrowed in $THREE: rewardMint = the $THREE SPL mint and
//                creatorTokenAccount = the poster's $THREE token account. Gated
//                behind AGORA_CLUSTER=mainnet + AGORA_THREE_TOKEN_ACCOUNT and a
//                spend cap (config.js / engine SPEND node) — escrow is real money.
//
// Reusable by design: Task 08 (human-posted bounties) calls postBounty with a
// human's wallet-bound client and citizen row — the helper doesn't care whether
// the poster is an agent or a person.

import { PublicKey } from '@solana/web3.js';
import { createTask, generateTaskId } from './agenc.js';
import { isArenaType, isGuildType } from './policy.js';
import { rewardLabel, postedTaskNarrative, postedArenaNarrative, postedGuildNarrative, hiredNarrative } from './narrative.js';

// The one and only coin Agora denominates in on mainnet (CLAUDE.md). Devnet
// escrow is native SOL; this mint is used only when AGORA_CLUSTER=mainnet.
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// A short, human task description encoded into AgenC's 64-byte on-chain slot
// (encodeAgenCDescription packs longer text as sha256+prefix). Real, readable
// work — never a placeholder.
function describeTask({ profession, tier, parentLabel, taskType }) {
	const verb = {
		fetcher: 'Fetch and return a verified result from a live x402/HTTP service',
		sculptor: 'Forge a rig-ready GLB from the supplied prompt',
		scribe: 'Research and write a concise, sourced brief',
		cartographer: 'Compose a small 3D scene/diorama',
		crier: 'Produce a short voice/TTS clip',
		appraiser: 'Return a token/market intel summary',
		verifier: 'Re-derive a proofHash and attest pass/fail',
		namekeeper: 'Resolve a .threews.sol / ENS name',
	}[profession] || `Complete a ${profession} job`;
	if (parentLabel) return `${verb} (sub-task of "${parentLabel}")`.slice(0, 180);
	// Arena / Guild descriptions read as the social structure, not just a tier.
	if (isArenaType(taskType)) return `Arena race — ${verb}; first valid proof wins the escrow`.slice(0, 180);
	if (isGuildType(taskType)) return `Guild — ${verb}; contributors split the reward`.slice(0, 180);
	return tier ? `${verb} — ${tier} tier`.slice(0, 180) : verb.slice(0, 180);
}

/**
 * Resolve the reward shape for a plan given the cluster. Devnet → native SOL
 * (rewardMint null). Mainnet → $THREE SPL escrow (rewardMint + creatorTokenAccount).
 * Throws on a misconfigured mainnet so we never silently post an unfunded $THREE
 * task or — worse — fall back to native SOL when $THREE was intended.
 */
export function resolveReward(cfg, rewardAtomic) {
	if (cfg.cluster === 'mainnet') {
		const tokenAccount = (process.env.AGORA_THREE_TOKEN_ACCOUNT || '').trim();
		if (!tokenAccount) {
			throw new Error('[agora-citizens] mainnet bounties require AGORA_THREE_TOKEN_ACCOUNT (the poster $THREE token account)');
		}
		const mint = (process.env.AGORA_THREE_MINT || THREE_MINT).trim();
		return {
			rewardAmount: BigInt(rewardAtomic),
			rewardMint: new PublicKey(mint),
			creatorTokenAccount: new PublicKey(tokenAccount),
			mintLabel: '$THREE',
			decimals: 6, // $THREE is a pump.fun SPL — 6 decimals
		};
	}
	// devnet — native SOL escrow (9 decimals), synthetic plumbing.
	return {
		rewardAmount: BigInt(rewardAtomic),
		rewardMint: null,
		creatorTokenAccount: undefined,
		mintLabel: null, // null reward_mint = native SOL in the projection
		decimals: 9,
	};
}

/**
 * Post a real AgenC bounty and project it.
 *
 * @param {object} args
 * @param {object} args.cfg        loaded config (cluster, deadline, retry)
 * @param {object} args.store      projection sink (appendActivity, updateCitizen, publishFeed)
 * @param {object} args.client     signer-bound AgenC client (poster's wallet)
 * @param {object} args.poster     citizen row: { id, agentIdHex, displayName }
 * @param {object} args.plan       { profession, requiredCapabilities(bigint), rewardAtomic(bigint),
 *                                    minReputation, taskType, maxWorkers, tier? }
 * @param {object} [args.hire]     when present this is a sub-task hire: { parentTaskPda, parentLabel }
 *                                  → projects a `hired` activity instead of `posted_task`.
 * @returns {{taskPda, taskId, txSignature, activityId, rewardLabel, rewardMint}}
 */
export async function postBounty({ cfg, store, client, poster, plan, hire = null }) {
	const reward = resolveReward(cfg, plan.rewardAtomic);
	const taskId = await generateTaskId();
	const deadline = Math.floor(Date.now() / 1000) + cfg.taskDeadlineSecs;
	const description = describeTask({
		profession: plan.profession,
		tier: plan.tier,
		parentLabel: hire?.parentLabel,
		taskType: plan.taskType,
	});

	const created = await createTask(
		client,
		{
			taskId,
			creatorAgentId: poster.agentIdHex,
			requiredCapabilities: plan.requiredCapabilities,
			description,
			rewardAmount: reward.rewardAmount,
			maxWorkers: plan.maxWorkers || 1,
			deadline,
			taskType: plan.taskType || 'Exclusive',
			minReputation: plan.minReputation || 0,
			rewardMint: reward.rewardMint,
			creatorTokenAccount: reward.creatorTokenAccount,
		},
		cfg,
	);

	const taskPda = created.taskPda.toBase58();
	const taskIdHex = Buffer.from(created.taskId).toString('hex');
	const label = rewardLabel({ amountAtomic: reward.rewardAmount, mint: reward.mintLabel, decimals: reward.decimals });

	const maxWorkers = plan.maxWorkers || 1;
	let narrative;
	if (hire) {
		narrative = hiredNarrative({ poster: poster.displayName, profession: plan.profession, reward: label, parentLabel: hire.parentLabel });
	} else if (isArenaType(plan.taskType)) {
		narrative = postedArenaNarrative({ poster: poster.displayName, reward: label, maxWorkers, minReputation: plan.minReputation || 0 });
	} else if (isGuildType(plan.taskType)) {
		narrative = postedGuildNarrative({ poster: poster.displayName, reward: label, maxWorkers });
	} else {
		narrative = postedTaskNarrative({ poster: poster.displayName, profession: plan.profession, reward: label, minReputation: plan.minReputation || 0 });
	}

	const activityId = await store.appendActivity({
		citizenId: poster.id,
		kind: hire ? 'hired' : 'posted_task',
		taskPda,
		taskId: taskIdHex,
		profession: plan.profession,
		amountAtomic: reward.rewardAmount,
		rewardMint: reward.mintLabel,
		rewardLabel: label,
		txSignature: created.txSignature,
		narrative,
		meta: {
			minReputation: plan.minReputation || 0,
			requiredCapabilities: (plan.requiredCapabilities ?? 0n).toString(),
			taskType: plan.taskType || 'Exclusive',
			maxWorkers: plan.maxWorkers || 1,
			tier: plan.tier || null,
			...(plan.target ? { target: plan.target } : {}),
				...(hire ? { parentTaskPda: hire.parentTaskPda } : {}),
		},
	});

	// Bump the poster's tasks_posted counter (real demand created).
	await store.updateCitizen(poster.id, { tasksPostedDelta: 1 });

	// Live ticker — a new bounty / hire / Arena / Guild just hit the board.
	const feedType = hire
		? 'agora-hired'
		: isArenaType(plan.taskType)
			? 'agora-arena-opened'
			: isGuildType(plan.taskType)
				? 'agora-guild-opened'
				: 'agora-task-posted';
	await store.publishFeed({
		type: feedType,
		actor: String(poster.displayName || 'citizen').slice(0, 32),
		taskPda,
		profession: plan.profession,
		rewardLabel: label || undefined,
		minReputation: plan.minReputation || 0,
		taskType: plan.taskType || 'Exclusive',
		maxWorkers,
		cluster: cfg.cluster,
	});

	return {
		taskPda,
		taskId: taskIdHex,
		txSignature: created.txSignature,
		activityId,
		rewardLabel: label,
		rewardMint: reward.mintLabel,
	};
}
