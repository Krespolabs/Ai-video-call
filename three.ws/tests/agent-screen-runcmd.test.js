/**
 * Deploy-to-wall run-command builder — unit tests.
 *
 * The wizard hands an owner the exact command to start their caster. These tests
 * pin the contract the wizard depends on: the right agentId/key/env are
 * interpolated for every runtime, the command is built from REAL values (no
 * leftover <AGENT_ID>/<AGENT_JWT> placeholders the user must guess), the push
 * URL tracks the viewer's origin, and the highlighted display never drifts from
 * the copyable raw command.
 */

import { describe, it, expect } from 'vitest';
import {
	buildRunCommand,
	buildRunCommandHtml,
	runtimeEnv,
	RUNTIMES,
	RUNTIME_LABELS,
	PUSH_PATH,
	IMAGE_TAG,
} from '../src/agent-screen-runcmd.js';

const REAL = {
	agentId: '11111111-2222-3333-4444-555555555555',
	agentJwt: 'sk_live_realmintedkeyvalue_abc123',
	origin: 'https://three.ws',
};

describe('runtimeEnv', () => {
	it('always includes AGENT_ID, AGENT_JWT, the origin-joined PUSH_URL and the Anthropic key', () => {
		const env = Object.fromEntries(runtimeEnv({ runtime: 'local', ...REAL }));
		expect(env.AGENT_ID).toBe(REAL.agentId);
		expect(env.AGENT_JWT).toBe(REAL.agentJwt);
		expect(env.PUSH_URL).toBe(`${REAL.origin}${PUSH_PATH}`);
		// act/extract needs a model key on every runtime, not just bb
		expect(env.ANTHROPIC_API_KEY).toBe('<your-anthropic-key>');
	});

	it('adds the Browserbase key only for the bb runtime — and never a project id', () => {
		expect(runtimeEnv({ runtime: 'local', ...REAL }).map((e) => e[0])).not.toContain('BROWSERBASE_API_KEY');
		const bb = runtimeEnv({ runtime: 'bb', ...REAL }).map((e) => e[0]);
		expect(bb).toContain('BROWSERBASE_API_KEY');
		// Browserbase resolves the project from the key — a project id is never emitted
		expect(bb).not.toContain('BROWSERBASE_PROJECT_ID');
	});

	it('joins PUSH_URL onto a non-prod origin (preview/staging hosts)', () => {
		const env = Object.fromEntries(runtimeEnv({ runtime: 'local', ...REAL, origin: 'http://localhost:3000' }));
		expect(env.PUSH_URL).toBe('http://localhost:3000/api/agent-screen-push');
	});
});

describe('buildRunCommand', () => {
	it('local runtime inlines the real agentId, key and push url before npm start', () => {
		const cmd = buildRunCommand({ runtime: 'local', ...REAL });
		expect(cmd).toBe(
			`AGENT_ID=${REAL.agentId} AGENT_JWT=${REAL.agentJwt} PUSH_URL=${REAL.origin}${PUSH_PATH} ANTHROPIC_API_KEY=<your-anthropic-key> npm start`,
		);
	});

	it('docker runtime builds the image then runs it with -e flags', () => {
		const cmd = buildRunCommand({ runtime: 'docker', ...REAL });
		expect(cmd).toContain(`docker build -t ${IMAGE_TAG} .`);
		expect(cmd).toContain(`-e AGENT_ID=${REAL.agentId}`);
		expect(cmd).toContain(`-e AGENT_JWT=${REAL.agentJwt}`);
		expect(cmd).toContain(`-e PUSH_URL=${REAL.origin}${PUSH_PATH}`);
		expect(cmd.trim().endsWith(IMAGE_TAG)).toBe(true);
	});

	it('bb runtime carries the Browserbase key (no project id) and runs npm start', () => {
		const cmd = buildRunCommand({ runtime: 'bb', ...REAL });
		expect(cmd).toContain('BROWSERBASE_API_KEY=');
		expect(cmd).not.toContain('BROWSERBASE_PROJECT_ID');
		expect(cmd.endsWith('npm start')).toBe(true);
	});

	it('unknown runtime falls back to local rather than producing garbage', () => {
		expect(buildRunCommand({ runtime: 'nonsense', ...REAL })).toBe(buildRunCommand({ runtime: 'local', ...REAL }));
	});

	it('leaves no three.ws-side placeholder once a real agent + key are supplied', () => {
		for (const runtime of RUNTIMES) {
			const cmd = buildRunCommand({ runtime, ...REAL });
			expect(cmd).not.toContain('<AGENT_ID>');
			expect(cmd).not.toContain('<AGENT_JWT>');
			expect(cmd).not.toContain('<PUSH_URL>');
		}
	});

	it('local and docker carry no angle-bracket placeholder except the Anthropic key', () => {
		for (const runtime of ['local', 'docker']) {
			const cmd = buildRunCommand({ runtime, ...REAL });
			// ANTHROPIC_API_KEY is a genuine user-supplied value on every runtime;
			// once it's removed there must be no other placeholder left to guess.
			expect(cmd.replace('<your-anthropic-key>', '')).not.toMatch(/<[^>]+>/);
		}
	});
});

describe('buildRunCommandHtml', () => {
	it('renders the same real values as the raw command for every runtime', () => {
		for (const runtime of RUNTIMES) {
			const html = buildRunCommandHtml({ runtime, ...REAL });
			expect(html).toContain(REAL.agentId);
			expect(html).toContain(REAL.agentJwt);
			expect(html).toContain('agent-screen-push');
			// highlighted, not raw text
			expect(html).toContain('cmd-key');
		}
	});

	it('HTML-escapes the Browserbase placeholder angle brackets', () => {
		const html = buildRunCommandHtml({ runtime: 'bb', ...REAL });
		expect(html).toContain('&lt;your-bb-key&gt;');
		expect(html).not.toContain('<your-bb-key>');
	});
});

describe('runtime metadata', () => {
	it('exposes a label for every runtime', () => {
		for (const runtime of RUNTIMES) expect(RUNTIME_LABELS[runtime]).toBeTruthy();
	});
});
