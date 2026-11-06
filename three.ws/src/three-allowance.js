/**
 * $THREE spend allowance — client helper.
 *
 * Lets a holder authorize a $THREE spending cap ONCE (one wallet signature), after
 * which paid actions across the platform debit that cap with no further popups.
 * Built on Solana's native Subscriptions & Allowances program — non-custodial:
 * the tokens stay in the user's wallet until an actual charge pulls them, and the
 * cap is the hard ceiling the platform delegate can ever touch.
 *
 *   import { fetchAllowanceStatus, grantAllowance } from './three-allowance.js';
 *   const status = await fetchAllowanceStatus();          // { enabled, remaining_tokens, … }
 *   await grantAllowance({ capTokens: 1000, expiryDays: 30, onStatus });
 *
 * The server prices and builds the grant transaction (api/token/allowance-grant);
 * this helper only resolves the wallet, signs, sends, and confirms. It never holds
 * keys and never reports success the server can't verify on-chain.
 */

// Lazy-load the Solana SDK so it stays out of the initial bundle (mirrors token-pay.js).
let _web3 = null;
async function loadWeb3() {
	if (!_web3) _web3 = await import('@solana/web3.js');
	return _web3;
}

function rpcEndpoint() {
	return (
		(typeof window !== 'undefined' && window.__solanaRpc) ||
		`${window.location.origin}/api/solana-rpc`
	);
}

async function getProvider(explicit) {
	const wallet = explicit || (typeof window !== 'undefined' ? window.solana : null);
	if (!wallet) {
		throw Object.assign(new Error('No Solana wallet found. Install Phantom or connect a wallet.'), {
			code: 'no_wallet',
		});
	}
	if (!wallet.isConnected) {
		if (typeof wallet.connect === 'function') await wallet.connect();
		else throw Object.assign(new Error('Wallet is not connected.'), { code: 'not_connected' });
	}
	return wallet;
}

/**
 * The signed-in holder's live spend allowance.
 * @returns {Promise<{ enabled: boolean, delegate: string|null, wallet?: string|null,
 *   remaining_atomics: string, remaining_tokens?: number, delegations: object[] }>}
 */
export async function fetchAllowanceStatus({ network } = {}) {
	const qs = network ? `?network=${encodeURIComponent(network)}` : '';
	const r = await fetch(`/api/token/allowance-status${qs}`, { credentials: 'include' });
	if (r.status === 401) throw Object.assign(new Error('Sign in to view your allowance.'), { code: 'unauthorized' });
	if (!r.ok) throw new Error(`allowance status ${r.status}`);
	return r.json();
}

/**
 * Authorize (or top up) a $THREE spend cap. One signature; afterwards paid actions
 * debit the cap with no popup until it is spent, expires, or is revoked.
 *
 * @param {{
 *   capTokens: number,                     // whole $THREE the platform may spend over time
 *   expiryDays?: number,                   // optional auto-expiry (1–365); omit for no expiry
 *   network?: 'mainnet'|'devnet',
 *   wallet?: any,                          // override window.solana
 *   onStatus?: (s: 'building'|'awaiting_signature'|'confirming'|'done') => void,
 * }} params
 * @returns {Promise<{ ok: true, signature: string, delegation_pda: string, cap_tokens: number }>}
 */
export async function grantAllowance({
	capTokens,
	expiryDays,
	network = 'mainnet',
	wallet,
	onStatus = () => {},
}) {
	if (!(capTokens > 0)) throw Object.assign(new Error('Enter a spend cap greater than zero.'), { code: 'bad_cap' });

	onStatus('building');
	const prepResp = await fetch('/api/token/allowance-grant', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ cap_tokens: capTokens, expiry_days: expiryDays, network }),
	});
	const prep = await prepResp.json();
	if (!prepResp.ok) {
		throw Object.assign(new Error(prep.error_description || 'could not build allowance'), {
			code: prep.error,
		});
	}

	const web3 = await loadWeb3();
	const { Connection, Transaction } = web3;
	const provider = await getProvider(wallet);
	const connection = new Connection(rpcEndpoint(), 'confirmed');

	// The server returns a fully-formed unsigned tx (recent blockhash + fee payer
	// already set). Deserialize, let the wallet sign, then send + confirm.
	const tx = Transaction.from(Buffer.from(prep.transaction, 'base64'));

	onStatus('awaiting_signature');
	const signature = await provider.sendTransaction(tx, connection);

	onStatus('confirming');
	const latest = await connection.getLatestBlockhash('confirmed');
	await connection.confirmTransaction(
		{ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
		'confirmed',
	);

	// Reconcile server-side so the registry flips this grant to active and the
	// wallet panel shows the new cap immediately (best-effort; status read self-heals).
	await confirmOnServer(prep.delegation_pda, { network }).catch(() => {});

	onStatus('done');
	return {
		ok: true,
		signature,
		delegation_pda: prep.delegation_pda,
		cap_tokens: prep.cap_tokens,
		expiry_ts: prep.expiry_ts,
	};
}

/** Tell the server a signed grant/revoke landed so it reconciles the registry now. */
async function confirmOnServer(delegationPda, { revoked = false, network = 'mainnet' } = {}) {
	const r = await fetch('/api/token/allowance-confirm', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ delegation_pda: delegationPda, revoked, network }),
	});
	return r.ok ? r.json() : null;
}

/**
 * Revoke a delegation — cancel a spend cap and reclaim its rent. One signature.
 * @param {{ delegationPda: string, network?: string, wallet?: any,
 *   onStatus?: (s: 'building'|'awaiting_signature'|'confirming'|'done') => void }} params
 */
export async function revokeAllowance({ delegationPda, network = 'mainnet', wallet, onStatus = () => {} }) {
	if (!delegationPda) throw Object.assign(new Error('Missing allowance to revoke.'), { code: 'bad_input' });

	onStatus('building');
	const prepResp = await fetch('/api/token/allowance-revoke', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ delegation_pda: delegationPda, network }),
	});
	const prep = await prepResp.json();
	if (!prepResp.ok) {
		throw Object.assign(new Error(prep.error_description || 'could not build revoke'), { code: prep.error });
	}

	const web3 = await loadWeb3();
	const { Connection, Transaction } = web3;
	const provider = await getProvider(wallet);
	const connection = new Connection(rpcEndpoint(), 'confirmed');
	const tx = Transaction.from(Buffer.from(prep.transaction, 'base64'));

	onStatus('awaiting_signature');
	const signature = await provider.sendTransaction(tx, connection);

	onStatus('confirming');
	const latest = await connection.getLatestBlockhash('confirmed');
	await connection.confirmTransaction(
		{ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
		'confirmed',
	);
	await confirmOnServer(delegationPda, { revoked: true, network }).catch(() => {});

	onStatus('done');
	return { ok: true, signature, delegation_pda: delegationPda };
}
