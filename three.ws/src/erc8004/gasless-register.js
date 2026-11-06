/**
 * Client-side driver for gas-free ERC-8004 registration on BNB Chain
 * (docs/erc8004.md "Gasless agent registration on BNB", api/bnb/register-agent.js).
 *
 * The whole point: a wallet holding ZERO tBNB mints its on-chain agent
 * identity from the first click, sponsored by MegaFuel's BEP-414 paymaster —
 * no faucet, no funding. This module generates a fresh, page-local ephemeral
 * BSC account (a plain viem local account — its private key never leaves the
 * browser and is never sent anywhere; only fully signed transaction bytes
 * are) and signs a legacy `register(string)` call against the ERC-8004
 * Identity Registry with `gasPrice: 0`, then hands the raw bytes to the
 * server relay. If MegaFuel declines sponsorship, `registerAgentSelfPayRetry`
 * re-signs the same call with a real gasPrice and resubmits — that only
 * succeeds once the ephemeral wallet has been funded, so the caller should
 * show the decline response's `hint` + the wallet address before retrying.
 */

import { createPublicClient, http, encodeFunctionData, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { REGISTRY_DEPLOYMENTS } from './abi.js';
import { CHAIN_META } from './chain-meta.js';

const STORAGE_KEY = '3dagent:bnb-gasless-key';
export const BSC_TESTNET_CHAIN_ID = 97;

const REGISTER_ABI = parseAbi(['function register(string agentURI) external returns (uint256 agentId)']);

function loadOrCreateEphemeralKey() {
	try {
		const existing = sessionStorage.getItem(STORAGE_KEY);
		if (existing) return existing;
	} catch {
		/* private mode / storage disabled — key still generated, just not persisted */
	}
	const key = generatePrivateKey();
	try {
		sessionStorage.setItem(STORAGE_KEY, key);
	} catch {
		/* private mode — the key survives for this call only; a reload mid-flow
		 * starts a fresh (also zero-balance) wallet, which is still a valid demo. */
	}
	return key;
}

/**
 * The ephemeral demo wallet for this browser tab/session — the "zero-balance
 * wallet" actor. Persisted in sessionStorage only (never sent to the server,
 * never written to localStorage) so a reload during a fund-and-retry flow
 * doesn't orphan a freshly funded address.
 */
export function getEphemeralAccount() {
	return privateKeyToAccount(loadOrCreateEphemeralKey());
}

/** Drop the ephemeral demo wallet — e.g. after a successful mint, or "start over". */
export function resetEphemeralAccount() {
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		/* private mode */
	}
}

function publicClientFor(chainId) {
	const meta = CHAIN_META[chainId];
	if (!meta) throw new Error(`no chain metadata for chainId ${chainId}`);
	return createPublicClient({
		chain: { id: chainId, name: meta.name, nativeCurrency: meta.currency, rpcUrls: { default: { http: [meta.rpcUrl] } } },
		transport: http(meta.rpcUrl),
	});
}

async function signRegisterTx({ agentURI, gasPrice, chainId }) {
	const account = getEphemeralAccount();
	const registry = REGISTRY_DEPLOYMENTS[chainId]?.identityRegistry;
	if (!registry) throw new Error(`no ERC-8004 Identity Registry known for chain ${chainId}`);
	const client = publicClientFor(chainId);
	const data = encodeFunctionData({ abi: REGISTER_ABI, functionName: 'register', args: [agentURI || ''] });
	const [nonce, gas] = await Promise.all([
		client.getTransactionCount({ address: account.address }),
		client.estimateGas({ account, to: registry, data }).catch(() => 350000n),
	]);
	const signedRegisterTx = await account.signTransaction({ to: registry, data, gasPrice, gas, nonce, chainId, type: 'legacy' });
	return { signedRegisterTx, address: account.address };
}

async function relay(signedRegisterTx, network) {
	const res = await fetch('/api/bnb/register-agent', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ signedRegisterTx, network }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(body.error_description || body.error || `register-agent returned ${res.status}`);
	}
	return body;
}

/**
 * First attempt: sign with gasPrice:0 and relay through MegaFuel. Resolves to
 * the endpoint's response verbatim — branch on `mode` ('sponsored') /
 * `alreadyRegistered` / `mode === 'declined'`.
 *
 * @param {{ agentURI?: string, chainId?: number, network?: string }} [opts]
 */
export async function registerAgentGaslessAttempt({ agentURI = '', chainId = BSC_TESTNET_CHAIN_ID, network = 'bscTestnet' } = {}) {
	const { signedRegisterTx, address } = await signRegisterTx({ agentURI, gasPrice: 0n, chainId });
	const result = await relay(signedRegisterTx, network);
	return { ...result, walletAddress: address };
}

/**
 * Self-pay retry after a decline — fetches the live gas price, re-signs the
 * same call with real gas, and relays as a normal (non-sponsored) broadcast.
 * Only succeeds once the ephemeral wallet holds enough tBNB to cover it.
 */
export async function registerAgentSelfPayRetry({ agentURI = '', chainId = BSC_TESTNET_CHAIN_ID, network = 'bscTestnet' } = {}) {
	const client = publicClientFor(chainId);
	const liveGasPrice = await client.getGasPrice();
	const { signedRegisterTx, address } = await signRegisterTx({
		agentURI,
		gasPrice: liveGasPrice > 0n ? liveGasPrice : 1_000_000_000n,
		chainId,
	});
	const result = await relay(signedRegisterTx, network);
	return { ...result, walletAddress: address };
}
