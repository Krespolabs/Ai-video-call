// $THREE on DEXTools: the pair the market trades, and the Social Boost prizes
// the community has won there.
//
// Social Boost ranks tokens by daily and weekly visits to their DEXTools pair
// page. The top token wins a buyback: DEXTools buys it on the open market and
// holds it. Every win below is a real prize with a public receipt, either
// DEXTools' own winner page for that day (the pair URL with a `social-boost`
// query) or its announcement post. DEXTools publishes no API for past winners,
// so a new win is recorded here by hand, newest first, with its receipt.

/** The three / SOL pool DEXTools tracks $THREE under. Social Boost receipts are keyed to it. */
export const THREE_DEXTOOLS_PAIR = 'CnK82s8exdsK9nwqQ55kd9wcxoA22NwTchZJCBdu8LDa';

export const DEXTOOLS_PAIR_URL = `https://www.dextools.io/app/solana/pair-explorer/${THREE_DEXTOOLS_PAIR}`;
export const SOCIAL_BOOST_LEADERBOARD_URL = 'https://www.dextools.io/app/social-boost';
export const SOCIAL_BOOST_STORY_PATH = '/blog/three-ws-dextools-social-boost-buyback';

const WEEKLY_ANNOUNCEMENT_URL = 'https://x.com/DEXToolsApp/status/2064037499060555807';
const dailyReceipt = (date) => `${DEXTOOLS_PAIR_URL}?social-boost=daily-${date}`;

/**
 * @typedef {object} SocialBoostWin
 * @property {'daily'|'weekly'} period
 * @property {string} date      ISO day the prize was awarded.
 * @property {number} prizeUsd  Size of the buyback DEXTools executed.
 * @property {string} receipt   Public page proving the win.
 */

/** @type {SocialBoostWin[]} Newest first. */
export const SOCIAL_BOOST_WINS = [
	{ period: 'weekly', date: '2026-06-08', prizeUsd: 5543, receipt: WEEKLY_ANNOUNCEMENT_URL },
	{ period: 'daily', date: '2026-06-06', prizeUsd: 3649, receipt: dailyReceipt('2026-06-06') },
	{ period: 'daily', date: '2026-06-04', prizeUsd: 2190, receipt: dailyReceipt('2026-06-04') },
];

/** What DEXTools reported holding after the weekly win, in its own announcement. */
export const DEXTOOLS_HOLDING = { tokens: 2_470_000, asOf: '2026-06-08', source: WEEKLY_ANNOUNCEMENT_URL };

/** Headline numbers for the wins card. */
export function socialBoostSummary(wins = SOCIAL_BOOST_WINS) {
	return {
		count: wins.length,
		totalUsd: wins.reduce((sum, w) => sum + w.prizeUsd, 0),
		largestUsd: wins.reduce((max, w) => Math.max(max, w.prizeUsd), 0),
	};
}
