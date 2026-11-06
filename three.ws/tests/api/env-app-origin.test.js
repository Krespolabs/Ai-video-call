// Regression guard for env.APP_ORIGIN normalization.
//
// Production once had PUBLIC_APP_ORIGIN set to a bare host ("three.ws", no
// scheme). The old getter returned it verbatim, so every handler that ran
// `new URL(env.APP_ORIGIN)` — SIWS/SIWE nonce, OIDC discovery, did:web — threw
// ERR_INVALID_URL and 500'd. env.APP_ORIGIN must always resolve to a valid
// absolute origin no matter how the env var is (mis)configured.

import { describe, it, expect, afterEach } from 'vitest';
import { env } from '../../api/_lib/env.js';

const original = process.env.PUBLIC_APP_ORIGIN;

afterEach(() => {
	if (original === undefined) delete process.env.PUBLIC_APP_ORIGIN;
	else process.env.PUBLIC_APP_ORIGIN = original;
});

function set(v) {
	if (v === undefined) delete process.env.PUBLIC_APP_ORIGIN;
	else process.env.PUBLIC_APP_ORIGIN = v;
}

describe('env.APP_ORIGIN', () => {
	it('always returns a parseable absolute origin', () => {
		for (const v of ['three.ws', '', undefined, 'https://three.ws/', 'https://three.ws', 'app.test:8080']) {
			set(v);
			expect(() => new URL(env.APP_ORIGIN)).not.toThrow();
		}
	});

	it('prepends https:// to a bare host (the production misconfiguration)', () => {
		set('three.ws');
		expect(env.APP_ORIGIN).toBe('https://three.ws');
		expect(new URL(env.APP_ORIGIN).host).toBe('three.ws');
	});

	it('falls back to the canonical origin when unset or empty', () => {
		set(undefined);
		expect(env.APP_ORIGIN).toBe('https://three.ws');
		set('');
		expect(env.APP_ORIGIN).toBe('https://three.ws');
	});

	it('strips a trailing slash and any path, keeping the origin', () => {
		set('https://three.ws/');
		expect(env.APP_ORIGIN).toBe('https://three.ws');
		set('https://three.ws/app/');
		expect(env.APP_ORIGIN).toBe('https://three.ws');
	});

	it('preserves a valid non-default origin (preview deploys)', () => {
		set('https://my-deploy-abc.vercel.app');
		expect(env.APP_ORIGIN).toBe('https://my-deploy-abc.vercel.app');
	});
});
