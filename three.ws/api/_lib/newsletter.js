// Shared helpers for the double opt-in newsletter (confirm + unsubscribe).
// Resend audience sync is best-effort — the DB row is the source of truth for
// who is subscribed; Resend is the delivery list we keep in step with it.

import { Resend } from 'resend';
import { captureException } from './sentry.js';

let _client = null;
function client() {
	if (!process.env.RESEND_API_KEY) return null;
	if (!_client) _client = new Resend(process.env.RESEND_API_KEY);
	return _client;
}

/** Add (or un-unsubscribe) a confirmed contact in the Resend audience. */
export async function addToAudience(email, locale) {
	const c = client();
	const audienceId = process.env.RESEND_AUDIENCE_ID;
	if (!c || !audienceId) return; // not configured — DB row still holds state
	try {
		await c.contacts.create({ email, audienceId, unsubscribed: false });
	} catch (err) {
		const msg = String(err?.message || '').toLowerCase();
		if (msg.includes('already') || msg.includes('exists')) return; // idempotent
		captureException(err, { email, where: 'newsletter-add-audience' });
	}
}

/** Flag a contact unsubscribed in the Resend audience. */
export async function removeFromAudience(email) {
	const c = client();
	const audienceId = process.env.RESEND_AUDIENCE_ID;
	if (!c || !audienceId) return;
	try {
		await c.contacts.update({ email, audienceId, unsubscribed: true });
	} catch (err) {
		captureException(err, { email, where: 'newsletter-remove-audience' });
	}
}

// A self-contained, branded result page — no page dependency, works even if the
// click lands before the SPA shell is cached. Matches the email template look.
export function resultPage({ heading, body, ctaLabel = 'Back to three.ws', ctaHref = '/' }) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(heading)} · three.ws</title>
<style>
  body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:#080814;color:#eee;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
  .card{max-width:460px;width:100%;background:#14141c;border:1px solid #2a2a36;border-radius:16px;padding:36px 32px;text-align:center}
  .brand{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6a5cff;margin:0 0 18px}
  h1{font-size:22px;margin:0 0 12px;letter-spacing:-.01em}
  p{color:#aaa;line-height:1.6;margin:0 0 24px;font-size:15px}
  .btn{display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#6a5cff,#ff5ca8);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px}
</style>
</head>
<body><div class="card">
  <p class="brand">three.ws</p>
  <h1>${esc(heading)}</h1>
  <p>${esc(body)}</p>
  <a class="btn" href="${esc(ctaHref)}">${esc(ctaLabel)}</a>
</div></body>
</html>`;
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
