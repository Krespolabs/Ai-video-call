import { describe, it, expect } from 'vitest';
import { isNonActionableNoise } from '../api/client-errors.js';

const ev = (over) => ({ type: 'unhandledrejection', name: 'Object', message: '', stack: '', ...over });

describe('isNonActionableNoise — injected wallet-provider RPC noise', () => {
	// The exact signature seen in production: an injected EVM wallet rejects
	// window.ethereum.request() with EIP-1474 "Internal JSON-RPC error." as a plain
	// object (caught name "Object"), surfacing as an unhandledrejection on pages
	// that merely co-exist with a wallet extension (e.g. /trending).
	it('drops "Internal JSON-RPC error." with and without trailing period', () => {
		expect(isNonActionableNoise(ev({ message: 'Internal JSON-RPC error.' }))).toBe(true);
		expect(isNonActionableNoise(ev({ message: 'Internal JSON-RPC error' }))).toBe(true);
	});

	it('drops wallet user-cancellation messages (not faults)', () => {
		expect(isNonActionableNoise(ev({ message: 'User rejected the request.' }))).toBe(true);
		expect(isNonActionableNoise(ev({ message: 'User denied transaction signature' }))).toBe(true);
		expect(isNonActionableNoise(ev({ message: "Already processing eth_requestAccounts. Please wait." }))).toBe(true);
		expect(isNonActionableNoise(ev({ message: "Request of type 'wallet_switchEthereumChain' already pending" }))).toBe(true);
	});

	it('drops the same wallet noise reported as a top-level error event', () => {
		expect(isNonActionableNoise(ev({ type: 'error', message: 'Internal JSON-RPC error.' }))).toBe(true);
	});

	it('keeps genuine first-party faults that merely contain similar words', () => {
		expect(isNonActionableNoise(ev({ message: 'Internal server error' }))).toBe(false);
		expect(isNonActionableNoise(ev({ message: 'An internal error occurred while rendering' }))).toBe(false);
		expect(isNonActionableNoise(ev({ message: 'Failed to load avatar' }))).toBe(false);
		expect(isNonActionableNoise(ev({ type: 'error', name: 'TypeError', message: 'x is not a function' }))).toBe(false);
	});

	it('still drops the pre-existing noise classes', () => {
		expect(isNonActionableNoise(ev({ message: 'Script error.' }))).toBe(true);
		expect(isNonActionableNoise(ev({ name: 'AbortError', message: 'aborted' }))).toBe(true);
	});

	it('never touches resource/csp telemetry events', () => {
		expect(isNonActionableNoise(ev({ type: 'resource', message: 'Internal JSON-RPC error.' }))).toBe(false);
		expect(isNonActionableNoise(ev({ type: 'csp', message: 'Internal JSON-RPC error.' }))).toBe(false);
	});
});

describe('isNonActionableNoise — Safari webkit-masked-url injected scripts', () => {
	// The exact signature seen in production: a cashback/shopping browser extension's
	// `onResponse` handler throws inside a Safari-masked injected script, surfacing as
	// an unhandledrejection three.ws can never fix.
	it('drops an extension error whose stack is a webkit-masked-url frame', () => {
		expect(
			isNonActionableNoise(
				ev({
					name: 'TypeError',
					message: "undefined is not an object (evaluating 'response.cashbackReminder')",
					stack: 'onResponse@webkit-masked-url://hidden/:99:15',
				}),
			),
		).toBe(true);
	});

	it('drops it when the masked URL is only on the source field', () => {
		expect(
			isNonActionableNoise(ev({ type: 'error', message: 'boom', source: 'webkit-masked-url://hidden/' })),
		).toBe(true);
	});

	it('keeps a genuine first-party fault with a normal same-origin stack', () => {
		expect(
			isNonActionableNoise(
				ev({
					name: 'TypeError',
					message: "undefined is not an object (evaluating 'response.cashbackReminder')",
					stack: 'onResponse@https://three.ws/assets/index-abc.js:99:15',
				}),
			),
		).toBe(false);
	});
});
