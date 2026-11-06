// Well-known Solana quote / stablecoin / liquid-staking mints that are NEVER a
// launched memecoin. These appear constantly in trade graphs — they are the
// quote side of swaps (USDC/USDT), wrapped or staked SOL, etc. — so any pipeline
// that indexes "every mint that traded" will pick them up. Treating one as a
// tradeable coin produces nonsense: e.g. USDC surfacing in the oracle's wins
// gallery as "$EPJFWD" with a 32,905,333× ATH multiple (its market cap divided
// by a fake entry price). Filter them out at ingestion and on every read path.
//
// Keyed by canonical mint address. Keep this the single source of truth — both
// the data brain (pump_coin_intel ingestion) and the oracle import from here.

export const QUOTE_MINTS = Object.freeze({
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
	'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
	'So11111111111111111111111111111111111111112':  'wSOL',
	'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':   'mSOL',
	'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn':  'jitoSOL',
	'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1':   'bSOL',
	'7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj':  'stSOL',
	'27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4':  'JLP',
	'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX':   'USDH',
	'2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo':  'PYUSD',
});

/** Address set for O(1) membership tests. */
const QUOTE_MINT_SET = new Set(Object.keys(QUOTE_MINTS));

/** Array form for SQL bindings: `where mint <> all(${QUOTE_MINT_LIST})`. */
export const QUOTE_MINT_LIST = Object.keys(QUOTE_MINTS);

/** True if `mint` is a known quote/stablecoin/LST mint that is not a coin. */
export function isQuoteMint(mint) {
	return !!mint && QUOTE_MINT_SET.has(mint);
}
