// @ts-check
// Request-body contracts for the agent-signed creator-fee endpoints
// (/api/pump/collect-creator-fee-agent and /api/pump/distribute-creator-fees-agent).
//
// They live here, not inline in api/pump/[action].js, so every internal caller
// can be tested against the exact schema the handler parses. The launcher
// claimer once posted `{ agentId }` to an endpoint that only knows `agent_id`,
// and every automatic claim failed validation for months because its test
// mocked fetch with a stub that accepted any body.

import { z } from 'zod';

export const collectFeeAgentSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		mint: z.string().min(32).max(44),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		all_quotes: z.boolean().default(false),
	})
	.refine((b) => b.agent_id || b.avatar_id, { message: 'agent_id or avatar_id required' });
