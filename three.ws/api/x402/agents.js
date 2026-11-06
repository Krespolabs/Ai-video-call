// A whole agent, sold as a paid x402 API.
//
//   POST /api/x402/agents/<agentId>    { "message": "...", "history": [] }
//        -> 402 with the price the owner set, payTo = the agent's own Solana
//           payout wallet (USDC on Solana first); pay and retry with the
//           payment header -> { "reply", "model", "usage", "agent_id" }
//   GET  /api/x402/agents               free JSON list of every agent on sale
//
// The owner turns this on from the agent wallet's Earn tab (stored as
// meta.api_service, validated by PUT /api/agents/:id/api-service). The agent id
// arrives as ?agent=<id> through the vercel.json rewrite. Only public agents
// whose embed policy leaves them a brain and that have a Solana payout address
// can be sold; everything else 404s before any challenge is issued.
//
// Default paidEndpoint mode runs the turn BEFORE settlement, so a turn that
// fails (every LLM provider down, a provider error) answers 502/503 and the
// buyer is never charged. The body is parsed and bounded before the payment is
// verified, so a malformed call never reaches the facilitator either.

import { cors, error, json, readBody, respondError } from '../_lib/http.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema, NETWORK_SOLANA_MAINNET } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { isUuid } from '../_lib/validate.js';
import { runAgentTurn } from '../_lib/agent-turn.js';
import {
	AgentServiceError,
	BODY_MAX_BYTES,
	CALL_INPUT_EXAMPLE,
	CALL_INPUT_SCHEMA,
	CALL_OUTPUT_EXAMPLE,
	CALL_OUTPUT_SCHEMA,
	agentServiceUrl,
	listActiveAgentServices,
	loadServiceAgent,
	parseCallBody,
	readServiceConfig,
	recordAgentApiSale,
	resolveServicePayTo,
	sellability,
	serviceNameFor,
	usdToAtomics,
} from '../_lib/agent-api-service.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: CALL_INPUT_EXAMPLE },
		output: { type: 'json', example: CALL_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: CALL_INPUT_SCHEMA,
		outputSchema: CALL_OUTPUT_SCHEMA,
	}),
};

function agentRefFromReq(req) {
	const fromQuery = req.query?.agent;
	if (fromQuery) return String(Array.isArray(fromQuery) ? fromQuery[0] : fromQuery);
	const url = new URL(req.url, 'http://x');
	const q = url.searchParams.get('agent');
	if (q) return q;
	const m = url.pathname.match(/\/api\/x402\/agents\/([^/?]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

async function listServices(req, res) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.setHeader('allow', 'GET,HEAD,OPTIONS');
		return error(res, 405, 'method_not_allowed', 'GET lists agents on sale; POST to /api/x402/agents/<agentId> to call one');
	}
	let services;
	try {
		services = await listActiveAgentServices({ limit: 200 });
	} catch (err) {
		return respondError(res, 502, 'catalog_unavailable', err);
	}
	return json(
		res,
		200,
		{
			count: services.length,
			input_schema: CALL_INPUT_SCHEMA,
			output_schema: CALL_OUTPUT_SCHEMA,
			services,
		},
		{ 'cache-control': 'public, max-age=60, stale-while-revalidate=300' },
	);
}

export default async function handler(req, res) {
	// paidEndpoint answers CORS itself, but the not-found / inactive branches
	// below respond before one is built, and a payment header always triggers a
	// preflight, so answer it here too.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const ref = agentRefFromReq(req);
	if (!ref) return listServices(req, res);
	if (!isUuid(ref)) return error(res, 404, 'agent_not_found', 'no agent with that id');

	let agent;
	let payTo;
	try {
		agent = await loadServiceAgent(ref);
		payTo = agent ? await resolveServicePayTo(agent.id) : null;
	} catch (err) {
		return respondError(res, 502, 'agent_lookup_failed', err);
	}
	if (!agent) return error(res, 404, 'agent_not_found', 'no agent with that id');

	const config = readServiceConfig(agent);
	if (!config.active || !config.price_usd) {
		return error(res, 404, 'service_inactive', 'this agent is not sold as an API; its owner can turn it on from the Earn tab');
	}
	const sell = sellability(agent, { solanaPayTo: payTo.solana });
	if (!sell.ok) {
		return error(res, 404, 'service_unavailable', sell.reasons[0], { reasons: sell.reasons });
	}

	// Bound and validate the body before the payment is ever verified, and only
	// when a payment is attached: an unpaid probe gets the 402 challenge (which
	// carries the input schema) whatever it sent.
	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);
	let call = null;
	if (paymentPresent && req.method === 'POST') {
		try {
			call = parseCallBody(await readBody(req, BODY_MAX_BYTES + 1));
		} catch (err) {
			if (err instanceof AgentServiceError) return error(res, err.status, err.code, err.message);
			if (err?.status === 413) return error(res, 413, 'payload_too_large', `body must be at most ${BODY_MAX_BYTES} bytes`);
			throw err;
		}
		// Hand the parsed body back to anything downstream that reads it again
		// (readJson / readBody reconstruct from req.body once the stream is drained).
		req.body = call;
	}

	const override = { solana: payTo.solana };
	const networks = ['solana'];
	if (payTo.base && EVM_ADDRESS.test(payTo.base)) {
		override.base = payTo.base;
		networks.push('base');
	}

	const priceAtomics = usdToAtomics(config.price_usd);
	const route = `/api/x402/agents/${agent.id}`;
	const inner = paidEndpoint({
		route,
		method: 'POST',
		priceAtomics,
		networks,
		payTo: override,
		// The $THREE accept is a fixed env amount; an owner-set price varies per
		// agent, so a token accept would sell every agent at one flat price.
		acceptThree: false,
		description: `${config.description} (one turn with ${agent.name} on three.ws)`.slice(0, 500),
		mimeType: 'application/json',
		bazaar: BAZAAR,
		service: withService({
			serviceName: serviceNameFor(agent),
			tags: ['agent', 'chat', 'pay-per-call', 'solana'],
		}),
		resourceUrlBuilder: () => agentServiceUrl(agent.id),
		// Revenue lands on the agent's own ledger, net of PLATFORM_FEE_BPS, once
		// the buyer's payment has settled. Fire-and-forget by contract.
		onSettled: ({ payer, network, txHash, amountAtomics, asset }) =>
			recordAgentApiSale({ agent, payer, network, txHash, amountAtomics: amountAtomics ?? priceAtomics, asset }),
		async handler({ payer, requirement }) {
			const turn = await runAgentTurn({
				agent,
				message: call.message,
				history: call.history,
				// Patronage keys on a Solana wallet; a Base payer has none here.
				callerWallet: requirement?.network === NETWORK_SOLANA_MAINNET ? payer || null : null,
				tool: 'agent.api',
			});
			return { reply: turn.text, model: turn.model, usage: turn.usage, agent_id: agent.id };
		},
	});
	return inner(req, res);
}
