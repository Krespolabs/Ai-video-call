/*
 * Sperax preset — "Sperax — DeFi protocol tour"
 * ===============================================
 * A ready-made Tour Builder template for Sperax (sperax.io / usds.sperax.io),
 * three.ws's first DeFi partner deployment. Loading this template into the
 * builder swaps the working tour for these 8 stops; the merchant (Sperax) can
 * then edit, preview the walking/spotlight mechanics, and export the real
 * snippet exactly like a hand-built tour.
 *
 * Selector provenance (read this before re-pinning anything)
 * ------------------------------------------------------------
 * Every `targets` chain below was derived from the REAL, fetched DOM of
 * https://usds.sperax.io (curl'd 2026-07-08, HTTP 200) — the actual USDs
 * marketing site, which is what a visitor lands on and what Sperax would embed
 * the tour tag on. It's built with Framer, whose layer names are exposed as a
 * `data-framer-name` attribute on the rendered elements — e.g.
 * `data-framer-name="Why Choose USDs?"`. Those names are set by the Sperax
 * design team in the Framer canvas and are far more stable across republishes
 * than Framer's auto-generated CSS class hashes (which rotate on every
 * publish), so they're used as the primary selector for every stop. Each stop
 * also carries a secondary selector — a neighboring, independently-verified
 * `data-framer-name` block — so a single renamed layer doesn't blank the stop.
 * If both selectors miss, @three-ws/tour's own built-in fallback chain takes
 * over (`_resolveTarget` in tour-sdk/src/director.js): it tries
 * `[data-tour-target]`, then the page's `h1` / primary CTA, and finally
 * highlights nothing and narrates anyway — it never hard-fails a stop. See
 * `tour-sdk/test/director.test.mjs` for the test that pins that behavior.
 *
 * `https://app.sperax.io` — the connected-wallet dashboard where minting,
 * redeeming, veSPA staking, and farm deposits actually execute — returned an
 * HTTP 403 Cloudflare JS challenge from this sandbox (non-interactive, so the
 * challenge can't be solved here) and could not be fetched. The "Stake SPA for
 * veSPA" and "Get started" stops below therefore target the verified
 * `Launch App` button on usds.sperax.io (real, fetched: both a
 * `data-framer-name="Launch App"` layer and an `a[href="https://app.sperax.io/"]`
 * anchor exist in the fetched HTML) rather than a guessed dashboard selector.
 * Once Sperax gives a contributor authenticated access to app.sperax.io, those
 * two stops' `targets` should be re-pinned to the real staking-page and
 * mint/redeem-page elements — the narration is already accurate (verified
 * against docs.sperax.io/staking-protocol.md and
 * docs.sperax.io/getting-started-on-our-dapp/minting-and-redeeming-usds.md),
 * only the selectors are a documented placeholder.
 *
 * Narration facts are sourced from, in order of trust: the live fetched DOM
 * text of usds.sperax.io, then docs.sperax.io's published protocol docs
 * (master.md, master/auto-yield.md, staking-protocol.md,
 * sperax-farms-protocol.md, buyback-contract.md, governance.md — all fetched
 * 2026-07-08), then `_prompts/sperax/ref/sperax-protocol/types.ts` for API
 * terminology. No figure in the narration is invented.
 */

export const SPERAX_TEMPLATE = {
	id: 'sperax',
	name: 'Sperax — DeFi protocol tour',
	blurb: 'An 8-stop guided tour of USDs, Sperax’s auto-yield stablecoin — minting, the yield source, SPA staking, and farms.',
	title: 'Sperax — DeFi protocol tour',
	mode: 'guided',
	avatarId: 'realistic-female',
	// Rendered as a note in the builder + carried into the export modal — the
	// builder's own demo store obviously doesn't have these selectors, so
	// Preview here demonstrates the walking/spotlight/narration mechanics
	// against the sandbox; the true test is the exported snippet on
	// usds.sperax.io itself.
	previewNote:
		'This template targets usds.sperax.io’s real DOM. Preview here shows the guide walking, spotlighting, and narrating on our demo store — the mechanics are identical, but the actual sections only exist on Sperax’s site. Export the snippet and drop it into usds.sperax.io to see the real thing.',
	sections: [
		{
			id: 'overview',
			title: 'Sperax at a glance',
			intro:
				'Welcome — I’m here to walk you through Sperax and USDs, its auto-yield stablecoin that’s been live on Arbitrum since 2019.',
		},
		{
			id: 'usds',
			title: 'How USDs works',
			intro:
				'USDs isn’t a slideshow — it’s a real yield engine. Let’s see how minting, redeeming, and the yield itself actually work.',
		},
		{
			id: 'spa',
			title: 'SPA, farms & getting started',
			intro:
				'Beyond USDs there’s SPA — Sperax’s governance token — plus Farms for extra yield. Let’s finish with how to get started.',
		},
	],
	stops: [
		{
			id: 'sperax-hero',
			section: 'overview',
			title: 'What Sperax is',
			narration:
				'Sperax has been building on Arbitrum since 2019 — through every market cycle, fully audited, and governed by its own DAO. USDs, its auto-yield stablecoin, is where the story starts.',
			highlight: true,
			// Primary: the hero block's Framer layer name (verified). Secondary:
			// the page's <header>, present on every render of the site.
			targets: ['[data-framer-name="Hero section"]', 'header'],
			targetLabel: 'Hero section (usds.sperax.io)',
		},
		{
			id: 'sperax-auto-yield',
			section: 'usds',
			title: 'USDs: yield with zero extra steps',
			narration:
				'USDs is a stablecoin that pays you just for holding it. No staking, no claiming, no dashboards — the yield shows up as a bigger wallet balance automatically, roughly once a day.',
			highlight: true,
			targets: [
				'[data-framer-name="Native Yield with Zero Extra Steps"]',
				'[data-framer-name="Stablecoin with built-in Auto-Yield on Arbitrum"]',
			],
			targetLabel: '“Native Yield with Zero Extra Steps” (usds.sperax.io)',
		},
		{
			id: 'sperax-why',
			section: 'overview',
			title: 'Why holders choose USDs',
			narration:
				'Three things holders keep coming back for: effortless income that compounds on its own, security-first engineering, and instant withdrawals — your USDs are never locked up.',
			highlight: false,
			targets: ['[data-framer-name="Why Choose USDs?"]', '[data-framer-name="Discover the benefits of USDs"]'],
			targetLabel: '“Why Choose USDs?” (usds.sperax.io)',
		},
		{
			id: 'sperax-mint-redeem',
			section: 'usds',
			title: 'Minting & redeeming',
			narration:
				'Deposit USDC, USDT, or USDC.e and mint USDs against it, roughly one-for-one. Ready to exit? Redeem USDs back for the collateral of your choice — no lockups, no waiting.',
			highlight: true,
			targets: [
				'[data-framer-name="Deposit USDT, USDC.e & USDC collaterals to get USDs in your wallet"]',
				'[data-framer-name="Mint USDs Using Other Tokens in Your Wallet"]',
			],
			targetLabel: '“Deposit USDT, USDC.e & USDC collaterals…” (usds.sperax.io)',
		},
		{
			id: 'sperax-yield-source',
			section: 'usds',
			title: 'Where the yield comes from',
			narration:
				'Your collateral doesn’t sit idle — it’s deployed across audited lending and liquidity protocols like Aave, Compound, and Stargate. About 70% of what it earns flows back to USDs holders automatically; the rest funds SPA buybacks.',
			highlight: false,
			targets: ['[data-framer-name="Smart Yield Made Simple"]', '[data-framer-name="Historical Revenue Growth"]'],
			targetLabel: '“Smart Yield Made Simple” (usds.sperax.io)',
		},
		{
			id: 'sperax-vespa',
			section: 'spa',
			title: 'Stake SPA for veSPA',
			narration:
				'Lock SPA, Sperax’s governance token, to receive veSPA — non-transferable voting power that also earns you a cut of protocol fees and yield. Lock longer, get more veSPA and a bigger share.',
			highlight: true,
			// app.sperax.io (the staking dashboard) is Cloudflare-gated and
			// unreachable from this sandbox — both selectors point at the
			// verified "Launch App" CTA on usds.sperax.io instead. Re-pin to the
			// real staking-page DOM once you have authenticated access.
			targets: ['[data-framer-name="Launch App"]', 'a[href="https://app.sperax.io/"]'],
			targetLabel: 'Launch App button (usds.sperax.io) — re-pin to app.sperax.io’s staking page when reachable',
		},
		{
			id: 'sperax-farms',
			section: 'spa',
			title: 'Farms — extra yield on LP tokens',
			narration:
				'Prefer more upside? Provide liquidity and stake your LP tokens in a Sperax Farm — some pools pay up to 100% APR. Sperax Farms even lets other DAOs launch their own farms with zero code.',
			highlight: false,
			targets: [
				'[data-framer-name="Provide Liquidity"]',
				'[data-framer-name="Stake your liquidity pool tokens in our designated farms to earn upto 100% APR."]',
			],
			targetLabel: '“Provide Liquidity” (usds.sperax.io)',
		},
		{
			id: 'sperax-get-started',
			section: 'spa',
			title: 'Get started',
			narration:
				'That’s the loop — deposit, hold, earn, exit whenever you want. Hit Launch App to connect your wallet and mint your first USDs.',
			highlight: true,
			targets: ['[data-framer-name="Launch App"]', 'a[href="https://app.sperax.io/"]'],
			targetLabel: 'Launch App button (usds.sperax.io)',
		},
	],
};
