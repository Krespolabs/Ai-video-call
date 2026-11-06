// Unit tests for the shared MCP tool-error sanitizer used by both dispatchers
// (api/_mcp/dispatch.js and api/_lib/mcp-dispatch.js). Verifies pg/driver
// internals and internal hostnames never reach the caller, while safe
// handler-authored messages pass through.

import { describe, it, expect, vi } from 'vitest';
import { sanitizeToolError } from '../../api/_lib/mcp-error-sanitize.js';

const silentLog = { error: vi.fn() };

describe('sanitizeToolError', () => {
	it('suppresses Postgres driver errors (severity/SQLSTATE) behind a ref id', () => {
		const err = Object.assign(new Error('relation "users" does not exist'), {
			severity: 'ERROR',
			code: '42P01',
			schema: 'public',
		});
		const { message } = sanitizeToolError(err, { tool: 't', server: 's', log: silentLog });
		expect(message).toMatch(/^internal error \(ref [0-9a-f]+\)$/);
		expect(message).not.toContain('users');
		expect(message).not.toContain('42P01');
	});

	it('suppresses messages that leak a postgres connection string', () => {
		const err = new Error('connect ECONNREFUSED postgres://app:secret@db.internal:5432/main');
		const { message } = sanitizeToolError(err, { tool: 't', server: 's', log: silentLog });
		expect(message).toMatch(/^internal error \(ref [0-9a-f]+\)$/);
		expect(message).not.toContain('secret');
		expect(message).not.toContain('db.internal');
	});

	it('suppresses messages that leak an RFC1918 internal IP', () => {
		const err = new Error('upstream 10.0.3.7 refused the connection');
		const { message } = sanitizeToolError(err, { tool: 't', server: 's', log: silentLog });
		expect(message).toMatch(/^internal error \(ref/);
		expect(message).not.toContain('10.0.3.7');
	});

	it('passes a safe handler-authored message through unchanged', () => {
		const err = new Error('fetch failed: host resolves to private address (private_address)');
		const { message } = sanitizeToolError(err, { tool: 't', server: 's', log: silentLog });
		expect(message).toBe('fetch failed: host resolves to private address (private_address)');
	});

	it('always logs full detail with a log id to the provided logger', () => {
		const log = { error: vi.fn() };
		const { logId } = sanitizeToolError(new Error('boom'), { tool: 'x', server: 'y', log });
		expect(log.error).toHaveBeenCalledTimes(1);
		const [, meta] = log.error.mock.calls[0];
		expect(meta.log_id).toBe(logId);
		expect(meta.detail).toContain('boom');
	});
});
