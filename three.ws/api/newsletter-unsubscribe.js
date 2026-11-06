// GET /api/newsletter-unsubscribe?token=... — honoured one-click unsubscribe.
//
// Every newsletter email carries this link (also wired to the List-Unsubscribe
// header via Resend). A valid token flips the subscriber to `unsubscribed`,
// flags them unsubscribed in the Resend audience, and confirms with a branded
// page. Idempotent: re-clicking shows the same confirmation.

import { sql } from './_lib/db.js';
import { cors, method, wrap, text, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { removeFromAudience, resultPage } from './_lib/newsletter.js';

function page(res, status, opts) {
	return text(res, status, resultPage(opts), { 'content-type': 'text/html; charset=utf-8' });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.newsletterConfirmIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const token = (new URL(req.url, 'http://x').searchParams.get('token') || '').trim();
	if (!token || token.length > 128) {
		return page(res, 400, {
			heading: 'Invalid link',
			body: 'This unsubscribe link is malformed.',
		});
	}

	const [sub] = await sql`
		select email, status from newsletter_subscribers where confirm_token = ${token}
	`;

	if (!sub) {
		return page(res, 200, {
			heading: 'Unsubscribed',
			body: "You won't receive the three.ws newsletter.",
		});
	}

	if (sub.status !== 'unsubscribed') {
		await sql`
			update newsletter_subscribers
			set status = 'unsubscribed', unsubbed_at = now()
			where confirm_token = ${token}
		`;
		await removeFromAudience(sub.email);
	}

	return page(res, 200, {
		heading: 'Unsubscribed',
		body: "You're off the three.ws newsletter. Changed your mind? You can subscribe again any time.",
	});
});
