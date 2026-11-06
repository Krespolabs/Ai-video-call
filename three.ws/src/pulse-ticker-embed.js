/**
 * Money Pulse ticker — drop-in embed.
 *
 * Auto-mounts the compact, real-data Money Pulse ticker into any element marked
 * `data-money-pulse-ticker` on the page, so the live money layer can sit on the
 * home, launches, or galaxy surfaces with zero per-page wiring:
 *
 *   <a class="..." data-money-pulse-ticker data-network="mainnet" href="/pulse"></a>
 *   <script type="module" src="/src/pulse-ticker-embed.js"></script>
 *
 * The ticker self-hides when the platform is quiet (no real events) — it never
 * shows a fabricated scroll. It pauses offscreen and on tab-hide via the shared
 * component.
 */

import { mountMoneyPulse } from './shared/money-pulse.js';

function mountAll() {
	for (const el of document.querySelectorAll('[data-money-pulse-ticker]')) {
		if (el.__mpTickerMounted) continue;
		el.__mpTickerMounted = true;
		const network = el.dataset.network === 'devnet' ? 'devnet' : 'mainnet';
		const type = el.dataset.type || 'all';
		mountMoneyPulse({ mount: el, variant: 'ticker', network, type, live: true });
	}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
else mountAll();
