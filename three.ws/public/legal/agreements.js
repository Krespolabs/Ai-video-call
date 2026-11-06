// /legal/agreements: shows the visitor's real-funds signature status and history,
// and opens the signing dialog. Loaded as a plain module from public/ so it can
// import the canonical gate at /risk-ack.js in dev and production alike.

import { ensureRiskAck, hasRiskAck, AGREEMENT_DOCUMENTS, RISK_ACK_VERSION, RISK_ACK_ENDPOINT } from '/risk-ack.js';

const statusEl = document.getElementById('status');
const docsEl = document.getElementById('docs');
const historySection = document.getElementById('history-section');
const historyBody = document.getElementById('history');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => {
	try {
		return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	} catch {
		return iso;
	}
};

docsEl.innerHTML = AGREEMENT_DOCUMENTS.map(
	(d) => `<li><a href="${esc(d.path)}">${esc(d.title)}</a><span class="ver">Version ${d.version}</span></li>`,
).join('');

function renderStatus({ pill, tone, title, copy, actions }) {
	statusEl.setAttribute('aria-busy', 'false');
	statusEl.innerHTML = `
		<div class="status-head fade-in"><span class="pill" data-tone="${tone}">${esc(pill)}</span></div>
		<p class="status-title fade-in">${esc(title)}</p>
		<p class="status-copy fade-in">${copy}</p>
		<div class="actions fade-in">${actions}</div>`;
}

function renderHistory(rows) {
	if (!Array.isArray(rows) || rows.length === 0) {
		historySection.hidden = true;
		return;
	}
	historyBody.innerHTML = rows
		.map(
			(r) => `<tr>
				<td>${esc(fmtDate(r.signedAt))}</td>
				<td><em>${esc(r.signatureName)}</em></td>
				<td>${r.version}${r.current ? '' : ' <span class="muted">(superseded)</span>'}</td>
				<td class="muted">${esc(r.path || r.context || 'three.ws')}</td>
			</tr>`,
		)
		.join('');
	historySection.hidden = false;
}

async function load() {
	statusEl.setAttribute('aria-busy', 'true');
	let status;
	try {
		const res = await fetch(`${RISK_ACK_ENDPOINT}?history=1`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		status = await res.json();
	} catch {
		renderStatus({
			pill: 'Unavailable',
			tone: 'danger',
			title: 'We could not load your agreement status.',
			copy: 'Check your connection and try again. Your existing signatures are unaffected.',
			actions: '<button class="btn btn-primary" type="button" data-retry>Try again</button>',
		});
		statusEl.querySelector('[data-retry]').addEventListener('click', load);
		return;
	}

	renderHistory(status.history);
	const next = encodeURIComponent('/legal/agreements');

	if (!status.authenticated && hasRiskAck()) {
		renderStatus({
			pill: 'Signed in this browser',
			tone: 'ok',
			title: 'You signed the real-funds agreements in this browser.',
			copy: 'That covers this browser only. Sign in and your account will ask you to sign once more, so the signature is attached to your account for the app and the API.',
			actions: `<a class="btn btn-primary" href="/login?next=${next}">Sign in</a>`,
		});
	} else if (!status.authenticated) {
		renderStatus({
			pill: 'Not signed in',
			tone: 'warn',
			title: 'Sign in to attach your signature to your account.',
			copy: 'A signature made while signed in covers your account everywhere, including the API. You can also sign here without an account, for example before funding someone else’s agent; that signature covers this browser.',
			actions: `<a class="btn btn-primary" href="/login?next=${next}">Sign in</a><button class="btn" type="button" data-sign>Sign without an account</button>`,
		});
	} else if (status.signed) {
		renderStatus({
			pill: 'Signed',
			tone: 'ok',
			title: `Signed by ${status.signatureName || 'you'} on ${fmtDate(status.signedAt)}.`,
			copy: `Your account has signed version ${RISK_ACK_VERSION} of the real-funds agreements. Real-funds features are unlocked. If any document changes materially, you will be asked to sign again.`,
			actions: '<a class="btn" href="/dashboard">Go to dashboard</a>',
		});
	} else {
		renderStatus({
			pill: 'Signature required',
			tone: 'warn',
			title: 'Your account has not signed the current agreements.',
			copy: 'Until you sign, three.ws refuses real-funds actions from your account, in the app and through the API. Read each document, then sign once.',
			actions: '<button class="btn btn-primary" type="button" data-sign>Review and sign</button>',
		});
	}

	const signBtn = statusEl.querySelector('[data-sign]');
	if (signBtn) {
		signBtn.addEventListener('click', async () => {
			signBtn.disabled = true;
			const signed = await ensureRiskAck({ context: 'agreements-page', force: status.authenticated === true });
			signBtn.disabled = false;
			if (signed) load();
		});
	}
}

load();
