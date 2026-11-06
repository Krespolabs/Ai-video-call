// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.
//
// A2A (Agent-to-Agent) x402 client helpers.
//
// Drives the two-leg A2A x402 handshake described at
//   https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1/spec.md
//
// Other agents in this workspace import these to call a paid A2A skill on a
// peer agent without re-implementing the JSON-RPC + EIP-3009 signing dance.
//
// Usage:
//   import { payA2A, createPrivateKeySigner } from "@pump-fun/agent-payments-sdk/a2a";
//
//   const signer = await createPrivateKeySigner(process.env.AGENT_PRIVATE_KEY!);
//   const result = await payA2A({
//     endpoint: "https://three.ws/api/agents/a2a-paid",
//     signer,
//     text: "Inspect https://example.com/model.glb",
//   });
//   console.log(result.task.artifacts);

import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export const A2A_X402_EXTENSION_URI =
  "https://github.com/google-a2a/a2a-x402/v0.1";
export const A2A_EXTENSIONS_HEADER = "X-A2A-Extensions";

// ── Errors ────────────────────────────────────────────────────────────────

export class A2AClientError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "A2AClientError";
    this.code = code;
    this.details = details;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface A2ASigner {
  address: Address;
  signAuthorization(args: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    message: {
      from: Address;
      to: Address;
      value: string;
      validAfter: number;
      validBefore: number;
      nonce: Hex;
    };
  }): Promise<Hex>;
}

export interface A2APaymentRequirementsAccept {
  scheme: string;
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds?: number;
  extra?: {
    name?: string;
    version?: string;
    decimals?: number;
    [key: string]: unknown;
  };
}

export interface A2APaymentRequirements {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: A2APaymentRequirementsAccept[];
}

export interface A2APaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  resource: { url: string; mimeType?: string; description?: string };
  accepted: A2APaymentRequirementsAccept;
  payload: {
    signature: Hex;
    authorization: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  };
  extensions?: Record<string, unknown>;
}

export interface A2ATaskMessagePart {
  kind: "text" | "data" | "image" | "file";
  text?: string;
  data?: unknown;
  name?: string;
  mimeType?: string;
}

export interface A2ATaskMessage {
  kind: "message";
  role: "agent" | "user";
  messageId?: string;
  taskId?: string;
  parts: A2ATaskMessagePart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  kind: "task";
  id: string;
  status: { state: string; message?: A2ATaskMessage };
  artifacts?: Array<{
    artifactId?: string;
    name?: string;
    description?: string;
    parts?: A2ATaskMessagePart[];
    mimeType?: string;
    data?: unknown;
  }>;
}

export interface A2APaymentResult {
  task: A2ATask;
  state: string;
  status: string | null;
  receipts: Array<{
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string | null;
    errorReason?: string;
  }>;
  error: string | null;
  lifecycle: string[] | null;
}

// ── Signers ───────────────────────────────────────────────────────────────

export async function createPrivateKeySigner(privateKey: string): Promise<A2ASigner> {
  if (!privateKey || typeof privateKey !== "string") {
    throw new A2AClientError(
      "invalid_signer",
      "createPrivateKeySigner: hex string required",
    );
  }
  const account = privateKeyToAccount(
    privateKey.startsWith("0x") ? (privateKey as Hex) : (`0x${privateKey}` as Hex),
  );
  return {
    address: account.address,
    signAuthorization: async ({ domain, message }) =>
      account.signTypedData({
        domain,
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: message.from,
          to: message.to,
          value: BigInt(message.value),
          validAfter: BigInt(message.validAfter),
          validBefore: BigInt(message.validBefore),
          nonce: message.nonce,
        },
      }),
  };
}

// ── Payload helpers ───────────────────────────────────────────────────────

const CHAIN_ID_BY_NETWORK: Record<string, number> = {
  "eip155:8453": 8453,
  "eip155:84532": 84532,
  "eip155:1": 1,
  "eip155:137": 137,
  "eip155:42161": 42161,
};

function chainIdFor(network: string): number {
  if (CHAIN_ID_BY_NETWORK[network]) return CHAIN_ID_BY_NETWORK[network];
  const m = /^eip155:(\d+)$/.exec(network);
  if (m && m[1]) return Number(m[1]);
  throw new A2AClientError(
    "unsupported_network",
    `a2a-helpers: cannot derive chainId from ${network}`,
  );
}

function randomHex32(): Hex {
  // 32 bytes of randomness as 0x-prefixed hex. crypto.getRandomValues is
  // available in Node 18+ and every modern runtime.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

export async function buildEvmExactPayload(args: {
  accept: A2APaymentRequirementsAccept;
  signer: A2ASigner;
  resource: { url: string; mimeType?: string; description?: string };
}): Promise<A2APaymentPayload> {
  const { accept, signer, resource } = args;
  if (accept.scheme !== "exact") {
    throw new A2AClientError(
      "unsupported_scheme",
      `a2a-helpers: only exact scheme supported, got ${accept.scheme}`,
    );
  }
  const chainId = chainIdFor(accept.network);
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + (accept.maxTimeoutSeconds || 600);
  const nonce = randomHex32();
  const domain = {
    name: accept.extra?.name || "USD Coin",
    version: accept.extra?.version || "2",
    chainId,
    verifyingContract: accept.asset,
  };
  const message = {
    from: signer.address,
    to: accept.payTo,
    value: accept.amount,
    validAfter,
    validBefore,
    nonce,
  };
  const signature = await signer.signAuthorization({ domain, message });
  return {
    x402Version: 2,
    scheme: "exact",
    network: accept.network,
    resource,
    accepted: accept,
    payload: {
      signature,
      authorization: {
        from: signer.address,
        to: accept.payTo,
        value: accept.amount,
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
}

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────

function jsonRpcRequest(message: A2ATaskMessage) {
  const id =
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "message/send" as const,
    params: { message },
  };
}

async function postJsonRpc(endpoint: string, body: unknown): Promise<A2ATask> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [A2A_EXTENSIONS_HEADER]: A2A_X402_EXTENSION_URI,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: { result?: A2ATask; error?: { code: number; message: string; data?: unknown } };
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new A2AClientError(
      "parse_error",
      `non-JSON A2A reply: ${(err as Error).message}`,
      { text },
    );
  }
  if (!res.ok) {
    throw new A2AClientError("transport_error", `HTTP ${res.status}`, {
      status: res.status,
      body: parsed,
    });
  }
  if (parsed.error) {
    throw new A2AClientError(
      "jsonrpc_error",
      parsed.error.message || "JSON-RPC error",
      parsed.error,
    );
  }
  if (!parsed.result || parsed.result.kind !== "task") {
    throw new A2AClientError("invalid_reply", "expected `kind: task` in A2A reply", parsed.result);
  }
  return parsed.result;
}

function readPaymentRequired(task: A2ATask): A2APaymentRequirements | null {
  const meta = task.status?.message?.metadata as Record<string, unknown> | undefined;
  if (!meta || meta["x402.payment.status"] !== "payment-required") return null;
  const required = meta["x402.payment.required"];
  if (
    !required ||
    typeof required !== "object" ||
    !Array.isArray((required as A2APaymentRequirements).accepts)
  ) {
    throw new A2AClientError(
      "malformed_payment_required",
      "task carries payment-required status but no accepts list",
      required,
    );
  }
  return required as A2APaymentRequirements;
}

function readReceiptInfo(task: A2ATask) {
  const meta = (task.status?.message?.metadata || {}) as Record<string, unknown>;
  return {
    status: (meta["x402.payment.status"] as string) || null,
    receipts: Array.isArray(meta["x402.payment.receipts"])
      ? (meta["x402.payment.receipts"] as A2APaymentResult["receipts"])
      : [],
    error: (meta["x402.payment.error"] as string) || null,
    lifecycle: Array.isArray(meta["x402.payment.lifecycle"])
      ? (meta["x402.payment.lifecycle"] as string[])
      : null,
  };
}

const DEFAULT_NETWORK_PREFERENCE = ["eip155:8453", "eip155:84532", "eip155:1"];

function pickAccept(
  accepts: A2APaymentRequirementsAccept[],
  preference?: string[],
): A2APaymentRequirementsAccept {
  const order = preference?.length ? preference : DEFAULT_NETWORK_PREFERENCE;
  for (const net of order) {
    const match = accepts.find((a) => a.network === net && a.scheme === "exact");
    if (match) return match;
  }
  for (const a of accepts) {
    if (a.scheme === "exact" && /^eip155:\d+$/.test(a.network)) return a;
  }
  throw new A2AClientError(
    "no_supported_accept",
    "a2a-helpers: peer offered no supported (scheme=exact, EVM) accept",
    { accepts: accepts.map(({ network, scheme }) => ({ network, scheme })) },
  );
}

// ── Public API ────────────────────────────────────────────────────────────

export async function requestA2AQuote(args: {
  endpoint: string;
  text?: string;
  taskId?: string;
}): Promise<{ task: A2ATask; required: A2APaymentRequirements; taskId: string }> {
  const message: A2ATaskMessage = {
    kind: "message",
    role: "user",
    messageId: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined,
    ...(args.taskId ? { taskId: args.taskId } : {}),
    parts: [{ kind: "text", text: args.text || "Initiate paid skill." }],
  };
  const task = await postJsonRpc(args.endpoint, jsonRpcRequest(message));
  const required = readPaymentRequired(task);
  if (!required) {
    throw new A2AClientError(
      "unexpected_state",
      `expected payment-required, got state ${task.status?.state || "unknown"}`,
      { task },
    );
  }
  return { task, required, taskId: task.id };
}

export async function submitA2APayment(args: {
  endpoint: string;
  taskId: string;
  paymentPayload: A2APaymentPayload;
  text?: string;
}): Promise<A2APaymentResult> {
  const message: A2ATaskMessage = {
    kind: "message",
    role: "user",
    messageId: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined,
    taskId: args.taskId,
    parts: [{ kind: "text", text: args.text || "Here is the payment authorization." }],
    metadata: {
      "x402.payment.status": "payment-submitted",
      "x402.payment.payload": args.paymentPayload,
    },
  };
  const task = await postJsonRpc(args.endpoint, jsonRpcRequest(message));
  const receipt = readReceiptInfo(task);
  return {
    task,
    state: task.status?.state || "unknown",
    ...receipt,
  };
}

export interface PayA2AOptions {
  endpoint: string;
  signer: A2ASigner;
  text?: string;
  networkPreference?: string[];
  onQuote?: (args: {
    task: A2ATask;
    required: A2APaymentRequirements;
    taskId: string;
  }) => void | Promise<void>;
}

export async function payA2A(opts: PayA2AOptions): Promise<A2APaymentResult> {
  if (!opts.endpoint) {
    throw new A2AClientError("invalid_args", "payA2A: endpoint required");
  }
  if (!opts.signer || typeof opts.signer.signAuthorization !== "function") {
    throw new A2AClientError(
      "invalid_signer",
      "payA2A: signer with signAuthorization() required",
    );
  }

  const quote = await requestA2AQuote({ endpoint: opts.endpoint, text: opts.text });
  if (opts.onQuote) await opts.onQuote(quote);

  const accept = pickAccept(quote.required.accepts, opts.networkPreference);
  const resource = quote.required.resource || {
    url: opts.endpoint,
    mimeType: "application/json",
  };
  const paymentPayload = await buildEvmExactPayload({ accept, signer: opts.signer, resource });

  const result = await submitA2APayment({
    endpoint: opts.endpoint,
    taskId: quote.taskId,
    paymentPayload,
  });

  if (result.state !== "completed") {
    throw new A2AClientError(
      result.error || "payment_failed",
      result.receipts[0]?.errorReason || `A2A task ended in state ${result.state}`,
      result,
    );
  }
  return result;
}
