// @ts-check
// Shared social/identity → reward-destination resolution. Turns a GitHub OR X
// (Twitter) identity into a concrete fee-share recipient so the public
// resolve endpoints, the fees panel, and the launch use-case engine all route
// creator rewards the same way — for any supported platform, not just GitHub.
//
// Three outcomes per platform, mirroring pump.fun's social-fee model:
//   wallet      — the user is on three.ws (linked via OAuth) AND has a Solana
//                 payout wallet. Fully claimable via the distribute crank.
//   social_pda  — on three.ws but no wallet yet, or resolved by numeric id. Fees
//                 accrue in a pump.fun social-fee escrow; claim is brokered by
//                 pump.fun (we don't hold the social-claim authority).
//   unresolved  — not on three.ws and no numeric id to derive an escrow PDA.
//
// pump.fun keys social-fee PDAs by the NUMERIC user id per platform (Pump=0,
// X=1, GitHub=2) — see SOCIAL_PLATFORM_ID.

import { sql } from './db.js';

// pump.fun social platform ids (matches the SDK's Platform enum): Pump=0, X=1, GitHub=2.
export const SOCIAL_PLATFORM_ID = { pump: 0, x: 1, github: 2 };

// Provider strings in social_connections (written by each OAuth flow).
const PROVIDER = { github: 'github', x: 'x' };

/**
 * Resolve a social identity (GitHub or X) to a reward destination.
 * @param {{ platform?: 'github'|'x', username?: string, userId?: string, network?: 'mainnet'|'devnet' }} opts
 * @returns {Promise<{ platform:string, mode:'wallet'|'social_pda'|'unresolved', address:string|null, username:string|null, user_id:string|null, claimable_now:boolean, note:string }>}
 */
export async function resolveSocialReward({ platform = 'github', username, userId, network = 'mainnet' } = {}) {
	const plat = platform === 'x' ? 'x' : 'github';
	const provider = PROVIDER[plat];
	const label = plat === 'x' ? 'X account' : 'GitHub user';
	const handle = username ? String(username).replace(/^@/, '').trim() : null;
	const uid = userId ? String(userId).trim() : null;
	if (!handle && !uid) {
		return { platform: plat, mode: 'unresolved', address: null, username: null, user_id: null,
			claimable_now: false, note: `Provide a ${label} username or numeric id.` };
	}

	const [conn] = await sql`
		select user_id, provider_uid, username
		from social_connections
		where provider=${provider} and disconnected_at is null
		  and (${handle}::text is not null and lower(username)=lower(${handle})
		       or ${uid}::text is not null and provider_uid=${uid})
		order by connected_at desc
		limit 1
	`;

	const { socialFeePda } = await import('@pump-fun/pump-sdk');
	const platformId = SOCIAL_PLATFORM_ID[plat];

	if (conn) {
		const [wallet] = await sql`
			select address from user_wallets
			where user_id=${conn.user_id} and chain_type='solana'
			order by is_primary desc, created_at asc
			limit 1
		`;
		if (wallet) {
			return { platform: plat, mode: 'wallet', address: wallet.address,
				username: conn.username, user_id: conn.provider_uid, claimable_now: true,
				note: 'Linked Solana payout wallet — pays out via the permissionless distribute crank.' };
		}
		return { platform: plat, mode: 'social_pda', address: socialFeePda(String(conn.provider_uid), platformId).toBase58(),
			username: conn.username, user_id: conn.provider_uid, claimable_now: false,
			note: `This ${label} has no Solana payout wallet linked yet. Fees accrue in a pump.fun social-fee escrow; ask them to link a Solana wallet on three.ws to claim directly.` };
	}

	if (uid) {
		return { platform: plat, mode: 'social_pda', address: socialFeePda(String(uid), platformId).toBase58(),
			username: handle, user_id: uid, claimable_now: false,
			note: `This ${label} is not on three.ws. Fees accrue in a pump.fun social-fee escrow they can claim once they connect and link a Solana wallet.` };
	}
	return { platform: plat, mode: 'unresolved', address: null, username: handle, user_id: null, claimable_now: false,
		note: `No three.ws account found for that ${label}. Provide the numeric id to route into a pump.fun social-fee escrow, or ask them to sign in and link a Solana wallet.` };
}

/**
 * GitHub-specific wrapper (back-compat with the original shape). Delegates to
 * resolveSocialReward with platform 'github'.
 * @param {{ githubUsername?: string, githubUserId?: string, network?: 'mainnet'|'devnet' }} opts
 */
export async function resolveGithubReward({ githubUsername, githubUserId, network = 'mainnet' } = {}) {
	const r = await resolveSocialReward({ platform: 'github', username: githubUsername, userId: githubUserId, network });
	return { mode: r.mode, address: r.address, github_username: r.username, github_user_id: r.user_id,
		claimable_now: r.claimable_now, note: r.note };
}
