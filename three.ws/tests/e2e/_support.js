/**
 * Shared helpers for the critical-flow e2e specs.
 *
 * Fidelity contract (same as launch-token-flow / coin-buy-trade): we drive the
 * REAL product modules and let them make their REAL fetches. The only stubbed
 * surfaces are the injected wallet *extensions* (window.solana / window.ethereum)
 * — they are external browser software, not our code or a real API — and the
 * specific backend endpoints a flow touches, which we fulfill at the Playwright
 * route layer with realistic payloads so the run is deterministic and never
 * signs against a real chain. Everything between the click and the assertion is
 * the shipped client code.
 */

/**
 * Install a synthetic Phantom-compatible Solana wallet at window.solana.
 *
 * Mirrors what Phantom injects: `.isPhantom`, `.connect()`/`.disconnect()`,
 * `.publicKey`, and `signMessage`/`signTransaction`. An `onlyIfTrusted` connect
 * (the silent auto-reconnect src/wallet.js fires on load) rejects, so a page
 * starts in its disconnected state and only connects on an explicit click.
 */
export async function installSolanaWallet(page, { address } = {}) {
	if (!address) throw new Error('installSolanaWallet needs an address');
	await page.addInitScript((addr) => {
		const pk = { toString: () => addr, toBase58: () => addr };
		let connected = false;
		const wallet = {
			isPhantom: true,
			get isConnected() {
				return connected;
			},
			get publicKey() {
				return connected ? pk : null;
			},
			async connect(opts) {
				// Silent reconnect probe — stay disconnected until a real click.
				if (opts && opts.onlyIfTrusted) throw new Error('not trusted');
				connected = true;
				return { publicKey: pk };
			},
			async disconnect() {
				connected = false;
			},
			async signMessage() {
				return { signature: new Uint8Array(64), publicKey: pk };
			},
			async signTransaction(tx) {
				return { serialize: () => tx.serialize() };
			},
			async signAllTransactions(txs) {
				return txs.map((tx) => ({ serialize: () => tx.serialize() }));
			},
			async signAndSendTransaction() {
				return { signature: '1'.repeat(88) };
			},
			on() {},
			off() {},
			removeListener() {},
		};
		window.solana = wallet;
		window.phantom = { solana: wallet };
	}, address);
}

/**
 * Install a synthetic MetaMask-compatible EVM wallet at window.ethereum.
 * `balanceHex` is the value `eth_call` (token balanceOf) returns — make it big
 * enough that the x402 pre-flight balance check passes.
 */
export async function installEvmWallet(page, { address, chainIdHex = '0x2105', balanceHex } = {}) {
	if (!address) throw new Error('installEvmWallet needs an address');
	const bal = balanceHex || '0x' + (10n ** 24n).toString(16);
	await page.addInitScript(
		({ addr, chain, balance }) => {
			window.ethereum = {
				isMetaMask: true,
				async request({ method }) {
					switch (method) {
						case 'eth_requestAccounts':
						case 'eth_accounts':
							return [addr];
						case 'eth_chainId':
							return chain;
						case 'eth_call':
							return balance; // ERC-20 balanceOf(owner)
						case 'eth_signTypedData_v4':
							return '0x' + 'ab'.repeat(65);
						case 'personal_sign':
							return '0x' + 'cd'.repeat(65);
						case 'wallet_switchEthereumChain':
						case 'wallet_addEthereumChain':
							return null;
						default:
							return null;
					}
				},
				on() {},
				removeListener() {},
			};
		},
		{ addr: address, chain: chainIdHex, balance: bal },
	);
}

/**
 * Serve a minimal same-origin HTML shell at `urlGlob`. Lets a spec `import()`
 * the real /src/* modules and make relative /api/* fetches without booting a
 * heavy product page — the harness pattern from coin-buy-trade.spec.js.
 */
export async function serveHarness(page, urlGlob, { title = 'e2e harness', body = '' } = {}) {
	await page.route(urlGlob, (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
		}),
	);
}

/**
 * Collect uncaught page errors, ignoring dev-only / live-feed noise (Vite HMR
 * socket, multiplayer WebSocket, aborted fetches, ResizeObserver chatter) that
 * is unrelated to the flow under test. Returns the array so a harness spec can
 * assert it stayed empty.
 */
export function collectPageErrors(page) {
	const errors = [];
	const NOISE =
		/websocket|wss?:|hmr|failed to fetch|load failed|networkerror|aborted|abort|resizeobserver|the user aborted|importing a module script failed/i;
	page.on('pageerror', (err) => {
		if (NOISE.test(err.message || '')) return;
		errors.push(err);
	});
	return errors;
}

/** A tiny valid 1×1 PNG as a Buffer — for file-upload inputs. */
export function tinyPng() {
	return Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
		'base64',
	);
}
