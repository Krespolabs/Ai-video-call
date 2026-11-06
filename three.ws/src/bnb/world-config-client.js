/**
 * Browser fetcher for GET /api/bnb/world-config (prompt 16). Small, cached
 * per network for the page's lifetime — the address changes only on a real
 * redeploy, never mid-session.
 */

const cache = new Map(); // network -> Promise<config>

/**
 * @param {'bscTestnet'|'bscMainnet'} [network]
 * @returns {Promise<{ network:string, chainId:number, address:string|null, deployed:boolean, explorer:string, rpcs:string[], worldId:number }>}
 */
export function fetchWorldConfig(network = 'bscTestnet') {
	if (cache.has(network)) return cache.get(network);
	const netParam = network === 'bscMainnet' ? 'mainnet' : 'testnet';
	const promise = fetch(`/api/bnb/world-config?network=${netParam}`, { headers: { accept: 'application/json' } })
		.then(async (res) => {
			if (!res.ok) throw new Error(`world-config returned ${res.status}`);
			return res.json();
		})
		.catch((err) => {
			cache.delete(network); // a failed fetch must not poison the cache — retry next call
			throw err;
		});
	cache.set(network, promise);
	return promise;
}
