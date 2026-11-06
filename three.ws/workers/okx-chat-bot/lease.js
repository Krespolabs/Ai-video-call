// okx-chat-bot: the single-writer lease.
//
// The bot's identity (the wallet keyring plus the XMTP client database) is one
// state object with exactly one legal writer. `--max-instances=1` was the only
// thing enforcing that, and it does not: Cloud Run applies max instances PER
// REVISION, and a rollout deliberately runs the new revision's instance next to
// the old one until the new one is Ready and traffic has moved. For that window
// two daemons would hold the same XMTP installation, and the old instance's
// SIGTERM snapshot would then overwrite whatever the new one had written. A torn
// identity costs a human email OTP to recover.
//
// So a host must hold this lease before it restores state, starts the daemon or
// writes a snapshot, and must keep renewing it to keep doing any of those. The
// lease is a row in the `bot_heartbeat` table the worker already writes (worker
// = LEASE_KEY), so it needs no new table, no migration and no new credential.
// Every transition is one conditional statement, so two hosts racing for it
// cannot both win.
//
// A rollout therefore sequences itself:
//
//   1. The new instance boots, serves /healthz (so Cloud Run's startup probe
//      passes and the rollout can proceed) and waits, reporting `lease_wait`.
//   2. Cloud Run moves traffic and SIGTERMs the old instance, which stops its
//      daemon, writes its final snapshot while it still holds the lease, and
//      releases it.
//   3. The new instance takes the lease, restores THAT snapshot, and only then
//      starts its daemon.
//
// A host that dies without releasing is waited out for LEASE_TTL. A host that
// cannot renew (its database is unreachable) fences itself before the TTL can
// expire under it: it stops the daemon and exits WITHOUT snapshotting, because
// by then another host may legitimately be writing.
//
// Hosts built before this lease existed never take it. They are recognised by
// their heartbeat, which carries no `leaseHolder`: while such a host is still
// beating, nobody may take the lease. That is what makes the first rollout onto
// this code as safe as every later one.

import { randomUUID } from 'node:crypto';
import { log } from './log.js';

export const LEASE_KEY = 'okx-chat-bot:lease';
const HEARTBEAT_WORKER = 'okx-chat-bot';

/**
 * The lease's storage: one `bot_heartbeat` row, driven by conditional upserts.
 * Every clock comparison uses the database's now(), so two hosts with skewed
 * clocks still agree on whether the lease has expired.
 *
 * @param {Function} sql tagged-template client (api/_lib/db.js)
 * @param {string} [key]
 */
export function sqlLeaseStore(sql, key = LEASE_KEY) {
	return {
		/** Take the lease if it is free, expired, released, or already ours. */
		async acquire(holder, ttlSec, meta = {}) {
			const row = JSON.stringify({ ...meta, holder });
			const won = await sql`
				INSERT INTO bot_heartbeat (worker, mode, last_beat_at, meta)
				VALUES (${key}, 'lease', now(), ${row}::jsonb)
				ON CONFLICT (worker) DO UPDATE
				SET last_beat_at = now(), meta = excluded.meta
				WHERE bot_heartbeat.meta->>'holder' = ${holder}
				   OR bot_heartbeat.meta->>'released' = 'true'
				   OR bot_heartbeat.last_beat_at < now() - (${ttlSec}::int * interval '1 second')
				RETURNING worker
			`;
			if (won.length) return { acquired: true };
			const [cur] = await sql`
				SELECT meta, extract(epoch FROM now() - last_beat_at)::float8 AS age_s
				FROM bot_heartbeat WHERE worker = ${key}
			`;
			return {
				acquired: false,
				holder: cur?.meta?.holder ?? null,
				host: cur?.meta?.host ?? null,
				ageSec: cur ? Number(cur.age_s) : null,
			};
		},
		/** Extend the lease. False means it is no longer ours. */
		async renew(holder) {
			const rows = await sql`
				UPDATE bot_heartbeat SET last_beat_at = now()
				WHERE worker = ${key} AND meta->>'holder' = ${holder}
				  AND coalesce(meta->>'released', '') <> 'true'
				RETURNING worker
			`;
			return rows.length > 0;
		},
		/** Hand the lease to whoever is waiting, without waiting out the TTL. */
		async release(holder) {
			await sql`
				UPDATE bot_heartbeat
				SET meta = meta || '{"released": true}'::jsonb, last_beat_at = now()
				WHERE worker = ${key} AND meta->>'holder' = ${holder}
			`;
		},
		/** The serving host's own heartbeat, for recognising a pre-lease host. */
		async hostBeat() {
			const [row] = await sql`
				SELECT meta->>'host' AS host, meta->>'leaseHolder' AS lease_holder,
				       extract(epoch FROM now() - last_beat_at)::float8 AS age_s
				FROM bot_heartbeat WHERE worker = ${HEARTBEAT_WORKER}
			`;
			return row ? { host: row.host ?? null, leaseAware: !!row.lease_holder, ageSec: Number(row.age_s) } : null;
		},
	};
}

/**
 * Does a host that predates the lease still look alive?
 *
 * Returns the reason to keep waiting, or null when the heartbeat is no obstacle:
 * absent, stale, written by a lease-aware host (the lease itself then governs),
 * or written by this same host label (a previous process of this revision, which
 * is dead: a revision never runs two instances).
 *
 * @param {{ host: string|null, leaseAware: boolean, ageSec: number }|null} beat
 * @param {{ selfHost: string, staleSec: number }} opts
 * @returns {string|null}
 */
export function legacyWriterBlocks(beat, { selfHost, staleSec }) {
	if (!beat) return null;
	if (beat.leaseAware) return null;
	if (beat.host && beat.host === selfHost) return null;
	if (!Number.isFinite(beat.ageSec) || beat.ageSec >= staleSec) return null;
	return `${beat.host || 'an unnamed host'} predates the single-writer lease and beat ${Math.round(beat.ageSec)}s ago`;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof sqlLeaseStore>} opts.store
 * @param {string} opts.host        this host's label (config.resolveHost)
 * @param {number} opts.ttlMs       how long an unrenewed lease stays taken
 * @param {number} opts.renewMs     renewal cadence; must be well inside ttlMs
 * @param {number} opts.pollMs      how often a waiting host asks again
 * @param {number} opts.legacyStaleMs how old a pre-lease host's beat must be to ignore it
 * @param {(reason: string) => void} [opts.onLost]  called once when the lease is gone
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {string} [opts.holder]
 */
export function createLease({
	store,
	host,
	ttlMs,
	renewMs,
	pollMs,
	legacyStaleMs,
	onLost = () => {},
	now = Date.now,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	holder = `${host}#${randomUUID()}`,
}) {
	if (!(renewMs * 2 < ttlMs)) throw new Error(`lease renewMs (${renewMs}) must be under half of ttlMs (${ttlMs})`);
	const ttlSec = Math.ceil(ttlMs / 1000);
	const state = { holder, held: false, acquiredAt: 0, lastRenewAt: 0, waitingOn: null, lostReason: null };
	let timer = null;
	let renewing = false;
	let lostFired = false;

	function lose(reason) {
		if (lostFired) return;
		lostFired = true;
		state.held = false;
		state.lostReason = reason;
		if (timer) clearInterval(timer);
		timer = null;
		log.error('single-writer lease lost', { holder, reason });
		onLost(reason);
	}

	async function renewOnce() {
		if (!state.held || renewing) return;
		renewing = true;
		try {
			if (await store.renew(holder)) state.lastRenewAt = now();
			else lose('another host holds the lease');
		} catch (err) {
			// A database blip is not a lost lease, but an unrenewable one is about to
			// expire under us. Fence before it can: the renewal margin is exactly the
			// time left before another host may legitimately take it.
			const silentMs = now() - state.lastRenewAt;
			log.warn('lease renew failed', { holder, err: err?.message, silentMs });
			if (silentMs >= ttlMs - renewMs) lose(`could not renew for ${Math.round(silentMs / 1000)}s`);
		} finally {
			renewing = false;
		}
	}

	return {
		state,

		/**
		 * Block until this host holds the lease. Resolves false only when aborted.
		 * @param {{ signal?: AbortSignal, onWait?: (reason: string) => void }} [opts]
		 */
		async acquire({ signal, onWait = () => {} } = {}) {
			let lastLogged = null;
			while (!signal?.aborted) {
				let reason = null;
				try {
					reason = legacyWriterBlocks(await store.hostBeat(), { selfHost: host, staleSec: legacyStaleMs / 1000 });
					if (!reason) {
						const r = await store.acquire(holder, ttlSec, { host, since: new Date(now()).toISOString() });
						if (r.acquired) {
							state.held = true;
							state.acquiredAt = now();
							state.lastRenewAt = now();
							state.waitingOn = null;
							log.info('single-writer lease acquired', { holder });
							return true;
						}
						reason = `${r.host || r.holder || 'another host'} holds the lease (renewed ${Math.round(r.ageSec ?? 0)}s ago)`;
					}
				} catch (err) {
					reason = `lease store unreachable: ${err?.message || err}`;
				}
				state.waitingOn = reason;
				onWait(reason);
				if (reason !== lastLogged) {
					log.warn('waiting for the single-writer lease', { holder, reason });
					lastLogged = reason;
				}
				await sleep(pollMs);
			}
			return false;
		},

		/** Start renewing. Call once, right after acquire() resolves true. */
		start() {
			if (timer || !state.held) return;
			timer = setInterval(() => void renewOnce(), renewMs);
			if (typeof timer.unref === 'function') timer.unref();
		},

		/** Exposed for tests and for a caller that wants one renewal now. */
		renewOnce,

		/**
		 * True while this host may write shared state. Stricter than `held`: a
		 * lease whose last renewal is older than the fencing margin is treated as
		 * already gone, so no snapshot is ever written on a lease that may have
		 * expired in the database.
		 */
		fresh() {
			return state.held && now() - state.lastRenewAt < ttlMs - renewMs;
		},

		/** Stop renewing and hand the lease over. Best effort: a failure just leaves it to expire. */
		async release() {
			if (timer) clearInterval(timer);
			timer = null;
			if (!state.held) return;
			state.held = false;
			try {
				await store.release(holder);
				log.info('single-writer lease released', { holder });
			} catch (err) {
				log.warn('lease release failed: it will expire on its TTL', { holder, err: err?.message });
			}
		},
	};
}
