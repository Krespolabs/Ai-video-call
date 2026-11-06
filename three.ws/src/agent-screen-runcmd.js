// agent-screen-runcmd.js — pure run-command builder for the deploy-to-wall wizard.
//
// The /agent-screen setup wizard turns a selected agent + a freshly minted
// AGENT_JWT into the exact command an owner runs to start their caster. The
// command is built from REAL values only — the selected agentId, the minted
// key, and the caster's documented env (see workers/agent-screen-worker/README).
// No placeholder the user must guess, except the two Browserbase credentials
// that genuinely come from the user's own Browserbase account.
//
// Kept dependency-free and side-effect-free so the builder is unit-testable in
// isolation (tests/agent-screen-runcmd.test.js) — the wizard imports both the
// raw command (for clipboard) and the highlighted form (for display).

// Path the caster POSTs frames to. Joined onto the viewer's origin so a command
// copied from a preview/staging host targets that same host, not prod.
export const PUSH_PATH = '/api/agent-screen-push';
// Directory the command is run from + the Docker image tag it builds.
export const WORKER_DIR = 'workers/agent-screen-worker';
export const IMAGE_TAG = 'agent-screen-worker';

// The three runtimes the wizard offers, in tab order.
export const RUNTIMES = ['local', 'docker', 'bb'];

export const RUNTIME_LABELS = {
	local: 'Local (npm)',
	docker: 'Docker',
	bb: 'Browserbase',
};

// The Browserbase API key is the only value the user supplies themselves — it
// comes from the user's Browserbase account, not from three.ws. Marked as an
// explicit angle-bracket placeholder so it's obvious it must be filled in.
// NOTE: no BROWSERBASE_PROJECT_ID — Browserbase resolves the project from the API
// key alone. Never emit a project-id placeholder; it would only be a value the
// user has to hunt down for nothing.
const BB_PLACEHOLDERS = [
	['BROWSERBASE_API_KEY', '<your-bb-key>'],
];

// Anthropic key drives Stagehand's page.act()/page.extract() — the difference
// between an agent that only loads pages and one that types, clicks, and reads.
// User-supplied (their own key), so it's an explicit placeholder on every runtime.
const ANTHROPIC_PLACEHOLDER = ['ANTHROPIC_API_KEY', '<your-anthropic-key>'];

function normalizeRuntime(runtime) {
	return RUNTIMES.includes(runtime) ? runtime : 'local';
}

// The ordered [key, value] env pairs a runtime needs. AGENT_ID / AGENT_JWT /
// PUSH_URL / ANTHROPIC_API_KEY are required for every runtime; Browserbase adds
// its two creds.
export function runtimeEnv({ runtime = 'local', agentId = '', agentJwt = '', origin = 'https://three.ws' } = {}) {
	const env = [
		['AGENT_ID', agentId],
		['AGENT_JWT', agentJwt],
		['PUSH_URL', `${origin}${PUSH_PATH}`],
		ANTHROPIC_PLACEHOLDER,
	];
	if (normalizeRuntime(runtime) === 'bb') env.push(...BB_PLACEHOLDERS);
	return env;
}

// Single-line command suitable for the clipboard. Real values inlined; no
// hidden placeholders beyond the Browserbase creds on the `bb` runtime.
export function buildRunCommand(opts = {}) {
	const runtime = normalizeRuntime(opts.runtime);
	const env = runtimeEnv({ ...opts, runtime });
	if (runtime === 'docker') {
		const flags = env.map(([k, v]) => `-e ${k}=${v}`).join(' ');
		return `docker build -t ${IMAGE_TAG} . && docker run ${flags} ${IMAGE_TAG}`;
	}
	const prefix = env.map(([k, v]) => `${k}=${v}`).join(' ');
	return `${prefix} npm start`;
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Multi-line, syntax-highlighted command for the <pre> display. Derived from the
// same runtimeEnv() the raw command uses, so the shown command and the copied
// command never drift. Returns an HTML string (callers set it as innerHTML on a
// trusted, escaped-by-this-fn block).
export function buildRunCommandHtml(opts = {}) {
	const runtime = normalizeRuntime(opts.runtime);
	const env = runtimeEnv({ ...opts, runtime });
	const kv = ([k, v]) => `<span class="cmd-key">${esc(k)}</span>=<span class="cmd-val">${esc(v)}</span>`;

	if (runtime === 'docker') {
		const lines = [
			`<span class="cmd-comment"># from ${WORKER_DIR}/</span>`,
			`<span class="cmd-run">docker build</span> -t ${IMAGE_TAG} . && \\`,
			`<span class="cmd-run">docker run</span> \\`,
			...env.map((e) => `  -e ${kv(e)} \\`),
			`  ${IMAGE_TAG}`,
		];
		return lines.join('\n');
	}

	const lines = [
		`<span class="cmd-comment"># from ${WORKER_DIR}/</span>`,
		...env.map((e) => `${kv(e)} \\`),
		`<span class="cmd-run">npm start</span>`,
	];
	return lines.join('\n');
}
