/**
 * pump-monitor task
 * -----------------
 * Navigates to a pump.fun coin page, watches for price and holder changes
 * via DOM mutation observation, and streams live frames + activity to the
 * three.ws watch panel.
 *
 * Usage:
 *   TASK=pump-monitor TASK_ARG=<mint_address> node index.js
 */

// DOM selectors — pump.fun layout as of 2025. Update if selectors break.
const SEL_PRICE        = '[data-testid="token-price"], .token-price, [class*="price"]';
const SEL_MARKET_CAP   = '[data-testid="market-cap"],  .market-cap,  [class*="marketCap"]';
const SEL_TX_ROW       = '[data-testid="tx-row"],      .tx-row,      [class*="transaction"]';
const POLL_INTERVAL_MS = 15_000; // fallback DOM poll when mutations miss

/**
 * @param {import('../caster.js').AgentScreenCaster} caster
 * @param {string} mint  Mint address of the coin to monitor
 */
export async function run(caster, mint) {
	if (!mint) {
		mint = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
		console.log('[pump-monitor] no mint provided, defaulting to $THREE');
	}

	const coinUrl = `https://pump.fun/coin/${mint}`;
	await caster.navigate(coinUrl);

	// Let the page settle before wiring observers.
	await caster.page.waitForTimeout(2000);

	// Expose a callback so the browser context can push activity back to us.
	await caster.page.exposeFunction('__onPriceChange', async (price, marketCap) => {
		try {
			await caster.pushActivity([{
				type:    'price_update',
				summary: `Price: ${price}${marketCap ? `  •  MCap: ${marketCap}` : ''}  — ${mint.slice(0, 8)}…`,
				ts:      Date.now(),
				payload: { price, marketCap, mint },
			}]);
		} catch {}
	});

	await caster.page.exposeFunction('__onNewTx', async (txSummary) => {
		try {
			await caster.pushActivity([{
				type:    'transaction',
				summary: txSummary,
				ts:      Date.now(),
				payload: { mint },
			}]);
		} catch {}
	});

	// Wire DOM observers inside the page.
	await caster.page.evaluate(({ selPrice, selMcap, selTx }) => {
		let lastPrice = '';
		let lastTxHtml = '';

		function readText(sel) {
			return document.querySelector(sel)?.textContent?.trim() || '';
		}

		function checkPrice() {
			const price = readText(selPrice);
			const mcap  = readText(selMcap);
			if (price && price !== lastPrice) {
				lastPrice = price;
				window.__onPriceChange(price, mcap);
			}
		}

		function checkTxs() {
			const rows = document.querySelectorAll(selTx);
			if (!rows.length) return;
			const firstHtml = rows[0]?.innerHTML || '';
			if (firstHtml && firstHtml !== lastTxHtml) {
				lastTxHtml = firstHtml;
				const text = rows[0]?.textContent?.trim().slice(0, 120) || 'New transaction';
				window.__onNewTx(text);
			}
		}

		const obs = new MutationObserver(() => { checkPrice(); checkTxs(); });
		obs.observe(document.body, { childList: true, subtree: true, characterData: true });

		// Run once immediately in case data is already present.
		checkPrice();
		checkTxs();
	}, { selPrice: SEL_PRICE, selMcap: SEL_MARKET_CAP, selTx: SEL_TX_ROW });

	// Periodically scroll + screenshot to keep the feed alive even when
	// mutations don't fire (e.g. infinite-scroll pagination).
	const keepAlive = setInterval(async () => {
		try {
			await caster.page.evaluate(() => window.scrollBy(0, 50));
			await caster.page.evaluate(() => window.scrollBy(0, -50));
		} catch {}
	}, POLL_INTERVAL_MS);

	// Handle page navigations away (pump.fun is a SPA; re-anchor if needed).
	caster.page.on('framenavigated', async (frame) => {
		if (frame !== caster.page.mainFrame()) return;
		const url = frame.url();
		if (!url.includes('/coin/')) {
			console.log('[pump-monitor] SPA nav away detected, returning to coin page');
			try { await caster.navigate(coinUrl); } catch {}
		}
	});

	console.log(`[pump-monitor] watching ${mint} — Ctrl-C to stop`);

	// Run until the process is terminated.
	await new Promise((_, reject) => {
		process.once('SIGTERM', () => { clearInterval(keepAlive); reject(new Error('SIGTERM')); });
		process.once('SIGINT',  () => { clearInterval(keepAlive); reject(new Error('SIGINT'));  });
	}).catch(() => {});

	clearInterval(keepAlive);
}
