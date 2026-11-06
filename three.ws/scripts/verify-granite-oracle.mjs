// Deploy-gated live check for the Granite Oracle.
//
//   node scripts/verify-granite-oracle.mjs [poolAddress]
//
// Always: verifies the keyless GeckoTerminal OHLCV path end-to-end (real candles).
// When WATSONX_API_KEY + WATSONX_PROJECT_ID are present: runs a REAL IBM Granite
// TimeSeries forecast, a Granite narration, and a Granite Guardian governance
// check, printing each result. No mocks — this exercises the production path.

import { fetchOhlcv, trendingPools } from '../api/_lib/market/ohlcv.js';
import { watsonxConfig, watsonxChatComplete } from '../api/_lib/watsonx.js';
import { watsonxForecast, forecastModelFor } from '../api/_lib/watsonx-forecast.js';
import { assessRisk, guardianConfig } from '../api/_lib/granite-guardian.js';

const log = (...a) => console.log(...a);
const iso = (t) => new Date(t * 1000).toISOString();

async function main() {
	log('▶ GeckoTerminal — trending Solana pools');
	const pools = await trendingPools('solana', 5);
	pools.forEach((p) => log(`   • ${p.name.padEnd(22)} ${p.pool}`));
	if (!pools.length) throw new Error('no trending pools returned');

	const pool = process.argv[2] || pools[0].pool;
	log(`\n▶ OHLCV for ${pool}`);
	const { candles, base, freq } = await fetchOhlcv({
		pool,
		timeframe: 'hour',
		aggregate: 1,
		limit: 1000,
	});
	log(
		`   ${candles.length} hourly candles · base=${base?.symbol} · freq=${freq} · last=$${candles.at(-1).c}`,
	);
	if (candles.length < 512) log('   ⚠ fewer than 512 candles — Granite TimeSeries needs ≥512');

	const cfg = watsonxConfig();
	if (!cfg.configured) {
		log('\n▶ watsonx not configured (WATSONX_API_KEY + WATSONX_PROJECT_ID unset).');
		log('   GeckoTerminal data path verified ✅. Set credentials to verify the live forecast.');
		return;
	}
	if (candles.length < 512) {
		log('\n   Skipping forecast — need ≥512 candles. Try a higher-volume pool.');
		return;
	}

	const slice = candles.slice(-512);
	const model = forecastModelFor(slice.length);
	log(`\n▶ IBM Granite TimeSeries forecast (${model})`);
	const fc = await watsonxForecast(cfg, {
		model,
		timestamps: slice.map((c) => iso(c.t)),
		values: slice.map((c) => c.c),
		freq,
		targetColumn: 'price',
	});
	const cur = slice.at(-1).c;
	const end = fc.values.at(-1);
	const pct = (((end - cur) / cur) * 100).toFixed(2);
	log(`   ${fc.values.length} steps · current $${cur} → forecast $${end} (${pct}%)`);

	log('\n▶ Granite narration');
	const n = await watsonxChatComplete(cfg, {
		messages: [
			{ role: 'system', content: 'You are a terse market oracle. One sentence, no advice.' },
			{
				role: 'user',
				content: `${base?.symbol}: current $${cur}, forecast end $${end} (${pct}%).`,
			},
		],
		maxTokens: 80,
	});
	log(`   "${n.text}"  [${n.model}]`);

	log('\n▶ Granite Guardian');
	const g = await assessRisk(guardianConfig(), { risk: 'harm', input: n.text });
	const pp = g.probability != null ? ` p=${g.probability.toFixed(3)}${g.estimated ? '~' : ''}` : '';
	log(`   risk=${g.risk} label=${g.label}${pp} → ${g.flagged ? 'FLAGGED' : 'PASS'}`);

	log('\n✅ Granite Oracle live path verified end-to-end.');
}

main().catch((e) => {
	console.error('❌', e.message);
	process.exit(1);
});
