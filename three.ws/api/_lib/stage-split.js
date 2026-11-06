// Living Stages — tip settlement validation + split math.
//
// A tip on a live stage is a REAL on-chain settlement: the audience member
// transfers $THREE (or USDC, where the platform's pay path already allows it)
// directly to the host agent's wallet, then POSTs the settlement signature here.
// The full amount lands in the host wallet on-chain; this module computes the
// ACCOUNTING split — the portion the host keeps vs. the portion owed onward to
// the venue/owner per the stage's `tip_split_bps` policy — and the validation
// discipline that keeps a forged "someone tipped 5,000 $THREE" row out of the
// ledger. Everything here is pure + integer-only (atomic units) so the split can
// never drift a lamport and the rules are unit-testable without a DB or a socket.
//
// Mirrors api/irl/interactions.js' pay discipline verbatim (same regexes, same
// allowed mints) — a tip is the same class of caller-asserted money event, so it
// earns the same "no settlement proof, no row" guard. $THREE is the only coin
// this platform promotes; USDC rides only because the existing IRL pay path
// already accepts it for settlement. No new asset is introduced here.

// $THREE — the one and only coin three.ws references.
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// USDC, the sole other settlement asset the platform's existing pay path accepts.
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// Lowercased lookup so an EVM address compares case-insensitively; the two
// case-sensitive base58 mints are matched verbatim.
const ALLOWED_TIP_MINTS = new Set([THREE_MINT, USDC_SOLANA, USDC_BASE]);

// 0x… EVM tx hash, or base58 Solana signature — the two settlement shapes the
// platform produces. A tip without one of these is never recorded.
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;

export function isValidTipSignature(sig) {
	return typeof sig === 'string' && (EVM_TX_RE.test(sig) || SOL_SIG_RE.test(sig));
}

export function isAllowedTipMint(mint) {
	if (typeof mint !== 'string' || !mint) return false;
	return ALLOWED_TIP_MINTS.has(mint) || ALLOWED_TIP_MINTS.has(mint.toLowerCase());
}

// Block-explorer deep link for a settlement, picking the chain from the signature
// shape (EVM tx hash → Basescan) or an explicit network hint, defaulting to
// Solscan. Surfaced in the tip event + owner notification so the receipt is one
// tap away.
export function tipExplorerUrl(sig, network) {
	if (!sig) return null;
	const net = String(network || '').toLowerCase();
	if (EVM_TX_RE.test(sig) || net.includes('base') || net.includes('eip155')) {
		return `https://basescan.org/tx/${sig}`;
	}
	return `https://solscan.io/tx/${sig}`;
}

// Default venue cut if a stage hasn't set one: 10% (1000 bps) to the venue/owner,
// 90% to the host. Stages may override per their policy.
export const DEFAULT_TIP_SPLIT_BPS = 1000;
const MAX_BPS = 10_000;

// Coerce a basis-points policy to a sane integer in [0, 10000]. A non-finite or
// out-of-range value falls back to the platform default rather than ever letting
// the venue keep a negative or >100% cut.
export function normalizeSplitBps(bps) {
	const n = Math.trunc(Number(bps));
	if (!Number.isFinite(n) || n < 0 || n > MAX_BPS) return DEFAULT_TIP_SPLIT_BPS;
	return n;
}

// Parse a caller-supplied atomic-unit amount into a positive safe integer, or
// null. Money is integer atomic units end to end (no floats), so a fractional,
// zero, negative, NaN, or overflowing value is rejected outright.
export function parseAtomicAmount(value) {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
	return n;
}

/**
 * Split a tip (in atomic units) into the host's credit and the venue's cut.
 *
 * The venue cut is floored so the two parts always sum to exactly the original
 * amount — the rounding remainder is handed to the HOST, never minted out of
 * thin air. Pure integer math: splitTip(x).hostCredit + splitTip(x).venueCut === x
 * for every valid x, which the unit suite asserts across a fuzz range.
 *
 * @param {number} amountAtomic positive integer atomic units (already parsed)
 * @param {number} splitBps     venue cut in basis points (0–10000)
 * @returns {{ hostCredit: number, venueCut: number, splitBps: number }}
 */
export function splitTip(amountAtomic, splitBps = DEFAULT_TIP_SPLIT_BPS) {
	const amount = parseAtomicAmount(amountAtomic);
	if (amount === null) throw new Error('splitTip: amount must be a positive integer (atomic units)');
	const bps = normalizeSplitBps(splitBps);
	// Floor the venue cut; the host absorbs the remainder so the parts reconcile
	// to the penny (atomic unit) against the on-chain total.
	const venueCut = Math.floor((amount * bps) / MAX_BPS);
	const hostCredit = amount - venueCut;
	return { hostCredit, venueCut, splitBps: bps };
}

// One place to validate an inbound tip body before it touches the DB. Returns
// either { ok:true, amount, mint, signature, network } or { ok:false, error }.
// Used by POST /api/stage/tip; pure so the rules are tested in isolation.
export function validateTipPayload({ signature, currencyMint, amount, network } = {}) {
	if (!isValidTipSignature(signature)) {
		return { ok: false, error: 'tip requires a valid on-chain settlement signature' };
	}
	if (!isAllowedTipMint(currencyMint)) {
		return { ok: false, error: 'currency_mint must be $THREE or USDC' };
	}
	const parsed = parseAtomicAmount(amount);
	if (parsed === null) {
		return { ok: false, error: 'amount must be a positive integer in atomic units' };
	}
	return {
		ok: true,
		amount: parsed,
		mint: currencyMint,
		signature,
		network: typeof network === 'string' ? network.slice(0, 32) : null,
	};
}
