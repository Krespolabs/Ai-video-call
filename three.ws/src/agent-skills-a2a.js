/**
 * Agent-to-Agent payment skill
 * ----------------------------
 * Lets an agent autonomously discover, pay, and call a peer agent's paid A2A
 * skill — under a signed Intent Mandate the user issued ahead of time. The
 * payment is not invisible JSON: it flows through the protocol bus as
 * PAY_INTENT → PAY_SETTLED / PAY_FAILED so the avatar performs it. On success
 * the agent celebrates and speaks the result; on failure it shows concern and
 * explains what went wrong.
 *
 * Backend: POST /api/agents/a2a-call enforces the mandate, budget ledger, and
 * (optionally) the peer's ERC-8004 reputation before any USDC moves.
 */

import { ACTION_TYPES } from './agent-protocol.js';

// USDC and the other supported stablecoins are 6-decimal — render atomic units
// as a human dollar amount for speech and logging.
function formatAtomicUsd(atomics) {
	const n = Number(atomics);
	if (!Number.isFinite(n)) return String(atomics);
	return `$${(n / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function registerA2APaymentSkills(skills) {
	skills.register({
		name: 'pay-agent',
		description:
			'Pay and call another agent’s paid skill over the A2A x402 protocol, under an Intent Mandate',
		instruction:
			'Discover the peer’s price, pay it under the active mandate if within budget and the peer is trusted, then return the result. Show the payment happening.',
		animationHint: 'present',
		voicePattern: 'Paying {{endpoint}} for that skill…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			required: ['endpoint', 'mandate'],
			properties: {
				endpoint: { type: 'string', description: 'Peer agent A2A endpoint URL' },
				mandate: { type: 'string', description: 'Signed Intent Mandate (compact JWS)' },
				text: { type: 'string', description: 'Message / task to send the peer' },
				network: { type: 'string', description: 'Preferred settlement network (CAIP-2)' },
				reputationAgentId: { type: 'string', description: 'Peer on-chain agentId for reputation gating' },
				reputationChainId: { type: 'number', description: 'Chain to read reputation on' },
				minAverage: { type: 'number', description: 'Minimum acceptable peer reputation average' },
				minCount: { type: 'number', description: 'Minimum acceptable peer review count' },
			},
		},
		handler: async (args, ctx) => {
			const { endpoint, mandate, text } = args;
			if (!endpoint || !mandate) {
				return {
					success: false,
					output: 'I need both a peer endpoint and a signed mandate to pay another agent.',
					sentiment: -0.3,
				};
			}

			const agentId = ctx.identity?.id || 'default';

			// Announce intent — the avatar can lean toward the payee and gesture.
			if (ctx.isBrowser) {
				ctx.protocol.emit({
					type: ACTION_TYPES.PAY_INTENT,
					payload: { endpoint },
					agentId,
				});
			}

			const reputation =
				args.reputationAgentId !== undefined
					? {
							agentId: args.reputationAgentId,
							chainId: args.reputationChainId,
							minAverage: args.minAverage,
							minCount: args.minCount,
						}
					: undefined;

			let res, data;
			try {
				res = await fetch('/api/agents/a2a-call', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({
						endpoint,
						mandate,
						text: text || 'Initiate paid skill.',
						networkPreference: args.network ? [args.network] : undefined,
						reputation,
					}),
				});
				data = await res.json();
			} catch (err) {
				if (ctx.isBrowser) {
					ctx.protocol.emit({ type: ACTION_TYPES.PAY_FAILED, payload: { endpoint, error: err.message }, agentId });
					ctx.protocol.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger: 'concern', weight: 0.8 }, agentId });
				}
				return { success: false, output: `I couldn’t reach the payment service: ${err.message}`, sentiment: -0.5 };
			}

			if (!res.ok || !data?.ok) {
				const reason = data?.error_description || data?.error || `HTTP ${res.status}`;
				if (ctx.isBrowser) {
					ctx.protocol.emit({ type: ACTION_TYPES.PAY_FAILED, payload: { endpoint, error: reason, code: data?.error }, agentId });
					ctx.protocol.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger: 'concern', weight: 0.8 }, agentId });
				}
				return { success: false, output: `Payment didn’t go through: ${reason}`, sentiment: -0.5, data };
			}

			const tx = data.receipts?.[0]?.transaction || null;
			if (ctx.isBrowser) {
				ctx.protocol.emit({
					type: ACTION_TYPES.PAY_SETTLED,
					payload: {
						endpoint,
						amount: data.amount,
						network: data.network,
						currency: data.currency,
						payer: data.payer,
						transaction: tx,
						mandateId: data.mandate_id,
						artifacts: data.artifacts || [],
					},
					agentId,
				});
				// Settlement is a win — perform it.
				ctx.protocol.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger: 'celebrate', weight: 0.9 }, agentId });
			}

			const amountUsd = formatAtomicUsd(data.amount);
			const artifactNote = data.artifacts?.length
				? ` I received ${data.artifacts.length} artifact${data.artifacts.length === 1 ? '' : 's'} back.`
				: '';
			return {
				success: true,
				output: `Paid ${amountUsd} on ${data.network} and called the peer skill.${artifactNote}`,
				sentiment: 0.7,
				data,
			};
		},
	});
}
