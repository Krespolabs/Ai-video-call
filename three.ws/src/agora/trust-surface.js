// Agora — Task 07 trust-surface entry. A small, self-mounting layer that hangs
// the job-detail + verifier panel off the Commons WITHOUT reaching into the
// scaffold (agora-world.js) or the economy layer (economy-layer.js), both of
// which other tasks own and actively edit. It wires up purely through decoupled
// window events + URL deep-links:
//
//   • window 'agora:open-job'   {detail: <task opts>}  → open the job detail panel
//   • ?task=<pda>&cluster=…      on load                → deep-link a job detail
//
// The board (Task 06) dispatches 'agora:open-job' from its onSelectTask; the
// passport (this task) dispatches it from a completed-task's Verify chip. Either
// way the same accessible, focus-trapped panel opens with the real on-chain
// lifecycle + the in-browser deliverable verifier.

import { Panel } from './panel.js';
import { renderJobDetail } from './job-detail.js';
import { injectTrustSurfaceCss } from './trust-surface.css.js';

let _panel = null;
function jobPanel() {
	if (_panel) return _panel;
	injectTrustSurfaceCss();
	_panel = new Panel({
		id: 'agora-job-detail',
		onClose: () => clearDeepLink('task'),
	}).mount(document.body);
	return _panel;
}

// Normalize whatever the board/passport hands us into renderJobDetail's opts.
function toJobOpts(detail) {
	if (!detail) return {};
	// The board passes the raw task object; the passport passes explicit opts.
	const t = detail.task || detail;
	return {
		taskPda: t.taskPda || null,
		taskId: t.taskId || null,
		creator: t.creator || null,
		cluster: t.cluster || t.agenc?.cluster || 'devnet',
		title: t.title || t.narrative || (t.source === 'x402' ? (t.serviceName || 'Service') : 'Job'),
		profession: t.profession || null,
		reward: t.reward || null,
		proofHash: t.proofHash || null,
		deliverableUrl: t.deliverableUrl || null,
		txSignature: t.txSignature || null,
		source: t.source || null,
		resource: t.resource || null,
		description: t.description || null,
		opener: detail.opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null),
	};
}

function openJob(detail) {
	const opts = toJobOpts(detail);
	renderJobDetail(jobPanel(), opts, {}).catch((err) => {
		jobPanel().setError(`Couldn't open this job: ${err?.message || 'unknown error'}`);
	});
	setDeepLink('task', opts.taskPda, opts.cluster);
}

// ── URL deep-linking ──────────────────────────────────────────────────────────
function setDeepLink(key, value, cluster) {
	if (!value) return;
	try {
		const url = new URL(window.location.href);
		url.searchParams.set(key, value);
		if (cluster && cluster !== 'devnet') url.searchParams.set('cluster', cluster);
		window.history.replaceState(null, '', url);
	} catch { /* history blocked — non-fatal */ }
}

function clearDeepLink(key) {
	try {
		const url = new URL(window.location.href);
		url.searchParams.delete(key);
		window.history.replaceState(null, '', url);
	} catch { /* non-fatal */ }
}

function handleInitialDeepLink() {
	const params = new URLSearchParams(window.location.search);
	const task = params.get('task');
	if (task) {
		openJob({ task: { taskPda: task, cluster: params.get('cluster') || 'devnet' } });
	}
}

export function mountTrustSurface() {
	window.addEventListener('agora:open-job', (e) => openJob(e.detail));
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', handleInitialDeepLink, { once: true });
	} else {
		handleInitialDeepLink();
	}
}

mountTrustSurface();
