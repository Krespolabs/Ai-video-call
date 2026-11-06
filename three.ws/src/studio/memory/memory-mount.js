/**
 * Memory Studio — mount bootstrap (P2)
 * ====================================
 * Binds the Memory Studio to the Agent Studio shell's Memory tab on
 * `studio-shell:ready`. Mirrors P1's brain-mount: idempotent and
 * order-independent (handles both event-after-subscribe and already-ready).
 *
 * The agent-studio page loads this alongside the shell:
 *   <script type="module" src="/src/studio/memory/memory-mount.js"></script>
 */

import { studio } from '../agent-studio-store.js';
import { mountMemoryStudio } from './memory-studio.js';

const SELECTOR = '[data-studio-mount="memory"]';

function mount() {
	const panel = document.querySelector(SELECTOR);
	if (!panel || panel.dataset.memoryMounted) return false;
	mountMemoryStudio(panel, { studio });
	return true;
}

document.addEventListener('studio-shell:ready', mount, { once: false });

if (!mount()) {
	let tries = 0;
	const t = setInterval(() => {
		if (mount() || ++tries > 60) clearInterval(t); // ~6s ceiling
	}, 100);
}
