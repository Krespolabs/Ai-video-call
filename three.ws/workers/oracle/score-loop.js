// Oracle worker — scoring augmentor.
//
// Walks the data brain's recent coins and ensures each has a fresh fused
// conviction verdict cached in oracle_conviction (classifying its narrative on
// first sight). This is what keeps the live feed warm and the agent loop fed.
// It does NOT ingest raw pump.fun data — the brain already has full coverage; it
// only adds the fusion + cultural read on top.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { scoreCoin } from '../../api/_lib/oracle/store.js';
import { QUOTE_MINT_LIST } from '../../api/_lib/quote-mints.js';

/** Mints that need (re)scoring: recent brain coins missing or stale in our cache. */
async function pendingMints(cfg) {
	const rows = await sql`
		select i.mint
		from pump_coin_intel i
		left join oracle_conviction c on c.mint = i.mint and c.network = ${cfg.network}
		where i.network = ${cfg.network}
		  and i.first_seen_at > now() - interval '12 hours'
		  and i.mint <> all(${QUOTE_MINT_LIST}::text[])
		  and (c.mint is null or c.scored_at < now() - (${cfg.rescoreAfterSec} || ' seconds')::interval)
		order by i.first_seen_at desc
		limit ${cfg.scoreBatch}
	`.catch((e) => { log.warn('pendingMints query failed:', e.message); return []; });
	return rows.map((r) => r.mint);
}

export async function runScorePass(cfg) {
	const mints = await pendingMints(cfg);
	if (!mints.length) return 0;
	let ok = 0;
	for (const mint of mints) {
		try {
			const r = await scoreCoin(mint, { network: cfg.network, classify: true, persist: true });
			if (r) ok += 1;
		} catch (e) {
			log.warn(`score ${mint} failed:`, e.message);
		}
	}
	if (ok) log.info(`scored ${ok}/${mints.length} coins`);
	return ok;
}
