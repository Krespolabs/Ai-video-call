/**
 * Agent Wallet hub — Copilot tab (trading-frontier task 01).
 *
 * The Conversational Trading Copilot: the owner talks (text or voice) to the
 * agent and it answers with REAL live data and proposes guarded trades to
 * confirm. All logic lives in src/agent-copilot.js (reusable so agent-detail can
 * mount the same copilot); this tab is the thin wallet-hub wrapper that wires it
 * to the shared hub context (agent id, owner flag, network, toast).
 *
 * Owner-only: the copilot reads this wallet's positions and can place guarded
 * trades from it, so a visitor never sees it.
 */

import { registerWalletTab } from '../registry.js';
import { mountTradingCopilot } from '../../agent-copilot.js';

registerWalletTab({
	id: 'copilot',
	label: 'Copilot',
	order: 25, // sits beside Trade (30) — talk, or trade by hand
	ownerOnly: true,
	mount({ panel, ctx }) {
		let handle = null;
		let destroyed = false;

		// The copilot renders its own loading/streaming/error states internally. This
		// wrapper only guards the mount itself: if it throws (bad import, DOM error),
		// degrade to a designed, retryable card instead of a blank or broken panel.
		function boot() {
			try {
				handle = mountTradingCopilot({
					panel,
					agentId: ctx.agentId,
					agentName: ctx.agent?.name || 'Copilot',
					isOwner: ctx.isOwner,
					getNetwork: ctx.getNetwork,
					onNetworkChange: ctx.onNetworkChange,
					toast: ctx.toast,
				});
			} catch (err) {
				console.error('[agent-wallet-hub] copilot failed to mount', err);
				handle = null;
				panel.innerHTML = `<div class="awh-card"><p class="awh-empty" role="alert">The trading copilot couldn’t start. <button class="awh-btn" type="button" data-act="retry">Retry</button></p></div>`;
				panel.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
					if (!destroyed) boot();
				});
			}
		}

		boot();

		return {
			onShow() { handle?.onShow?.(); },
			onHide() { handle?.onHide?.(); },
			destroy() {
				destroyed = true;
				try { handle?.destroy?.(); } catch { /* teardown best-effort */ }
			},
		};
	},
});
