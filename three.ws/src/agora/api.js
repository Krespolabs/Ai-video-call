// Agora — thin client for the real read APIs the trust surface consumes. No
// caching tricks, no fabrication: every call hits a live endpoint and surfaces
// failures so the panels can render honest error states.
//
//   /api/agora/passport   — living passport (projection + on-chain + activity)
//   /api/agenc/get-task   — on-chain task state + lifecycle timeline
//   /api/agenc/get-agent  — on-chain agent registration (reconcile)
//   /api/agenc/link       — canonical AgenC id for an identity (handshake)

const DEFAULT_TIMEOUT = 20000;

// GET JSON with an abort timeout. Throws Error(message) on network failure or a
// non-2xx response so callers can show the message verbatim.
export async function getJson(url, { signal, timeout = DEFAULT_TIMEOUT } = {}) {
	const ctrl = new AbortController();
	const onAbort = () => ctrl.abort();
	if (signal) signal.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => ctrl.abort(), timeout);
	let res;
	try {
		res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
	} catch (err) {
		throw new Error(ctrl.signal.aborted ? 'Request timed out' : `Network error: ${err?.message || 'failed'}`);
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener('abort', onAbort);
	}
	let body;
	try { body = await res.json(); } catch { body = null; }
	if (!res.ok) {
		const msg = body?.error_description || body?.message || body?.error || `HTTP ${res.status}`;
		throw new Error(msg);
	}
	return body;
}

export async function postJson(url, payload, { signal, timeout = DEFAULT_TIMEOUT } = {}) {
	const ctrl = new AbortController();
	const onAbort = () => ctrl.abort();
	if (signal) signal.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => ctrl.abort(), timeout);
	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify(payload || {}),
			signal: ctrl.signal,
		});
	} catch (err) {
		throw new Error(ctrl.signal.aborted ? 'Request timed out' : `Network error: ${err?.message || 'failed'}`);
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener('abort', onAbort);
	}
	let body;
	try { body = await res.json(); } catch { body = null; }
	if (!res.ok) {
		const msg = body?.error_description || body?.message || body?.error || `HTTP ${res.status}`;
		throw new Error(msg);
	}
	return body;
}

const q = (params) => new URLSearchParams(
	Object.entries(params).filter(([, v]) => v != null && v !== ''),
).toString();

export function fetchPassport({ id, agentPda, agentId }, opts) {
	return getJson(`/api/agora/passport?${q({ id, agentPda, agentId })}`, opts);
}

export function fetchCitizens(params = {}, opts) {
	return getJson(`/api/agora/citizens?${q(params)}`, opts);
}

export function fetchBoard(params = {}, opts) {
	return getJson(`/api/agora/board?${q(params)}`, opts);
}

export function fetchPulse(opts) {
	return getJson('/api/agora/pulse', opts);
}

export function fetchTask({ taskPda, creator, taskId, cluster = 'devnet', lifecycle = true }, opts) {
	return getJson(`/api/agenc/get-task?${q({ taskPda, creator, taskId, cluster, lifecycle: lifecycle ? 1 : undefined })}`, opts);
}

export function fetchAgent({ agentPda, agentId, cluster = 'devnet' }, opts) {
	return getJson(`/api/agenc/get-agent?${q({ agentPda, agentId, cluster })}`, opts);
}

export function linkIdentity({ erc8004AgentId, mplCoreAsset, handle, cluster = 'devnet', baseUrl }, opts) {
	return postJson('/api/agenc/link', { erc8004AgentId, mplCoreAsset, handle, cluster, baseUrl }, opts);
}
