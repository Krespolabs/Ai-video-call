import { describe, it, expect, afterEach } from 'vitest';

import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

import { detectEvents } from '../../api/cron/[name].js';
import { deriveEventId, decodeAttesterSecret, loadAttesterKeypair } from '../../api/_lib/attest-event.js';

const baseRow = {
	mint_id:           'mint-uuid',
	token_mint:        'TokenMintPubkey22222222222222222222222222222',
	network:           'devnet',
	agent_id:          'agent-uuid',
	agent_authority:   'AuthorityKey1111111111111111111111111111111',
	graduated:         false,
	last_signature:    'sig1',
	last_signature_at: '2026-04-29T10:00:00Z',
	agent_row_id:      'agent-uuid',
	user_id:           'user-uuid',
	agent_asset:       'AgentAssetPubkey1111111111111111111111111111',
	last_graduated:    null,
	last_authority:    null,
	last_trade_signature: null,
};

describe('detectEvents', () => {
	it('emits nothing on first sight (no cursor) when nothing has flipped', () => {
		expect(detectEvents({ ...baseRow })).toEqual([]);
	});

	it('emits a graduation event on false -> true flip', () => {
		const events = detectEvents({ ...baseRow, graduated: true, last_graduated: false });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event_type: 'graduation',
			source:     'pumpfun.graduation',
			task_id:    `pumpfun:${baseRow.token_mint}:graduation`,
		});
		expect(events[0].event_id).toMatch(/^[0-9a-f]{32}$/);
	});

	it('does not re-emit graduation when already graduated', () => {
		const events = detectEvents({ ...baseRow, graduated: true, last_graduated: true });
		expect(events).toEqual([]);
	});

	it('emits a CTO event when authority changes', () => {
		const events = detectEvents({
			...baseRow,
			agent_authority: 'NewAuthority999999999999999999999999999999',
			last_authority:  baseRow.agent_authority,
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event_type: 'cto_detected',
			source:     'pumpfun.cto',
		});
		expect(events[0].detail.from).toBe(baseRow.agent_authority);
		expect(events[0].detail.to).toBe('NewAuthority999999999999999999999999999999');
	});

	it('does not emit CTO when authority is unchanged', () => {
		const events = detectEvents({ ...baseRow, last_authority: baseRow.agent_authority });
		expect(events).toEqual([]);
	});

	it('emits both graduation and CTO when both flip in the same tick', () => {
		const events = detectEvents({
			...baseRow,
			graduated: true, last_graduated: false,
			agent_authority: 'NewAuthority999999999999999999999999999999',
			last_authority:  baseRow.agent_authority,
		});
		expect(events.map((e) => e.event_type).sort()).toEqual(['cto_detected', 'graduation']);
	});

	it('produces stable event ids (idempotent across runs)', () => {
		const a = detectEvents({ ...baseRow, graduated: true, last_graduated: false })[0];
		const b = detectEvents({ ...baseRow, graduated: true, last_graduated: false })[0];
		expect(a.event_id).toBe(b.event_id);
	});
});

describe('deriveEventId', () => {
	it('hashes (event_type, mint, slot_or_ts) to 32 hex chars', () => {
		const id = deriveEventId({ event_type: 'graduation', mint: 'M', slot_or_ts: 'final' });
		expect(id).toMatch(/^[0-9a-f]{32}$/);
	});

	it('differs across event types', () => {
		const a = deriveEventId({ event_type: 'graduation', mint: 'M', slot_or_ts: 'x' });
		const b = deriveEventId({ event_type: 'cto',         mint: 'M', slot_or_ts: 'x' });
		expect(a).not.toBe(b);
	});
});

describe('decodeAttesterSecret', () => {
	// A real, deterministic ed25519 keypair to encode across formats.
	const kp = Keypair.fromSeed(new Uint8Array(32).fill(7));
	const secret = kp.secretKey; // 64 bytes
	const expectedPubkey = kp.publicKey.toBase58();

	it('decodes a base58 secret key (the historical format)', () => {
		const bytes = decodeAttesterSecret(bs58.encode(secret));
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('decodes a Solana CLI JSON byte-array secret key', () => {
		const bytes = decodeAttesterSecret(JSON.stringify(Array.from(secret)));
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('decodes a JSON byte-array with surrounding whitespace', () => {
		const bytes = decodeAttesterSecret(`  ${JSON.stringify(Array.from(secret))}\n`);
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('decodes a base64 secret key', () => {
		const bytes = decodeAttesterSecret(Buffer.from(secret).toString('base64'));
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('decodes a base64url secret key (- and _ instead of + and /)', () => {
		const b64url = Buffer.from(secret).toString('base64url');
		const bytes = decodeAttesterSecret(b64url);
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('decodes a hex secret key (64 bytes = 128 hex chars)', () => {
		const bytes = decodeAttesterSecret(Buffer.from(secret).toString('hex'));
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('decodes an uppercase hex secret key', () => {
		const bytes = decodeAttesterSecret(Buffer.from(secret).toString('hex').toUpperCase());
		expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(expectedPubkey);
	});

	it('returns null for empty / missing input', () => {
		expect(decodeAttesterSecret('')).toBeNull();
		expect(decodeAttesterSecret(null)).toBeNull();
		expect(decodeAttesterSecret('   ')).toBeNull();
	});

	it('returns null for an undecodable string', () => {
		expect(decodeAttesterSecret('not-a-real-key-!@#$')).toBeNull();
	});

	it('returns null for a wrong-length byte array', () => {
		expect(decodeAttesterSecret(JSON.stringify([1, 2, 3]))).toBeNull();
	});
});

describe('loadAttesterKeypair', () => {
	const kp = Keypair.fromSeed(new Uint8Array(32).fill(9));
	const original = process.env.ATTEST_AGENT_SECRET_KEY;

	afterEach(() => {
		if (original === undefined) delete process.env.ATTEST_AGENT_SECRET_KEY;
		else process.env.ATTEST_AGENT_SECRET_KEY = original;
	});

	it('loads a JSON byte-array key from env (the format that caused the crash)', () => {
		process.env.ATTEST_AGENT_SECRET_KEY = JSON.stringify(Array.from(kp.secretKey));
		expect(loadAttesterKeypair().publicKey.toBase58()).toBe(kp.publicKey.toBase58());
	});

	it('throws a typed error when the key is set but undecodable', () => {
		process.env.ATTEST_AGENT_SECRET_KEY = 'not-base58-!@#';
		expect(() => loadAttesterKeypair()).toThrowError(/could not be decoded/);
		try {
			loadAttesterKeypair();
		} catch (e) {
			expect(e.code).toBe('attester_key_undecodable');
		}
	});

	it('throws when the key is missing', () => {
		delete process.env.ATTEST_AGENT_SECRET_KEY;
		expect(() => loadAttesterKeypair()).toThrowError(/not configured/);
	});
});
