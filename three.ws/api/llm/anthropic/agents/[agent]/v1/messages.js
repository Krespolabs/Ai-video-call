// POST /api/llm/anthropic/agents/:agent/v1/messages
//
// The we-pay proxy (api/llm/anthropic.js) at the path an Anthropic SDK client
// builds for itself. Every official SDK, and every CLI built on one, takes a
// base URL and appends `/v1/messages`, with no way to add a query parameter:
// the agent this call meters against therefore travels in the path instead.
// A client configured with
//
//   ANTHROPIC_BASE_URL=https://three.ws/api/llm/anthropic/agents/<agent-id>
//
// lands here, and the filesystem route binds `<agent-id>` to req.query.agent,
// which the proxy reads exactly like its own `?agent=` parameter. Everything
// else (auth, embed policy, rate limits, quota, the free-model chain) is the
// one implementation, so the two paths cannot drift.
export { default } from '../../../../anthropic.js';
