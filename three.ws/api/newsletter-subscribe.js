// POST /api/newsletter-subscribe — double opt-in newsletter signup.
//
// Step 1 of 2: record a `pending` subscriber + a confirm token, then email a
// confirmation link. The contact is NOT added to the Resend audience until the
// link is clicked (api/newsletter-confirm.js) — so we never mail someone who
// didn't prove ownership of the address, and a typo'd/hostile email can't be
// used to subscribe a third party.
//
// Always returns a generic success so the endpoint can't be used to probe which
// addresses are already subscribed.

import { z } from 'zod';
import { sql } from './_lib/db.js';
import { cors, json, method, wrap, readJson, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { randomToken } from './_lib/crypto.js';
import { sendNewsletterConfirmEmail } from './_lib/email.js';
import { captureException } from './_lib/sentry.js';

const APP_URL = process.env.APP_ORIGIN || process.env.PUBLIC_APP_ORIGIN || 'https://three.ws';

const bodySchema = z.object({
	email: z.string().trim().toLowerCase().email().max(254),
	locale: z.string().trim().max(10).optional(),
	source: z.string().trim().max(40).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.newsletterIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const { email, locale, source } = parse(bodySchema, await readJson(req));

	// Already confirmed → idempotent success, no second email.
	const [existing] = await sql`
		select status from newsletter_subscribers where email = ${email}
	`;
	if (existing?.status === 'confirmed') {
		return json(res, 200, { success: true, status: 'confirmed' });
	}

	// New or re-subscribing (pending/unsubscribed) → fresh token + confirm email.
	const token = randomToken(24);
	await sql`
		insert into newsletter_subscribers (email, status, confirm_token, locale, source)
		values (${email}, 'pending', ${token}, ${locale || null}, ${source || null})
		on conflict (email) do update set
			status        = 'pending',
			confirm_token = excluded.confirm_token,
			locale        = coalesce(excluded.locale, newsletter_subscribers.locale),
			source        = coalesce(excluded.source, newsletter_subscribers.source),
			unsubbed_at   = null
	`;

	const confirmUrl = `${APP_URL}/api/newsletter-confirm?token=${encodeURIComponent(token)}`;
	try {
		await sendNewsletterConfirmEmail({ to: email, confirmUrl, locale });
	} catch (err) {
		// Email transport failed — the row is saved, so a resend will reuse it.
		captureException(err, { email, where: 'newsletter-confirm-email' });
	}

	return json(res, 200, { success: true, status: 'pending' });
});
