/**
 * MegaFuel gasless-send client for BNB Chain, with a mandatory self-pay fallback.
 *
 * The crown-jewel BNB capability: a plain private-key EOA can send a transaction
 * that pays ZERO gas, sponsored at the block-building layer (BEP-414 paymaster +
 * BEP-322 atomic bundles), operated by NodeReal's MegaFuel. No smart account, no
 * 7702 delegation — mechanically impossible on Ethereum L1 / Base.
 *
 * Two RPC methods do the whole job (`pm_isSponsorable`, `eth_sendRawTransaction`
 * against the paymaster endpoint), so rather than pull `megafuel-js-sdk` into the
 * serverless bundle we call them directly via `fetch` — same rationale as
 * `erc8004-chains.js` keeping the bundle lean. If MegaFuel declines or is down we
 * self-pay through the prompt-01 public client, so a send NEVER hard-fails on the
 * sponsorship path alone (00-CONTEXT: outage → self-pay).
 *
 * This module never reads a private key. The caller passes a viem account
 * (built from its own signer), and signing happens through that account.
 */

import { getPublicClient } from './chains.js';

/** MegaFuel paymaster endpoints (00-CONTEXT). No secret required for reads/self-pay. */
export const MEGAFUEL_ENDPOINTS = {
	bscMainnet: 'https://bsc-megafuel.nodereal.io',
	bscTestnet: 'https://bsc-megafuel-testnet.nodereal.io',
};

const DEFAULT_TIMEOUT_MS = 8000;

/** Typed error for MegaFuel/self-pay failures. `code` disambiguates the stage. */
export class MegaFuelError extends Error {
	/** @param {string} message @param {{ code?: string, cause?: unknown, mode?: string }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'MegaFuelError';
		this.code = info.code || 'megafuel_error';
		this.mode = info.mode;
		if (info.cause) this.cause = info.cause;
	}
}

function normalizeNetwork(network) {
	if (network === 56 || network === '56' || network === 'bsc' || network === 'mainnet' || network === 'bscMainnet') return 'bscMainnet';
	return 'bscTestnet';
}

/**
 * Resolve the MegaFuel endpoint for `pm_isSponsorable` / `eth_sendRawTransaction`.
 * Per NodeReal's docs these two RPC methods live at the plain `bsc-megafuel(-testnet)`
 * base URL always — there is no API-key path segment for them. `NODEREAL_MEGAFUEL_KEY`
 * is only used by the separate policy-*management* endpoint
 * (`open-platform-ap.nodereal.io/{apikey}/megafuel(-testnet)`, `pm_createPolicy` /
 * `pm_updatePolicy` — a one-time sponsor setup step, not implemented here).
 * Sponsorship itself is resolved server-side purely by matching the tx's `from`
 * address against an already-provisioned policy, so this send path needs no key.
 */
export function megafuelEndpoint(network) {
	const key = normalizeNetwork(network);
	return MEGAFUEL_ENDPOINTS[key];
}

/** Low-level JSON-RPC POST with a bounded timeout. Injectable `fetchImpl` for tests. */
async function rpc(url, method, params, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			signal: controller.signal,
		});
		if (!res.ok) throw new MegaFuelError(`MegaFuel HTTP ${res.status}`, { code: 'http_error' });
		const json = await res.json();
		if (json.error) throw new MegaFuelError(json.error.message || 'rpc error', { code: 'rpc_error', cause: json.error });
		return json.result;
	} finally {
		clearTimeout(timer);
	}
}

/** Shape a viem tx request into the paymaster's expected JSON tx object. */
function toPaymasterTx(tx, from) {
	const hex = (v) => (v == null ? undefined : typeof v === 'bigint' ? `0x${v.toString(16)}` : v);
	return {
		from,
		to: tx.to,
		value: hex(tx.value ?? 0n) ?? '0x0',
		gas: hex(tx.gas),
		data: tx.data || '0x',
	};
}

/**
 * Ask MegaFuel whether it will sponsor a tx. A policy "no" is a NORMAL answer,
 * not an error — this never throws on a decline.
 *
 * @param {'bscMainnet'|'bscTestnet'|56|97} network
 * @param {{ to:string, from?:string, value?:bigint|string, gas?:bigint|string, data?:string }} txRequest
 * @param {{ fetchImpl?:Function, timeoutMs?:number, megafuelRpc?:Function }} [opts]
 * @returns {Promise<{ sponsorable:boolean, sponsorInfo:object|null, reason:string|null }>}
 */
export async function isSponsorable(network, txRequest, opts = {}) {
	const key = normalizeNetwork(network);
	const call = opts.megafuelRpc
		? (method, params) => opts.megafuelRpc(method, params)
		: (method, params) => rpc(megafuelEndpoint(key), method, params, opts);
	try {
		const result = await call('pm_isSponsorable', [toPaymasterTx(txRequest, txRequest.from)]);
		const sponsorable = !!(result && result.sponsorable);
		return {
			sponsorable,
			sponsorInfo: sponsorable ? result : null,
			reason: sponsorable ? null : result?.reason || result?.message || 'not sponsorable',
		};
	} catch (err) {
		// Wire/endpoint failure is treated as "not sponsorable" so the caller
		// silently self-pays. The reason is surfaced for observability.
		return { sponsorable: false, sponsorInfo: null, reason: `probe failed: ${err.message}` };
	}
}

/**
 * Send a transaction gaslessly via MegaFuel when sponsorable, else self-pay.
 * The self-pay fallback is mandatory: a policy decline, a MegaFuel 5xx, or a
 * timeout all resolve to a normal self-paid send. Only a genuinely failed
 * self-pay (no gas / revert) raises a typed error.
 *
 * @param {'bscMainnet'|'bscTestnet'|56|97} network
 * @param {{ account: import('viem').Account, tx: { to:string, value?:bigint, data?:string, gas?:bigint } }} params
 *   `account` is a viem account (caller-owned signer); no key is read here.
 * @param {{
 *   publicClient?: import('viem').PublicClient,
 *   walletClient?: import('viem').WalletClient,
 *   megafuelRpc?: Function, fetchImpl?: Function, timeoutMs?: number,
 * }} [opts]
 * @returns {Promise<{ hash:`0x${string}`, mode:'sponsored'|'self-pay', sponsor?:object|null, reason?:string|null }>}
 */
export async function sendGasless(network, { account, tx }, opts = {}) {
	const key = normalizeNetwork(network);
	if (!account || typeof account.signTransaction !== 'function') {
		throw new MegaFuelError('sendGasless requires a viem account with signTransaction', { code: 'bad_signer' });
	}
	if (!tx || !tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
		throw new MegaFuelError('sendGasless requires tx.to to be a valid address', { code: 'bad_tx' });
	}

	const publicClient = opts.publicClient || getPublicClient(key);
	const chainId = BNB_CHAIN_ID[key];

	// Try the sponsored path first.
	const probe = await isSponsorable(
		key,
		{ to: tx.to, from: account.address, value: tx.value, gas: tx.gas, data: tx.data },
		opts,
	);

	if (probe.sponsorable) {
		try {
			const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
			const gas = tx.gas ?? (await publicClient.estimateGas({ account, to: tx.to, value: tx.value ?? 0n, data: tx.data }));
			// gasPrice: 0 is the whole trick — the sponsor tx pays for inclusion.
			const signed = await account.signTransaction({
				to: tx.to,
				value: tx.value ?? 0n,
				data: tx.data || '0x',
				gas,
				gasPrice: 0n,
				nonce,
				chainId,
			});
			const call = opts.megafuelRpc
				? (m, p) => opts.megafuelRpc(m, p)
				: (m, p) => rpc(megafuelEndpoint(key), m, p, opts);
			const hash = await call('eth_sendRawTransaction', [signed]);
			return { hash, mode: 'sponsored', sponsor: probe.sponsorInfo };
		} catch (err) {
			// MegaFuel accepted the probe but the raw send failed → fall through
			// to self-pay rather than hard-failing.
			return selfPay(key, { account, tx }, publicClient, opts, `sponsored send failed: ${err.message}`);
		}
	}

	return selfPay(key, { account, tx }, publicClient, opts, probe.reason);
}

/**
 * Relay an ALREADY-SIGNED raw transaction through MegaFuel's paymaster
 * `eth_sendRawTransaction`, without touching a private key or building the
 * transaction ourselves. `sendGasless()` above signs internally via a
 * server-held viem Account — the right shape for a demo/ops account (e.g. the
 * anvil-fork proof in the prompt-02 PROGRESS entry), but wrong for a flow
 * where the CLIENT signs (browser wallet or an in-page ephemeral key) and the
 * server only ever sees bytes it can relay, never a key. That's exactly the
 * gasless ERC-8004 registration relay (api/_lib/bnb/erc8004-gasless.js,
 * prompt 03) needs: this is the low-level primitive `sendGasless` doesn't
 * expose.
 *
 * @param {'bscMainnet'|'bscTestnet'|56|97} network
 * @param {`0x${string}`} signedTx  RLP-encoded, fully signed raw transaction hex
 * @param {{ megafuelRpc?:Function, fetchImpl?:Function, timeoutMs?:number }} [opts]
 * @returns {Promise<`0x${string}`>} transaction hash
 */
export async function submitRawTx(network, signedTx, opts = {}) {
	if (typeof signedTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedTx)) {
		throw new MegaFuelError('submitRawTx requires a 0x-prefixed signed raw transaction hex', { code: 'bad_raw_tx' });
	}
	const key = normalizeNetwork(network);
	const call = opts.megafuelRpc
		? (m, p) => opts.megafuelRpc(m, p)
		: (m, p) => rpc(megafuelEndpoint(key), m, p, opts);
	return call('eth_sendRawTransaction', [signedTx]);
}

/** Self-pay path: a normal, gas-paying send via the standard public/wallet client. */
async function selfPay(network, { account, tx }, publicClient, opts, reason) {
	try {
		let walletClient = opts.walletClient;
		if (!walletClient) {
			const { createWalletClient, http } = await import('viem');
			walletClient = createWalletClient({
				account,
				chain: publicClient.chain,
				transport: http(publicClient.bnbRpcs?.[0]),
			});
		}
		const hash = await walletClient.sendTransaction({
			account,
			to: tx.to,
			value: tx.value ?? 0n,
			data: tx.data || '0x',
			gas: tx.gas,
		});
		return { hash, mode: 'self-pay', reason };
	} catch (err) {
		throw new MegaFuelError(`self-pay send failed: ${err.shortMessage || err.message}`, {
			code: 'self_pay_failed',
			mode: 'self-pay',
			cause: err,
		});
	}
}

const BNB_CHAIN_ID = { bscMainnet: 56, bscTestnet: 97 };
