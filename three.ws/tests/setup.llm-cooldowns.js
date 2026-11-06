// The LLM chain remembers rungs that recently failed (api/_lib/llm.js, provider
// cooldown) for the life of the server instance. In tests that memory would
// leak between cases: a rung one test fails with a 429 would be skipped by the
// next test that expects it to answer. Clear it before every test. The map
// lives on a global symbol precisely so this file never imports llm.js, which
// would load it ahead of each test file's own vi.mock() calls.
import { beforeEach } from 'vitest';

beforeEach(() => {
	globalThis[Symbol.for('three.ws.llmCooldowns')]?.clear();
});
