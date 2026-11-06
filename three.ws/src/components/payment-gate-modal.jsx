import { Modal } from '../shared/modal.js';
import { isUserRejection } from '../onchain/adapters/index.js';

/**
 * Show a blocking modal asking the caller to pay before a priced skill executes.
 *
 * Non-dismissible via backdrop/ESC while payment is in flight; the Cancel button
 * is the only exit path (it is disabled once the transaction starts).
 *
 * @param {{
 *   skill: string,
 *   amount: string,
 *   currencySymbol: string,
 *   chain: string,
 *   onPay: (opts: { setStatus: (msg: string) => void }) => Promise<string>,
 *   onCancel?: () => void,
 * }} opts
 * @returns {Promise<string>} Resolves with intentId. Rejects with code=PAYMENT_CANCELLED on cancel.
 */
export function showPaymentGateModal({ skill, amount, currencySymbol, chain, onPay, onCancel }) {
	return new Promise((resolve, reject) => {
		// ── Body content ──────────────────────────────────────────────────────────
		const bodyEl = document.createElement('div');
		bodyEl.className = 'pgm-body';

		const chainSpan = chain ? `<span class="pgm-chain"> on ${_esc(chain)}</span>` : '';
		bodyEl.innerHTML = `
			<p class="pgm-price">
				<strong>${_esc(skill)}</strong> costs
				<strong>${_esc(amount)} ${_esc(currencySymbol)}</strong>${chainSpan}.
			</p>
			<p class="pgm-status" role="status" aria-live="polite"></p>
		`;

		// ── Action buttons ────────────────────────────────────────────────────────
		const actionsEl = document.createElement('div');
		actionsEl.innerHTML = `
			<button class="pgm-cancel btn btn--secondary" type="button">Cancel</button>
			<button class="pgm-pay btn btn--primary" type="button">Pay</button>
		`;

		// ── Build modal ───────────────────────────────────────────────────────────
		const modal = new Modal({
			title: 'This skill requires payment',
			body: bodyEl,
			actions: actionsEl,
			dismissible: false,
		});

		const cancelBtn = modal.actionsEl.querySelector('.pgm-cancel');
		const payBtn    = modal.actionsEl.querySelector('.pgm-pay');
		const statusEl  = modal.bodyEl.querySelector('.pgm-status');

		function close() {
			modal.destroy();
		}

		cancelBtn.addEventListener('click', () => {
			close();
			onCancel?.();
			reject(Object.assign(new Error('Payment cancelled'), { code: 'PAYMENT_CANCELLED' }));
		});

		payBtn.addEventListener('click', async () => {
			payBtn.disabled = true;
			cancelBtn.disabled = true;
			statusEl.textContent = 'Processing…';
			try {
				const intentId = await onPay({ setStatus: (msg) => { statusEl.textContent = msg; } });
				close();
				resolve(intentId);
			} catch (err) {
				if (isUserRejection(err)) {
					statusEl.textContent = 'Payment declined in wallet. You can try again.';
				} else {
					statusEl.textContent = err.message || 'Payment failed.';
				}
				payBtn.disabled = false;
				cancelBtn.disabled = false;
			}
		});

		modal.open();
	});
}

function _esc(s) {
	return String(s ?? '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
	);
}
