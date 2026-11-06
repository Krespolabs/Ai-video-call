/**
 * Brain Studio — mount bootstrap (P1)
 * ===================================
 * The Agent Studio shell (P0) dispatches `studio-shell:ready` once it has loaded
 * the caller's agent through the shared store and rendered the tab panels. Each
 * sub-studio binds itself to its panel then. This module is P1's binding: it
 * mounts the Brain Studio into the shell's `[data-studio-mount="brain"]` panel.
 *
 * The agent-studio page loads this module alongside the shell:
 *   <script type="module" src="/src/studio/brain/brain-mount.js"></script>
 *
 * It is idempotent and order-independent — it handles both "event fires after we
 * subscribe" and "shell was already ready before this module evaluated".
 */

import { studio } from '../agent-studio-store.js';
import { mountBrainStudio } from './brain-studio.js';

const SELECTOR = '[data-studio-mount="brain"]';

function mount() {
	const panel = document.querySelector(SELECTOR);
	if (!panel || panel.dataset.brainMounted) return false;
	mountBrainStudio(panel, { studio });
	return true;
}

// Primary path: the shell tells us it's ready (store loaded, panels rendered).
document.addEventListener('studio-shell:ready', mount, { once: false });

// Fallback: the panel may already exist (event missed due to script ordering).
// Poll briefly for the panel; stop as soon as we mount or the shell renders a
// non-shell state (gate/error) where the panel never appears.
if (!mount()) {
	let tries = 0;
	const t = setInterval(() => {
		if (mount() || ++tries > 60) clearInterval(t); // ~6s ceiling
	}, 100);
}
