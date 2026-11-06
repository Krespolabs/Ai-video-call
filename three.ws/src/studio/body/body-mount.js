/**
 * Body Studio — mount bootstrap (P3)
 * ==================================
 * Binds the Body Studio to the Agent Studio shell's Body tab on
 * `studio-shell:ready`. Mirrors P1/P2 mounts: idempotent and order-independent
 * (handles both event-after-subscribe and already-ready).
 *
 * The agent-studio page loads this alongside the shell:
 *   <script type="module" src="/src/studio/body/body-mount.js"></script>
 */

import { studio } from '../agent-studio-store.js';
import { mountBodyStudio } from './body-studio.js';

const SELECTOR = '[data-studio-mount="body"]';

function mount() {
	const panel = document.querySelector(SELECTOR);
	if (!panel || panel.dataset.bodyMounted) return false;
	mountBodyStudio(panel, { studio });
	return true;
}

document.addEventListener('studio-shell:ready', mount, { once: false });

if (!mount()) {
	let tries = 0;
	const t = setInterval(() => {
		if (mount() || ++tries > 60) clearInterval(t); // ~6s ceiling
	}, 100);
}
