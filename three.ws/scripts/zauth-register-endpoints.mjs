// Sweep every paid x402 surface on production so the zauth Provider Hub SDK
// observes — and auto-registers — each endpoint.
//
//   node scripts/zauth-register-endpoints.mjs [--base https://three.ws]
//
// How it works: the deployed @zauthx402/sdk middleware (api/_lib/zauth.js)
// reports every monitored request to the Provider Hub, and zauth registers
// endpoints from observed traffic ("Auto-registered via SDK"). A request with
// no X-PAYMENT header costs nothing — paid routes answer with a 402 challenge
// that also carries pricing for the registry. So one unauthenticated request
// per route is enough to take the Provider Hub from one endpoint to the full
// catalog.
//
// After the sweep, the script polls zauth's public directory API and prints
// every registered three.ws endpoint so the result is verifiable from here.

const BASE = (() => {
	const i = process.argv.indexOf('--base');
	return (i >= 0 && process.argv[i + 1]) || process.env.THREE_WS_BASE || 'https://three.ws';
})();
const DIRECTORY_API = 'https://api.zauth.inc/api/directory';
const MCP_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

// Static catalog of paid surfaces. Methods mirror each route's paidEndpoint()
// spec / handler. Dynamic routes (/api/x402/service/<slug>, per-agent x402
// actions) register themselves as real traffic flows — they have no static
// path to sweep.
const ENDPOINTS = [
	// MCP servers (Streamable HTTP, JSON-RPC) — each settles x402 payments.
	{ path: '/api/mcp', method: 'POST', body: MCP_BODY, json: true },
	{ path: '/api/mcp-3d', method: 'POST', body: MCP_BODY, json: true },
	{ path: '/api/mcp-agent', method: 'POST', body: MCP_BODY, json: true },
	{ path: '/api/mcp-bazaar', method: 'POST', body: MCP_BODY, json: true },
	// pump-fun-mcp: tools/list is free by design — only a gated tools/call
	// draws the 402 that carries pricing for the registry.
	{
		path: '/api/pump-fun-mcp',
		method: 'POST',
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'pumpfun_vanity_mint', arguments: {} },
		}),
		json: true,
	},
	{ path: '/api/ibm-mcp', method: 'POST', body: MCP_BODY, json: true },
	// Worker dispatcher x402 surface.
	{ path: '/api/wk-x402', method: 'GET' },
	// /api/x402/* paid services.
	{ path: '/api/x402/agent-reputation', method: 'GET' },
	// Param-gated routes use each handler's own documented INPUT_EXAMPLE so the
	// request clears input validation and draws the 402 (which carries pricing).
	{ path: '/api/x402/asset-download?slug=pole-dancer-rumba', method: 'GET' },
	{ path: '/api/x402/cosmetic-purchase?id=skin-midnight&account=g_5f3c9a21b8', method: 'GET' },
	{ path: '/api/x402/crypto-intel', method: 'POST', json: true, body: '{}' },
	{ path: '/api/x402/dance-tip', method: 'GET' },
	{ path: '/api/x402/fact-check', method: 'POST', json: true, body: '{}' },
	{ path: '/api/x402/forge', method: 'POST', json: true, body: '{}' },
	{ path: '/api/x402/mint-to-mesh', method: 'GET' },
	{ path: '/api/x402/mint-to-mesh-batch', method: 'POST', json: true, body: '{}' },
	{ path: '/api/x402/model-check', method: 'GET' },
	{ path: '/api/x402/onchain-identity-verify', method: 'GET' },
	{ path: '/api/x402/permit2-paid-demo', method: 'GET' },
	{ path: '/api/x402/pump-agent-audit', method: 'GET' },
	{ path: '/api/x402/pump-launch', method: 'POST', json: true, body: '{}' },
	{ path: '/api/x402/skill-call?skill=wallet-balance', method: 'GET' },
	{ path: '/api/x402/skill-marketplace', method: 'GET' },
	{ path: '/api/x402/symbol-availability', method: 'GET' },
	{ path: '/api/x402/tutor', method: 'POST', json: true, body: '{}' },
	{ path: '/api/x402/vanity', method: 'GET' },
];

async function touch({ path, method, body, json }) {
	const headers = { 'user-agent': 'three.ws-zauth-register-sweep' };
	if (json) headers['content-type'] = 'application/json';
	try {
		const res = await fetch(BASE + path, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(20_000),
		});
		// Drain the body so the lambda finishes its full lifecycle (and the
		// zauth drain() hold-open isn't cut short by an aborted socket).
		await res.arrayBuffer().catch(() => {});
		return { path, method, status: res.status };
	} catch (err) {
		return { path, method, status: 0, error: err.message };
	}
}

async function sweep() {
	console.log(`— zauth endpoint registration sweep → ${BASE} —\n`);
	const results = [];
	// Small batches: enough parallelism to finish fast, low enough to stay
	// polite to our own production functions.
	for (let i = 0; i < ENDPOINTS.length; i += 4) {
		const batch = ENDPOINTS.slice(i, i + 4);
		results.push(...(await Promise.all(batch.map(touch))));
	}
	let challenged = 0;
	let observed = 0;
	let failed = 0;
	for (const r of results) {
		// 402 = challenge served with pricing (ideal). Any other HTTP response
		// still drove the SDK observation; 0 = network failure, not observed.
		const tag = r.status === 402 ? '402 ✓' : r.status > 0 ? `${r.status} ·` : `FAIL ${r.error}`;
		if (r.status === 402) challenged++;
		if (r.status > 0) observed++;
		else failed++;
		console.log(`  ${tag}  ${r.method.padEnd(4)} ${r.path}`);
	}
	console.log(
		`\nobserved ${observed}/${ENDPOINTS.length} (402-challenged: ${challenged}, unreachable: ${failed})`,
	);
	return failed === 0;
}

async function confirmRegistry() {
	console.log('\n— zauth public directory (api.zauth.inc) —');
	try {
		const res = await fetch(`${DIRECTORY_API}?search=three.ws&limit=100`, {
			signal: AbortSignal.timeout(15_000),
		});
		const data = await res.json();
		const endpoints = data?.endpoints || [];
		console.log(
			`registered three.ws endpoints: ${data?.pagination?.total ?? endpoints.length} ` +
				`(verified: ${data?.stats?.verified ?? '?'})`,
		);
		for (const e of endpoints) {
			console.log(
				`  ${e.verified ? '✓' : '·'} ${e.method.padEnd(4)} ${e.url}  [${e.status}]`,
			);
		}
		// Telemetry is ingested asynchronously upstream; a sparse list right
		// after the sweep is expected. Re-run this script (or just this check)
		// after a few minutes to watch the registry fill in.
		return endpoints.length;
	} catch (err) {
		console.log(`directory query failed: ${err.message}`);
		return -1;
	}
}

const swept = await sweep();
await confirmRegistry();
process.exitCode = swept ? 0 : 1;
