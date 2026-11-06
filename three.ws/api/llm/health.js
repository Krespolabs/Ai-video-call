// @ts-check
// GET /api/llm/health — gated, real-time status of every configured paid LLM
// provider (OpenRouter primary, Anthropic, OpenAI). The free-first chain in
// _lib/llm.js degrades silently, so a dead paid provider is invisible to users
// until quality drops; this surfaces it for the hourly cron and on-call checks.
//
// Auth: a valid cron secret, presented EITHER as `X-Cron-Secret: <secret>` (the
// header an operator or external monitor sends) OR as `Authorization: Bearer
// <secret>` (the header Vercel Cron sends on the scheduled invocation). Anything
// else gets 403 with no provider names or error detail — those reveal which key
// is bad and may carry account/quota specifics, so they stay behind the gate.
//
// On 'degraded'/'down' it pages the ops Telegram channel (see _lib/alerts.js),
// deduped per failing-provider signature so a sustained outage alerts once.

import { json, error, method, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { probeLlmHealth } from '../_lib/llm-health.js';

function authorized(req, secret) {
	const headerSecret = req.headers['x-cron-secret'];
	if (headerSecret && constantTimeEquals(headerSecret, secret)) return true;
	const auth = req.headers['authorization'] || '';
	const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (bearer && constantTimeEquals(bearer, secret)) return true;
	return false;
}

export default wrap(async (req, res) => {
	if (!method(req, res, ['GET'])) return;

	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) return error(res, 503, 'not_configured', 'CRON_SECRET is not set on this deployment');
	if (!authorized(req, secret)) return error(res, 403, 'forbidden', 'a valid cron secret is required');

	const health = await probeLlmHealth();

	if (health.overall === 'degraded' || health.overall === 'down') {
		const failing = Object.entries(health)
			.filter(([k, v]) => k !== 'overall' && v?.status === 'error')
			.map(([k, v]) => `${k}: ${v.error}`);
		sendOpsAlert(`LLM providers ${health.overall.toUpperCase()}`, failing.join('\n') || 'no providers passed', {
			signature: `llm-health:${health.overall}:${failing.join(',')}`,
		});
	}

	return json(res, 200, health);
});
