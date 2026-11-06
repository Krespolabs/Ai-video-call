import { describe, it, expect } from 'vitest';
import { parseGrindCommand } from '../src/vanity-grind-director.js';

describe('parseGrindCommand', () => {
	it('extracts a prefix from the bare "grind <token>" form', () => {
		expect(parseGrindCommand('grind pump')).toMatchObject({ prefix: 'pump', suffix: null, ignoreCase: true });
	});

	it('parses "starting with" / "ending with" phrasing', () => {
		expect(parseGrindCommand('grind a wallet starting with pump')).toMatchObject({ prefix: 'pump' });
		expect(parseGrindCommand('vanity ending with 42')).toMatchObject({ prefix: '', suffix: '42' });
	});

	it('parses explicit prefix + suffix together', () => {
		expect(parseGrindCommand('grind prefix nova suffix xyz')).toMatchObject({ prefix: 'nova', suffix: 'xyz' });
	});

	it('caps the pattern at 6 base58 chars', () => {
		expect(parseGrindCommand('grind abcdefghij').prefix).toBe('abcdef');
	});

	it('honours an explicit case-sensitive request', () => {
		expect(parseGrindCommand('grind Pump case-sensitive')).toMatchObject({ prefix: 'Pump', ignoreCase: false });
	});

	it('rejects non-base58 tokens (0 O I l) by finding no pattern', () => {
		// "lOl" is all non-base58 chars → no usable token → not a grind command.
		expect(parseGrindCommand('grind lOl')).toBeNull();
	});

	it('returns null when there is no grind trigger', () => {
		expect(parseGrindCommand('research the latest solana news')).toBeNull();
		expect(parseGrindCommand('launch a coin named Foo')).toBeNull();
	});

	it('ignores filler words after the trigger', () => {
		expect(parseGrindCommand('grind a wallet for me')).toBeNull();
	});
});
