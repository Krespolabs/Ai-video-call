// Resolve a gift recipient from a public identifier the gifter typed:
// a username (@-prefix optional), a wallet address (EVM 0x… or Solana base58),
// or a raw user id. Returns a *public* profile only — never email, never the
// private account fields — so this can safely back an authenticated lookup
// endpoint without leaking who holds which email.
//
// Resolution order is identifier-shaped, not a blind fan-out:
//   uuid → users.id
//   0x…  → users.wallet_address OR user_wallets.address (case-insensitive)
//   base58 → user_wallets.address (Solana, case-sensitive)
//   else → username (case-insensitive)
//
// Email is intentionally NOT resolvable here: usernames and wallet addresses
// are public handles; emails are not, and matching on them would turn this into
// an account-enumeration oracle.

import { sql } from './db.js';
import { isUuid } from './validate.js';

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const PUBLIC_COLS = 'id, username, display_name, avatar_url';

/**
 * @param {string} identifier - username, wallet address, or user id.
 * @returns {Promise<{id:string, username:string|null, display_name:string|null, avatar_url:string|null}|null>}
 */
export async function resolveRecipient(identifier) {
	if (typeof identifier !== 'string') return null;
	let q = identifier.trim();
	if (!q) return null;
	if (q[0] === '@') q = q.slice(1).trim();
	if (!q) return null;

	// 1. Raw user id.
	if (isUuid(q)) {
		const [u] = await sql`
			SELECT id, username, display_name, avatar_url
			FROM users WHERE id = ${q} AND deleted_at IS NULL LIMIT 1`;
		return u ?? null;
	}

	// 2. EVM wallet — stored lowercased on both the login column and user_wallets.
	if (EVM_RE.test(q)) {
		const lc = q.toLowerCase();
		const [u] = await sql`
			SELECT u.id, u.username, u.display_name, u.avatar_url
			FROM users u
			WHERE u.deleted_at IS NULL
			  AND (lower(u.wallet_address) = ${lc}
			       OR EXISTS (
			           SELECT 1 FROM user_wallets w
			           WHERE w.user_id = u.id AND lower(w.address) = ${lc}))
			LIMIT 1`;
		return u ?? null;
	}

	// 3. Solana wallet — base58 is case-sensitive, matched verbatim.
	if (SOL_RE.test(q)) {
		const [u] = await sql`
			SELECT u.id, u.username, u.display_name, u.avatar_url
			FROM users u
			JOIN user_wallets w ON w.user_id = u.id
			WHERE u.deleted_at IS NULL AND w.address = ${q} AND w.chain_type = 'solana'
			LIMIT 1`;
		if (u) return u;
		// fall through: a base58-shaped string could still be a literal username.
	}

	// 4. Username (case-insensitive).
	const [u] = await sql`
		SELECT id, username, display_name, avatar_url
		FROM users
		WHERE lower(username) = lower(${q}) AND deleted_at IS NULL
		LIMIT 1`;
	return u ?? null;
}

// PUBLIC_COLS is exported so the lookup endpoint and any future caller stay in
// lockstep on exactly which fields are safe to surface.
export { PUBLIC_COLS };
