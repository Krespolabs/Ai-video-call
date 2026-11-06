// GET /api/billing/invoices — the periodic invoice statement.
//
// Rolls the user's metered usage_events over a period into a statement they can
// read, download, and reconcile against their wallet/card. Every line item
// traces to a settlement ref. Defaults to the current calendar month; accepts an
// explicit window or a `period=YYYY-MM`.
//
//   ?period=2026-06            — a calendar month
//   ?from=ISO&to=ISO           — an explicit window
//   ?format=csv                — download the line items as CSV (printable PDF is
//                                produced client-side from the /account/billing page)
//
// Owner-scoped: a user only ever reads their own usage. Session or bearer auth.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, text, method, wrap, error, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { rollupInvoice, reconciliationStatus, atomicsToUsd } from '../_lib/metering.js';

// Resolve the billing window from the query. Returns { from, to, label }.
function resolveWindow(params) {
	const period = params.get('period');
	if (period && /^\d{4}-\d{2}$/.test(period)) {
		const [y, m] = period.split('-').map(Number);
		const from = new Date(Date.UTC(y, m - 1, 1));
		const to = new Date(Date.UTC(y, m, 1));
		return { from, to, label: period };
	}

	const fromRaw = params.get('from');
	const toRaw = params.get('to');
	if (fromRaw || toRaw) {
		const from = fromRaw ? new Date(fromRaw) : new Date(Date.UTC(1970, 0, 1));
		const to = toRaw ? new Date(toRaw) : new Date();
		if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
		return { from, to, label: 'custom' };
	}

	// Default: current calendar month (UTC).
	const now = new Date();
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	const label = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	return { from, to, label };
}

function toCsv(statement) {
	const head = 'action,label,count,units,gross_usd,fee_usd,discount_bps';
	const rows = statement.line_items.map(
		(l) =>
			`${l.action},"${String(l.label).replace(/"/g, '""')}",${l.count},${l.units},${l.gross_usd},${l.fee_usd},${l.discount_bps}`,
	);
	const total = `TOTAL,,${statement.totals.charge_count},,${statement.totals.gross_usd},${statement.totals.fee_usd},`;
	return [head, ...rows, total].join('\n') + '\n';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const window = resolveWindow(params);
	if (!window) return error(res, 400, 'validation_error', 'from/to must be valid ISO-8601 dates');

	const statement = await rollupInvoice({ userId, from: window.from, to: window.to });
	const recon = await reconciliationStatus({ userId });

	if (params.get('format') === 'csv') {
		return text(res, 200, toCsv(statement), {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="three-ws-invoice-${window.label}.csv"`,
			'cache-control': 'no-store',
		});
	}

	return json(
		res,
		200,
		{
			invoice: {
				period_label: window.label,
				period: statement.period,
				line_items: statement.line_items,
				totals: { ...statement.totals, net_usd: atomicsToUsd(statement.totals.net_atomics) },
				reconciliation: recon,
			},
		},
		{ 'cache-control': 'no-store' },
	);
});
