// GET /api/agent/activity — recent on-chain transfers (incoming + outgoing) for
// the avatar's custodial wallet, so the widget can REACT when it receives funds
// (not just when it sends). This is what lets a 3D avatar notice a tip land in
// real time and thank you on-chain.
//
// Read-only: it never touches the signing secret — it resolves the public
// address from config and reads the chain. Real Solana data (getSignaturesFor-
// Address + parsed transactions); no mocks, no sample feed.

import { cors, json, method, wrap } from '../_lib/http.js';
import { clampInt } from '../_lib/http-params.js';
import {
	avatarWalletConfig,
	getConnection,
	solUsdPrice,
	explorerTxUrl,
	explorerAccountUrl,
	LAMPORTS_PER_SOL,
	PublicKey,
} from '../_lib/avatar-wallet.js';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// Pull the human-readable memo (if any) out of a parsed transaction. The SPL
// Memo program surfaces as a `spl-memo` instruction whose `parsed` field is the
// string; fall back to the raw memo the signatures API returns ("[len] text").
function extractMemo(tx, rawMemo) {
	const ix = tx?.transaction?.message?.instructions || [];
	for (const i of ix) {
		if (i.program === 'spl-memo' && typeof i.parsed === 'string') return i.parsed;
		if (i.programId?.toBase58?.() === MEMO_PROGRAM_ID && typeof i.parsed === 'string') return i.parsed;
	}
	if (rawMemo) return String(rawMemo).replace(/^\[\d+\]\s*/, '');
	return null;
}

// The avatar wallet's net lamport change in a tx, and the counterparty (the
// account that moved the most in the opposite direction).
function settle(tx, ownerAddress) {
	const meta = tx?.meta;
	const keys = (tx?.transaction?.message?.accountKeys || []).map((k) =>
		k?.pubkey?.toBase58 ? k.pubkey.toBase58() : String(k),
	);
	const idx = keys.indexOf(ownerAddress);
	if (idx < 0 || !meta?.preBalances || !meta?.postBalances) return null;

	let delta = meta.postBalances[idx] - meta.preBalances[idx]; // signed lamports
	if (delta === 0) return null;
	// When the wallet is the fee payer (account 0) on an outgoing transfer, the
	// delta includes the network fee — back it out so the amount reads as the
	// true transfer, not transfer+fee.
	if (delta < 0 && idx === 0 && Number.isFinite(meta.fee)) delta += meta.fee;

	let cpIdx = -1;
	let best = 0;
	for (let j = 0; j < keys.length; j++) {
		if (j === idx) continue;
		const d = meta.postBalances[j] - meta.preBalances[j];
		if (Math.sign(d) === -Math.sign(delta) && Math.abs(d) > best) {
			best = Math.abs(d);
			cpIdx = j;
		}
	}
	return {
		direction: delta > 0 ? 'in' : 'out',
		sol: Math.abs(delta) / LAMPORTS_PER_SOL,
		counterparty: cpIdx >= 0 ? keys[cpIdx] : null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const cfg = avatarWalletConfig();
	// Graceful no-op for the poller when the wallet isn't set up yet.
	if (!cfg.configured) return json(res, 200, { configured: false, transfers: [] });

	const limit = clampInt(req.query?.limit, { max: 25, fallback: 10 });
	const connection = getConnection(cfg.rpcUrl);
	const owner = new PublicKey(cfg.address);

	const sigs = await connection.getSignaturesForAddress(owner, { limit });
	const ok = sigs.filter((s) => !s.err);
	if (!ok.length) {
		return json(res, 200, {
			configured: true,
			address: cfg.address,
			network: cfg.network,
			explorer: explorerAccountUrl(cfg.address, cfg.network),
			transfers: [],
		});
	}

	const [parsed, price] = await Promise.all([
		connection.getParsedTransactions(
			ok.map((s) => s.signature),
			{ maxSupportedTransactionVersion: 1 },
		),
		solUsdPrice().catch(() => null),
	]);

	const transfers = [];
	parsed.forEach((tx, i) => {
		const moved = settle(tx, cfg.address);
		if (!moved) return;
		transfers.push({
			signature: ok[i].signature,
			direction: moved.direction,
			sol: moved.sol,
			usd: price ? Number((moved.sol * price).toFixed(2)) : null,
			counterparty: moved.counterparty,
			memo: extractMemo(tx, ok[i].memo),
			blockTime: ok[i].blockTime ?? tx?.blockTime ?? null,
			explorer: explorerTxUrl(ok[i].signature, cfg.network),
		});
	});

	return json(
		res,
		200,
		{
			configured: true,
			address: cfg.address,
			network: cfg.network,
			explorer: explorerAccountUrl(cfg.address, cfg.network),
			price: price || null,
			transfers,
		},
		// Short cache so the feed feels live without hammering the RPC.
		{ 'Cache-Control': 'public, max-age=8' },
	);
});
