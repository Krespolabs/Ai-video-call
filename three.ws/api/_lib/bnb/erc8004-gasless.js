/**
 * Gasless ERC-8004 agent registration relay for BNB Chain (prompt 03).
 *
 * The campaign's headline demo: a brand-new, zero-balance wallet mints its
 * ERC-8004 on-chain identity from the first click — no faucet, no funding.
 * The client (a browser wallet or an in-page ephemeral key — either way the
 * private key never leaves the browser) signs a *legacy* `register()` /
 * `register(string)` transaction against the Identity Registry and hands us
 * only the raw signed bytes. This module never sees a key, only bytes that
 * are already fully signed — it parses them, decides sponsored vs. self-pay
 * vs. decline, and relays.
 *
 * Two real broadcast paths, chosen by the `gasPrice` already baked into the
 * signature the client sent:
 *
 *  - `gasPrice === 0n` → "gasless attempt". Probe MegaFuel's
 *    `pm_isSponsorable` with the parsed tx; if sponsorable, relay the EXACT
 *    client bytes via MegaFuel's `eth_sendRawTransaction`
 *    (api/_lib/bnb/megafuel.js `submitRawTx`) — the sponsor tx pairs with it
 *    atomically at the block-builder layer. mode: 'sponsored'.
 *    If MegaFuel declines, we do NOT try to self-pay a zero-gasPrice
 *    transaction — every BSC node rejects a gasPrice-underpriced tx outside
 *    the paymaster path, so broadcasting it would just be a guaranteed
 *    revert-before-inclusion. That's mechanically impossible, not a bug. We
 *    return `{ mode: 'declined', reason, hint }` so the caller can show
 *    "you'll pay ~$0.001 gas" and resubmit a *newly signed*, real-gasPrice
 *    transaction — which lands in the branch below.
 *  - `gasPrice > 0n` → "self-pay attempt". The client already re-signed with
 *    real gas (after a decline, or because it knew sponsorship was
 *    unavailable). We broadcast the bytes as-is via the standard public RPC.
 *    mode: 'self-pay'.
 *
 * `sendGasless()` in megafuel.js is deliberately NOT reused here: it signs
 * internally via a server-held viem `Account` (the right shape for a demo/ops
 * account, e.g. the anvil-fork proof in prompt 02's PROGRESS entry) — not
 * this endpoint's "client always signs, server never holds a key" model. This
 * module only ever relays bytes it was handed.
 */

import { parseTransaction, recoverTransactionAddress, keccak256, toBytes, parseAbi } from 'viem';
import { getPublicClient, BNB_CHAINS } from './chains.js';
import { isSponsorable, submitRawTx as megafuelSubmitRawTx } from './megafuel.js';
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from '../../../src/erc8004/abi.js';

/** Typed error for every failure path — `status` maps straight to the HTTP response. */
export class RegisterRelayError extends Error {
	/** @param {string} message @param {{ code?: string, status?: number, cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'RegisterRelayError';
		this.code = info.code || 'bad_request';
		this.status = info.status || 400;
		if (info.cause) this.cause = info.cause;
	}
}

// viem's parseAbi rejects the one `register(string,tuple[])` overload (inline
// anonymous tuple param syntax it doesn't parse) — filtering that single
// signature out (not rewriting any signature text) keeps every other entry
// byte-identical to src/erc8004/abi.js, per the prompt's "do NOT redefine the
// ABI" instruction. Only used for the two read calls below (balanceOf /
// tokenOfOwnerByIndex); event decoding uses raw topic matching instead (see
// api/erc8004/register-confirm.js for the same proven pattern).
const READ_ABI = parseAbi(IDENTITY_REGISTRY_ABI.filter((sig) => !sig.includes('tuple')));

const REGISTERED_TOPIC = keccak256(toBytes('Registered(uint256,string,address)'));
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'));

function normalizeNetwork(network) {
	if (network === 56 || network === '56' || network === 'bsc' || network === 'mainnet' || network === 'bscMainnet') return 'bscMainnet';
	return 'bscTestnet';
}

function registryAddressFor(network) {
	const chainId = BNB_CHAINS[network].id;
	const dep = REGISTRY_DEPLOYMENTS[chainId];
	if (!dep?.identityRegistry) {
		throw new RegisterRelayError(`no ERC-8004 Identity Registry deployment known for chain ${chainId}`, {
			code: 'unknown_registry',
			status: 500,
		});
	}
	return dep.identityRegistry.toLowerCase();
}

/**
 * Whether `address` already holds an agent on `registry`, and its id when
 * resolvable.
 *
 * `balanceOf` is the reliable signal (standard ERC-721, confirmed live
 * against the real BSC testnet Identity Registry 2026-07-08). `tokenId` is a
 * best-effort enrichment: `tokenOfOwnerByIndex` requires ERC721Enumerable
 * storage, and the live testnet deployment declares the function in its ABI
 * but REVERTS on it (confirmed live, same date — no enumerable mapping
 * wired). A registry that doesn't support enumeration must not be treated as
 * "not registered" — that would let a held address slip through into a
 * duplicate mint attempt — so a revert here still reports `registered: true`,
 * just with `agentId: null`.
 *
 * @returns {Promise<{ registered: boolean, agentId: string|null }>}
 */
async function alreadyRegisteredAgentId(publicClient, registry, address) {
	const balance = await publicClient.readContract({
		address: registry,
		abi: READ_ABI,
		functionName: 'balanceOf',
		args: [address],
	});
	if (!balance || balance === 0n) return { registered: false, agentId: null };
	try {
		const tokenId = await publicClient.readContract({
			address: registry,
			abi: READ_ABI,
			functionName: 'tokenOfOwnerByIndex',
			args: [address, 0n],
		});
		return { registered: true, agentId: tokenId.toString() };
	} catch {
		return { registered: true, agentId: null };
	}
}

/**
 * Wait (bounded) for the receipt and pull `agentId` out of the `Registered`
 * (preferred) or `Transfer` (ERC-721 mint fallback) log via raw topic
 * matching — sidesteps ABI-decode ambiguity entirely, same technique already
 * proven in api/erc8004/register-confirm.js. On a revert, best-effort replay
 * the call at the failing block to surface the actual revert reason instead
 * of a bare "reverted".
 */
async function waitAndDecode(publicClient, { hash, registry, from, to, data, value }) {
	let receipt;
	try {
		receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 25_000 });
	} catch (err) {
		// Real BSC block times are sub-second (00-CONTEXT verified fact #3), but a
		// congested public RPC can still miss the window — surface honestly as
		// pending rather than failing outright; the hash is still real and
		// resolvable via any explorer/RPC once it lands.
		return { pending: true, agentId: null, hash };
	}
	if (receipt.status === 'reverted') {
		let reason = 'transaction reverted';
		try {
			await publicClient.call({ account: from, to, data, value: value ?? 0n, blockNumber: receipt.blockNumber });
		} catch (simErr) {
			reason = simErr.shortMessage || simErr.message || reason;
		}
		throw new RegisterRelayError(reason, { code: 'tx_reverted', status: 422 });
	}
	// `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
	// puts agentId at topics[1] — preferred, and what the live registry always
	// emits alongside Transfer on a mint. `Transfer(address indexed from,
	// address indexed to, uint256 indexed tokenId)` puts tokenId at topics[3],
	// NOT topics[1] (that's `from`) — a real mint emits both events in the same
	// receipt with Transfer logged first, so blindly taking the first
	// Registered-or-Transfer match and reading topics[1] silently decodes
	// Transfer's `from` (0x0 on every mint) as the agentId. Caught live against
	// the real BSC testnet registry 2026-07-08 (see PROGRESS.md) — matching
	// each topic layout to its own event is load-bearing, not cosmetic.
	const registeredLog = receipt.logs.find((l) => l.address?.toLowerCase() === registry && l.topics?.[0] === REGISTERED_TOPIC);
	const transferLog = receipt.logs.find((l) => l.address?.toLowerCase() === registry && l.topics?.[0] === TRANSFER_TOPIC);
	const agentId = registeredLog
		? BigInt(registeredLog.topics[1]).toString()
		: transferLog?.topics?.[3]
			? BigInt(transferLog.topics[3]).toString()
			: null;
	return { pending: false, agentId, hash, blockNumber: Number(receipt.blockNumber) };
}

/**
 * Relay a client-signed ERC-8004 `register` transaction, gaslessly when
 * possible. Never signs, never touches a key — only parses and relays bytes
 * it was handed.
 *
 * @param {object} params
 * @param {string} params.signedRegisterTx  0x-prefixed, fully signed legacy raw tx
 * @param {'bscMainnet'|'bscTestnet'|56|97} [params.network]
 * @param {import('viem').PublicClient} [params.publicClient]  injectable for tests
 * @param {object} [params.megafuelOpts]  forwarded to isSponsorable/submitRawTx (tests)
 * @returns {Promise<object>}
 */
export async function relayGaslessRegistration({ signedRegisterTx, network, publicClient: injectedClient, megafuelOpts = {} }) {
	if (typeof signedRegisterTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedRegisterTx)) {
		throw new RegisterRelayError('signedRegisterTx must be a 0x-prefixed signed raw transaction hex', { code: 'bad_tx' });
	}
	const net = normalizeNetwork(network);
	const registry = registryAddressFor(net);

	let parsed;
	try {
		parsed = parseTransaction(signedRegisterTx);
	} catch (err) {
		throw new RegisterRelayError('could not parse the signed transaction', { code: 'bad_tx', cause: err });
	}
	if (!parsed.to || parsed.to.toLowerCase() !== registry) {
		throw new RegisterRelayError(`transaction must call the ERC-8004 Identity Registry (${registry}) on ${net}`, { code: 'wrong_target' });
	}
	if (parsed.type !== 'legacy') {
		throw new RegisterRelayError('sign a legacy (type 0) transaction — MegaFuel gasless relies on gasPrice, not EIP-1559 fee fields', {
			code: 'bad_tx_type',
		});
	}

	let from;
	try {
		from = await recoverTransactionAddress({ serializedTransaction: signedRegisterTx });
	} catch (err) {
		throw new RegisterRelayError('could not recover a valid signature from the transaction', { code: 'bad_signature', cause: err });
	}

	const publicClient = injectedClient || getPublicClient(net);

	// Never double-mint — an address that already owns an agent gets its
	// existing agentId back (when resolvable) instead of a broadcast attempt.
	// A failed *read* (RPC hiccup) must not block a legitimate first mint, so
	// only a successful `registered: true` short-circuits.
	const existing = await alreadyRegisteredAgentId(publicClient, registry, from).catch(() => ({ registered: false, agentId: null }));
	if (existing.registered) {
		return { alreadyRegistered: true, agentId: existing.agentId, address: from, network: net };
	}

	const gasPrice = parsed.gasPrice ?? 0n;
	const value = parsed.value ?? 0n;

	if (gasPrice === 0n) {
		const probe = await isSponsorable(net, { to: parsed.to, from, value, gas: parsed.gas, data: parsed.data }, megafuelOpts);
		if (!probe.sponsorable) {
			return {
				mode: 'declined',
				reason: probe.reason,
				address: from,
				network: net,
				hint: 'MegaFuel declined to sponsor this address right now — fund it with a small amount of tBNB (~0.001) and resubmit a transaction signed with a real gasPrice to self-pay.',
			};
		}
		let hash;
		try {
			const submit = megafuelOpts.submitRawTx || megafuelSubmitRawTx;
			hash = await submit(net, signedRegisterTx, megafuelOpts);
		} catch (err) {
			throw new RegisterRelayError(`MegaFuel accepted the sponsorship probe but the sponsored send failed: ${err.message}`, {
				code: 'sponsored_send_failed',
				status: 502,
				cause: err,
			});
		}
		const decoded = await waitAndDecode(publicClient, { hash, registry, from, to: parsed.to, data: parsed.data, value });
		return { mode: 'sponsored', address: from, network: net, sponsor: probe.sponsorInfo, ...decoded };
	}

	// Self-pay: the caller already re-signed with real gas — broadcast as-is.
	let hash;
	try {
		hash = await publicClient.sendRawTransaction({ serializedTransaction: signedRegisterTx });
	} catch (err) {
		const msg = err.shortMessage || err.message || String(err);
		const code = /insufficient funds/i.test(msg) ? 'insufficient_funds' : /nonce/i.test(msg) ? 'bad_nonce' : /already known|replacement/i.test(msg) ? 'duplicate_tx' : 'broadcast_failed';
		throw new RegisterRelayError(msg, { code, status: 400, cause: err });
	}
	const decoded = await waitAndDecode(publicClient, { hash, registry, from, to: parsed.to, data: parsed.data, value });
	return { mode: 'self-pay', address: from, network: net, ...decoded };
}
