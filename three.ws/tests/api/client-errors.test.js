// Unit tests for /api/client-errors — the client-side error report ingest.
// Verifies the real contract without network: validation and truncation of
// attacker-controllable input, the per-event "[client-error]" log line that
// Vercel log search depends on, Sentry forwarding for JS errors (but not
// resource 404s), rate limiting, and method/CORS handling.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const state = { rateLimited: false };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		clientErrorsIp: vi.fn(async () =>
			state.rateLimited
				? { success: false, limit: 30, remaining: 0, reset: Date.now() + 60_000 }
				: { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 },
		),
	},
	clientIp: vi.fn(() => '203.0.113.7'),
}));

const captureException = vi.fn();
vi.mock('../../api/_lib/sentry.js', () => ({
	captureException: (...args) => captureException(...args),
	captureMessage: vi.fn(),
}));

const sendOpsAlert = vi.fn();
vi.mock('../../api/_lib/alerts.js', () => ({
	sendOpsAlert: (...args) => sendOpsAlert(...args),
}));

const { default: handler } = await import('../../api/client-errors.js');

function makeReq({ method = 'POST', body = null, raw = null, contentType } = {}) {
	const payload = raw ?? (body ? JSON.stringify(body) : '');
	const req = Readable.from(payload ? [Buffer.from(payload)] : []);
	req.method = method;
	req.url = '/api/client-errors';
	req.headers = {
		host: 'localhost',
		'content-type': contentType || 'application/json',
		'user-agent': 'TestBrowser/1.0',
	};
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(reqOpts) {
	const res = makeRes();
	await handler(makeReq(reqOpts), res);
	let body = null;
	try {
		body = JSON.parse(res.body);
	} catch {
		/* non-JSON (e.g. empty 204) */
	}
	return { status: res.statusCode, body, res };
}

const errorEvent = (overrides = {}) => ({
	type: 'error',
	name: 'TypeError',
	message: 'x is not a function',
	source: 'https://three.ws/app.js',
	line: 12,
	col: 3,
	stack: 'TypeError: x is not a function\n    at boot (https://three.ws/app.js:12:3)',
	ts: 1_750_000_000_000,
	...overrides,
});

let consoleError;
let consoleInfo;
beforeEach(() => {
	state.rateLimited = false;
	captureException.mockClear();
	sendOpsAlert.mockClear();
	consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
	consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
	consoleError.mockRestore();
	consoleInfo.mockRestore();
});

describe('api/client-errors', () => {
	it('rejects non-POST methods', async () => {
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});

	it('answers OPTIONS preflight with 204', async () => {
		const { status } = await invoke({ method: 'OPTIONS' });
		expect(status).toBe(204);
	});

	it('rejects an empty or missing events array', async () => {
		for (const body of [{}, { events: [] }, { events: 'nope' }]) {
			const { status, body: out } = await invoke({ body });
			expect(status).toBe(400);
			expect(out.error).toBe('validation_error');
		}
	});

	it('rejects invalid JSON', async () => {
		const { status, body } = await invoke({ raw: '{not json' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('accepts a batch and logs one [client-error] line per event', async () => {
		const { status, body } = await invoke({
			body: {
				page: 'https://three.ws/play',
				viewport: { w: 1440, h: 900 },
				events: [errorEvent(), errorEvent({ type: 'unhandledrejection', message: 'boom' })],
			},
		});
		expect(status).toBe(202);
		expect(body.received).toBe(2);
		const lines = consoleError.mock.calls.filter(([tag]) => tag === '[client-error]');
		expect(lines).toHaveLength(2);
		const logged = JSON.parse(lines[0][1]);
		expect(logged.message).toBe('x is not a function');
		expect(logged.page).toBe('https://three.ws/play');
		expect(logged.ua).toBe('TestBrowser/1.0');
		expect(logged.ip).toBe('203.0.113.7');
	});

	describe('non-actionable noise filter', () => {
		const cases = [
			['cross-origin "Script error."', { type: 'error', message: 'Script error.' }],
			['cross-origin "Script error" (no period)', { type: 'error', message: 'Script error' }],
			[
				'AbortError by name',
				{ type: 'unhandledrejection', name: 'AbortError', message: 'Fetch is aborted' },
			],
			[
				'aborted by message',
				{ type: 'unhandledrejection', message: 'The operation was aborted' },
			],
			[
				'injected webview global (Safari)',
				{ type: 'error', name: 'ReferenceError', message: "Can't find variable: currentInset" },
			],
			[
				'injected webview global (Chrome/FF)',
				{ type: 'error', name: 'ReferenceError', message: 'gCrWeb is not defined' },
			],
			[
				'injected-overlay hideIndicator (WebKit)',
				{
					type: 'unhandledrejection',
					name: 'TypeError',
					message: "undefined is not an object (evaluating 'e.hideIndicator')",
				},
			],
			[
				'injected-overlay hideIndicator (Chromium)',
				{
					type: 'unhandledrejection',
					name: 'TypeError',
					message: "Cannot read properties of undefined (reading 'hideIndicator')",
				},
			],
			[
				'stackless colorSpace null-read (injected canvas wrapper)',
				{
					type: 'unhandledrejection',
					name: 'TypeError',
					message: "Cannot read properties of null (reading 'colorSpace')",
				},
			],
		];
		for (const [label, event] of cases) {
			it(`drops ${label} — no log, no Sentry, no page`, async () => {
				const { status, body } = await invoke({
					body: { page: 'https://three.ws/walk', events: [{ ts: 1, ...event }] },
				});
				expect(status).toBe(202);
				expect(body.received).toBe(0);
				expect(body.dropped).toBe(1);
				expect(consoleError.mock.calls.filter(([tag]) => tag === '[client-error]')).toHaveLength(0);
				expect(captureException).not.toHaveBeenCalled();
				expect(sendOpsAlert).not.toHaveBeenCalled();
			});
		}

		it('still reports a colorSpace null-read that carries a first-party stack', async () => {
			// A genuine three-core fault (our bundle) keeps its /assets/* stack — only
			// the unattributable stackless variant is injected noise we drop.
			const { body } = await invoke({
				body: {
					page: 'https://three.ws/walk',
					events: [
						{
							type: 'unhandledrejection',
							name: 'TypeError',
							message: "Cannot read properties of null (reading 'colorSpace')",
							stack: 'TypeError\n    at applyEnv (https://three.ws/assets/walk-abc123.js:9:42)',
							ts: 1,
						},
					],
				},
			});
			expect(body.received).toBe(1);
			expect(body.dropped).toBe(0);
			expect(captureException).toHaveBeenCalledTimes(1);
		});

		it('still reports a real TypeError that dereferences one of our own symbols', async () => {
			const { body } = await invoke({
				body: {
					page: 'https://three.ws/walk',
					events: [
						{
							type: 'unhandledrejection',
							name: 'TypeError',
							message: "undefined is not an object (evaluating 'viewer.renderScene')",
							ts: 1,
						},
					],
				},
			});
			expect(body.received).toBe(1);
			expect(body.dropped).toBe(0);
			expect(captureException).toHaveBeenCalledTimes(1);
		});

		it('still reports a real ReferenceError that names one of our own variables', async () => {
			const { body } = await invoke({
				body: {
					page: 'https://three.ws/walk',
					events: [{ type: 'error', name: 'ReferenceError', message: 'renderScene is not defined', ts: 1 }],
				},
			});
			expect(body.received).toBe(1);
			expect(body.dropped).toBe(0);
			expect(captureException).toHaveBeenCalledTimes(1);
		});

		it('drops only the noise events in a mixed batch', async () => {
			const { body } = await invoke({
				body: {
					page: 'https://three.ws/walk',
					events: [
						errorEvent(),
						{ type: 'error', message: 'Script error.', ts: 1 },
						{ type: 'unhandledrejection', name: 'AbortError', message: 'Fetch is aborted', ts: 2 },
					],
				},
			});
			expect(body.received).toBe(1);
			expect(body.dropped).toBe(2);
			expect(consoleError.mock.calls.filter(([tag]) => tag === '[client-error]')).toHaveLength(1);
		});
	});

	it('forwards JS errors to Sentry with the client stack, but not resource events', async () => {
		await invoke({
			body: {
				events: [
					errorEvent(),
					{ type: 'resource', tag: 'img', message: 'failed to load img', source: 'https://three.ws/x.png' },
				],
			},
		});
		expect(captureException).toHaveBeenCalledTimes(1);
		const [err, ctx] = captureException.mock.calls[0];
		expect(err.name).toBe('TypeError');
		expect(err.stack).toContain('at boot (https://three.ws/app.js:12:3)');
		expect(ctx.origin).toBe('client');
	});

	it('drops malformed events and truncates oversized fields', async () => {
		const { status, body } = await invoke({
			body: {
				events: [
					errorEvent({ message: 'a'.repeat(2000), stack: 'b'.repeat(10_000) }),
					{ type: 'bogus-type', message: 'x' },
					{ type: 'error' }, // no message
					'not-an-object',
				],
			},
		});
		expect(status).toBe(202);
		expect(body.received).toBe(1);
		const logged = JSON.parse(
			consoleError.mock.calls.find(([tag]) => tag === '[client-error]')[1],
		);
		expect(logged.message.length).toBe(501); // 500 + ellipsis
		expect(logged.stack.length).toBe(4001);
	});

	it('caps a batch at 25 events', async () => {
		const { status, body } = await invoke({
			body: { events: Array.from({ length: 40 }, () => errorEvent()) },
		});
		expect(status).toBe(202);
		expect(body.received).toBe(25);
	});

	it('pages the ops channel for JS errors but not resource events', async () => {
		await invoke({
			body: {
				page: 'https://three.ws/play',
				events: [
					errorEvent(),
					{ type: 'resource', tag: 'img', message: 'failed to load img', source: 'https://three.ws/x.png' },
				],
			},
		});
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		expect(sendOpsAlert.mock.calls[0][0]).toContain('client error on https://three.ws/play');
	});

	it('logs resource failures at info severity, never as errors', async () => {
		// A failed img/script (CDN blip, offline mobile network, third-party embed
		// unreachable) is client telemetry, not a server fault — it must not surface
		// in the error/warning dashboards. Still logged + searchable, just at info.
		const { status } = await invoke({
			body: {
				page: 'https://three.ws/login',
				events: [
					{ type: 'resource', tag: 'img', message: 'failed to load img', source: 'https://three.ws/three.svg' },
				],
			},
		});
		expect(status).toBe(202);
		const infoLine = consoleInfo.mock.calls.find(([tag]) => tag === '[client-error]');
		expect(infoLine).toBeDefined();
		expect(JSON.parse(infoLine[1]).source).toBe('https://three.ws/three.svg');
		expect(consoleError.mock.calls.some(([tag]) => tag === '[client-error]')).toBe(false);
		expect(captureException).not.toHaveBeenCalled();
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('ingests report-uri CSP reports (application/csp-report)', async () => {
		const { status, body } = await invoke({
			contentType: 'application/csp-report',
			raw: JSON.stringify({
				'csp-report': {
					'document-uri': 'https://three.ws/play',
					'violated-directive': 'script-src',
					'effective-directive': 'script-src',
					'blocked-uri': 'https://evil.example/x.js',
					'line-number': 7,
				},
			}),
		});
		expect(status).toBe(202);
		expect(body.received).toBe(1);
		// CSP reports are client telemetry, not server faults — logged at info, not
		// error, so the error/warning dashboards stay actionable.
		const logged = JSON.parse(
			consoleInfo.mock.calls.find(([tag]) => tag === '[client-error]')[1],
		);
		expect(logged.type).toBe('csp');
		expect(logged.message).toBe('CSP violation: script-src');
		expect(logged.source).toBe('https://evil.example/x.js');
		// CSP stays log-only and below error severity: no error line, no Sentry, no ops page.
		expect(consoleError.mock.calls.some(([tag]) => tag === '[client-error]')).toBe(false);
		expect(captureException).not.toHaveBeenCalled();
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('ingests report-to CSP reports (application/reports+json)', async () => {
		const { status, body } = await invoke({
			contentType: 'application/reports+json',
			raw: JSON.stringify([
				{
					type: 'csp-violation',
					body: {
						documentURL: 'https://three.ws/',
						effectiveDirective: 'object-src',
						blockedURL: 'https://evil.example/applet',
					},
				},
			]),
		});
		expect(status).toBe(202);
		expect(body.received).toBe(1);
		const logged = JSON.parse(
			consoleInfo.mock.calls.find(([tag]) => tag === '[client-error]')[1],
		);
		expect(logged.message).toBe('CSP violation: object-src');
	});

	it('drops dev/localhost-origin batches without logging, Sentry, or ops paging', async () => {
		for (const page of [
			'http://localhost:5191/xr.html',
			'http://127.0.0.1:4317/dashboard/',
			'https://glorious-space-fishstick-x.app.github.dev/create',
			'http://192.168.1.20:3000/',
		]) {
			captureException.mockClear();
			sendOpsAlert.mockClear();
			consoleError.mockClear();
			const { status, body } = await invoke({
				body: {
					page,
					events: [errorEvent(), errorEvent({ type: 'unhandledrejection', message: 'WebSocket closed without opened.' })],
				},
			});
			expect(status).toBe(202);
			expect(body.received).toBe(0);
			expect(body.dropped).toBe(2);
			expect(consoleError.mock.calls.filter(([tag]) => tag === '[client-error]')).toHaveLength(0);
			expect(captureException).not.toHaveBeenCalled();
			expect(sendOpsAlert).not.toHaveBeenCalled();
		}
	});

	it('still ingests a real prod-origin batch (dev filter does not over-match)', async () => {
		const { status, body } = await invoke({
			body: { page: 'https://three.ws/play', events: [errorEvent()] },
		});
		expect(status).toBe(202);
		expect(body.received).toBe(1);
	});

	it('returns 429 with Retry-After when the IP is rate limited', async () => {
		state.rateLimited = true;
		const { status, body, res } = await invoke({ body: { events: [errorEvent()] } });
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
	});
});
