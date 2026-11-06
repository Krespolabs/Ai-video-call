// BlockStore — durable persistence for each coin world's collaborative voxel
// build, so a community's creation survives both the room emptying (Colyseus
// disposes an idle room) and a full server restart/redeploy.
//
// Two tiers, layered:
//   1. In-process memory. The multiplayer server runs as a single always-on
//      instance (Cloud Run min=1/max=1), so this Map alone already makes a build
//      outlive the room — walk away, the room disposes, walk back tomorrow and
//      the same process rehydrates it. This is real persistence, not a cache of
//      convenience; it just doesn't survive the process dying.
//   2. Upstash Redis (REST), used when UPSTASH_REDIS_REST_URL + _TOKEN are set.
//      This upgrades durability across restarts and redeploys. Writes are
//      debounced (one network round-trip a few seconds after the last edit) and
//      flushed on room dispose, so a busy build doesn't hammer Redis.
//
// Each world is stored as a single JSON object under the key `walkblocks:<mint>`.
// A cell's value carries the block type AND the stable id of whoever placed it,
// so ownership (R19 build permissions) survives a room emptying and a server
// restart — without it, every restored build would be ownerless and unprotected.
// The on-wire form is a compact `[type, owner]` pair; a bare number is still
// accepted on load as a legacy (pre-ownership) cell. A world is hard-capped (see
// MAX_BLOCKS in WalkRoom), so the payload stays well within one Redis value.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const SAVE_DEBOUNCE_MS = 4000;
const KEY_PREFIX = 'walkblocks:';

function redisKey(coin) {
	// '' (the mainland lobby) gets its own stable bucket.
	return KEY_PREFIX + (coin || 'mainland');
}

// Normalize a persisted cell value into { t, o }. Accepts the current
// `[type, owner]` pair, a bare `type` number from pre-ownership saves (owner
// unknown → ''), or a `{ t, o }` object. Returns null for anything unparseable.
function decodeCell(v) {
	if (Array.isArray(v)) {
		const t = Number(v[0]);
		return Number.isInteger(t) ? { t, o: typeof v[1] === 'string' ? v[1] : '' } : null;
	}
	if (v && typeof v === 'object') {
		const t = Number(v.t);
		return Number.isInteger(t) ? { t, o: typeof v.o === 'string' ? v.o : '' } : null;
	}
	const t = Number(v);
	return Number.isInteger(t) ? { t, o: '' } : null;
}

class BlockStore {
	constructor() {
		this._mem = new Map();       // coin → Map(packedKey → { t:type, o:ownerId })
		this._saveTimers = new Map(); // coin → timeout handle
		this._redis = null;
		this._redisReady = null;
		// True only once a real round-trip to Redis has succeeded. We don't trust
		// "the client constructed" as proof of durability — bad credentials or a
		// network partition surface only on the first request, so a startup PING
		// confirms it. `durable` gates the WalkState.persistent flag the client
		// reads, so we never tell a builder their work is saved when it isn't.
		this._durable = false;
		// Count consecutive write failures so a Redis outage mid-session escalates
		// from a quiet warning to a loud one (and flips durability off) instead of
		// scrolling identical warnings forever.
		this._writeFailures = 0;
		if (REDIS_URL && REDIS_TOKEN) {
			// Lazy dynamic import so the dependency is only touched when configured.
			this._redisReady = import('@upstash/redis')
				.then(async ({ Redis }) => {
					this._redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
					// Confirm the credentials actually work before we advertise durability.
					await this._redis.ping();
					this._durable = true;
					console.log('[block-store] persistence: memory + Upstash Redis (verified)');
				})
				.catch((err) => {
					this._redis = null;
					console.error('[block-store] Redis unreachable — builds are MEMORY-ONLY and will not survive a restart:', err?.message);
				});
		} else {
			console.log('[block-store] persistence: memory-only (set UPSTASH_REDIS_REST_URL/_TOKEN for cross-restart durability)');
		}
	}

	// Has a real Redis round-trip succeeded? Drives WalkState.persistent so the
	// build HUD can honestly say whether a creation survives a server restart.
	get durable() { return this._durable; }

	// Resolves once the Redis readiness probe has settled (success or failure), so
	// callers can read `durable` with a definite answer. No-op when memory-only.
	async ready() { if (this._redisReady) await this._redisReady; }

	// Return the live Map for a coin, loading it from memory or Redis on first
	// access. Subsequent edits mutate this same Map in place.
	async load(coin) {
		if (this._mem.has(coin)) return this._mem.get(coin);
		const map = new Map();
		this._mem.set(coin, map);
		if (this._redisReady) {
			try {
				await this._redisReady;
				const raw = this._redis ? await this._redis.get(redisKey(coin)) : null;
				const obj = typeof raw === 'string' ? JSON.parse(raw) : raw; // Upstash may auto-parse JSON
				if (obj && typeof obj === 'object') {
					for (const [k, v] of Object.entries(obj)) {
						const rec = decodeCell(v);
						if (rec) map.set(k, rec);
					}
				}
			} catch (err) {
				console.warn(`[block-store] load failed for ${coin || 'mainland'}:`, err?.message);
			}
		}
		return map;
	}

	// In-memory edits + a debounced durable write. Synchronous so callers don't
	// await on the hot path of a place/break. `owner` is the stable id of the
	// placer (R19 ownership); '' for an ownerless/community cell.
	set(coin, key, type, owner = '') {
		const map = this._mem.get(coin);
		if (!map) return;
		map.set(key, { t: type, o: owner || '' });
		this._scheduleSave(coin);
	}

	delete(coin, key) {
		const map = this._mem.get(coin);
		if (!map) return;
		map.delete(key);
		this._scheduleSave(coin);
	}

	_scheduleSave(coin) {
		if (!this._redis && !this._redisReady) return; // memory-only: nothing to flush
		if (this._saveTimers.has(coin)) return;
		const handle = setTimeout(() => {
			this._saveTimers.delete(coin);
			this.flush(coin);
		}, SAVE_DEBOUNCE_MS);
		// Don't keep the event loop alive purely for a pending save.
		if (typeof handle.unref === 'function') handle.unref();
		this._saveTimers.set(coin, handle);
	}

	// Write the current world to Redis now. Called by the debounce timer and on
	// room dispose so the final state always lands. No-op without Redis.
	async flush(coin) {
		const pending = this._saveTimers.get(coin);
		if (pending) { clearTimeout(pending); this._saveTimers.delete(coin); }
		if (!this._redisReady) return;
		await this._redisReady;
		if (!this._redis) return;
		const map = this._mem.get(coin);
		if (!map) return;
		try {
			if (map.size === 0) {
				await this._redis.del(redisKey(coin));
			} else {
				const obj = {};
				for (const [k, rec] of map) {
					// Tolerate a raw-number value (a direct map mutation) as well as the
					// canonical { t, o } record, so the serialized form is always a
					// [type, owner] pair regardless of how the cell got into the map.
					const r = decodeCell(rec);
					if (r) obj[k] = [r.t, r.o || ''];
				}
				await this._redis.set(redisKey(coin), JSON.stringify(obj));
			}
			// A successful write proves durability is back; reset the failure streak.
			if (this._writeFailures > 0) {
				console.log(`[block-store] Redis writes recovered after ${this._writeFailures} failure(s)`);
				this._writeFailures = 0;
			}
			this._durable = true;
		} catch (err) {
			this._writeFailures++;
			// First failure: a clear error. After a few, the outage is sustained —
			// flip durability off so new rooms report memory-only to their builders.
			if (this._writeFailures >= 3) {
				this._durable = false;
				console.error(`[block-store] Redis save failing (${this._writeFailures}×) for ${coin || 'mainland'} — durability DEGRADED, builds at risk:`, err?.message);
			} else {
				console.warn(`[block-store] save failed for ${coin || 'mainland'}:`, err?.message);
			}
		}
	}

	// Flush every world that still holds in-memory state. Called on process
	// shutdown (SIGTERM on redeploy) so builds whose debounce timer hasn't fired
	// yet aren't lost between the last edit and the instance going away.
	async flushAll() {
		if (!this._redisReady) return;
		await Promise.allSettled([...this._mem.keys()].map((coin) => this.flush(coin)));
	}
}

// One store shared by every WalkRoom instance in the process — that shared
// memory is exactly what lets a build outlive its room.
export const blockStore = new BlockStore();
