/**
 * Trade Safety Firewall — public read-only API.
 *
 *   GET /api/pump/safety?mint=<mint>&network=<net>&amount=<sol>
 *
 * Returns the same pre-trade verdict the autonomous sniper and the discretionary
 * trade endpoints enforce: a real SPL authority audit + a real on-chain simulated
 * buy→sell round-trip (honeypot detection) + structural intel, composed into
 * { verdict: 'allow'|'warn'|'block', score, checks[], simulated, reasons[] }.
 *
 * Public, IP rate-limited, briefly cached. No auth needed to read — anyone can
 * check whether a coin can actually be sold before they buy it. The verdict is
 * recorded to firewall_decisions for observability. `amount` (in SOL) sizes the
 * simulated buy; it defaults to a small probe so the round-trip stays cheap.
 *
 * $THREE is the only coin three.ws promotes — this surface assesses whatever
 * runtime mint the caller supplies and never names or recommends any token.
 */

import { cors, json, method, error, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { assessTradeSafety, recordFirewallDecision } from '../_lib/trade-firewall.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_PROBE_SOL = 0.05; // small, real round-trip probe
const MAX_PROBE_SOL = 50;

function netOf(v) {
	return v === 'devnet' ? 'devnet' : 'mainnet';
}

function solToLamports(sol) {
	const n = Number(sol);
	if (!Number.isFinite(n) || n <= 0) return null;
	const clamped = Math.min(MAX_PROBE_SOL, n);
	// Integer lamports without float drift on the whole part.
	const [whole, frac = ''] = String(clamped).split('.');
	const fracPad = (frac + '000000000').slice(0, 9);
	try {
		return BigInt(whole || '0') * LAMPORTS_PER_SOL + BigInt(fracPad || '0');
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const mint = (url.searchParams.get('mint') || '').trim();
	const network = netOf(url.searchParams.get('network'));
	const amount = url.searchParams.get('amount');

	if (!BASE58_RE.test(mint)) {
		return error(res, 400, 'invalid_mint', 'mint must be a base58 Solana address');
	}

	const lamports = solToLamports(amount) ?? solToLamports(DEFAULT_PROBE_SOL);

	const assessment = await assessTradeSafety({
		network,
		mint,
		side: 'buy',
		quoteAmount: lamports,
		// No payer on the public read path → the round-trip simulation degrades to
		// a `skip` (it needs a payer pubkey for the ix builders). The authority +
		// venue + intel checks still run and gate the verdict honestly.
	});

	// Record the verdict for observability (fire-and-forget; never blocks the read).
	recordFirewallDecision({
		mint, network, side: 'buy',
		verdict: assessment.verdict, score: assessment.score, simulated: assessment.simulated,
		checks: assessment.checks, reasons: assessment.reasons,
		source: 'api', quoteLamports: lamports, enforced: false,
	}).catch(() => {});

	return json(
		res,
		200,
		{
			mint,
			network,
			probe_sol: Number(lamports) / 1e9,
			verdict: assessment.verdict,
			score: assessment.score,
			simulated: assessment.simulated,
			reasons: assessment.reasons,
			checks: assessment.checks,
		},
		{ 'cache-control': 'public, max-age=20, stale-while-revalidate=40' },
	);
});
