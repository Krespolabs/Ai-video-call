// IBM watsonx Orchestrate (Agent Connect) configuration for the chat proxy.
//
// A watsonx Orchestrate agent — built in the Agent Builder / ADK — exposes an
// OpenAI-compatible chat-completions endpoint (the service instance "Test URL"
// with /chat/completions appended) secured by a bearer token. Because the wire
// format is OpenAI-shaped (messages in, choices[].delta.content SSE out), the
// proxy treats Orchestrate as an OpenAI-style provider: this module only
// resolves the endpoint URL, bearer token, and agent id from the environment.
//
// No mock path. When the URL or key is absent, configured() is false and the
// proxy reports the provider unavailable; auth/upstream failures surface as the
// real error from the stream loop.

// Accept either the bare service-instance URL or a full chat-completions URL,
// and normalise to the endpoint that actually serves completions.
function chatCompletionsUrl(raw) {
	const base = raw.replace(/\/+$/, '');
	if (/\/chat\/completions$/.test(base)) return base;
	if (/\/v1$/.test(base)) return `${base}/chat/completions`;
	return `${base}/chat/completions`;
}

export function orchestrateConfig(env = process.env) {
	const apiKey = env.WATSONX_ORCHESTRATE_API_KEY?.trim();
	const url = env.WATSONX_ORCHESTRATE_URL?.trim();
	return {
		configured: Boolean(apiKey && url),
		apiKey,
		// Full chat-completions endpoint for the configured agent.
		chatUrl: url ? chatCompletionsUrl(url) : null,
		// Orchestrate uses the OpenAI `model` field to name the target agent;
		// when unset many deployments ignore it, so a stable placeholder is fine.
		agent: env.WATSONX_ORCHESTRATE_AGENT?.trim() || 'orchestrate-agent',
	};
}
